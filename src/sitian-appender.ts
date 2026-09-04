/**
 * Sitian Appender kernel (ADR 0065).
 * Computes destination automatically from ledger topology without destination parameters.
 * Owns volume open, torn-tail recovery, entry-level idempotency, and commit boundary.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  errorText,
  physicallyContainedIn,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import {
  SitianInfrastructureError,
  type RecordPointer,
  type SitianRecord,
  type SitianRecordInput,
} from "./sitian-contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IDENTITY_CLAIM_WAIT_MS = 10;
const identityWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function errorCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

function identityClaimPath(recordFile: string, identity: string): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `${recordFile}.id-${digest}`;
}

/**
 * Publish `contents` at `path` exactly once across processes.
 * Temp file + linkSync is the portable exclusive-create primitive: link fails
 * with EEXIST when the destination already exists (unlike rename, which
 * replaces an existing destination on POSIX).
 */
function publishExclusiveFile(path: string, contents: string): boolean {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, "utf8");
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (errorCodeOf(error) !== "EEXIST") throw error;
    return false;
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (errorCodeOf(error) !== "ENOENT") throw error;
    }
  }
}

function sealTornTail(recordFile: string): void {
  if (!existsSync(recordFile)) return;
  const buffer = readFileSync(recordFile);
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    appendFileSync(recordFile, "\n", "utf8");
  }
}

function findIdentityPointer(
  recordFile: string,
  identity: string,
  kind: string,
  level: SitianRecord["level"],
): RecordPointer | undefined {
  if (!existsSync(recordFile)) return undefined;
  const text = readFileSync(recordFile, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.identity === identity) {
        return { identity, recordFile, kind, level };
      }
    } catch {
      // Malformed lines (including substate b preserved bad lines) are ignored during self-check
    }
  }
  return undefined;
}

function waitForIdentityPointer(
  recordFile: string,
  identity: string,
  kind: string,
  level: SitianRecord["level"],
): RecordPointer {
  for (;;) {
    sealTornTail(recordFile);
    const found = findIdentityPointer(recordFile, identity, kind, level);
    if (found !== undefined) return found;
    Atomics.wait(identityWaitBuffer, 0, 0, IDENTITY_CLAIM_WAIT_MS);
  }
}

/**
 * Same-identity uniqueness without a crash-reclaimable pathname volume lock.
 *
 * Exclusive identity claim (linkSync) is the commit of uniqueness. The claim
 * winner seals torn tails and appends the JSONL row. Losers wait until that
 * row is visible. Concurrent same-identity writers therefore converge on one
 * volume row without ever unlinking a contended lock pathname.
 *
 * A crash after claim creation and before append can leave that identity
 * unpublished in JSONL; that residue is identity-scoped and does not block
 * other identities. POSIX offers no safe compare-and-unlink reclaim for it
 * without substantial new machinery — we do not accumulate an unsafe one.
 */
function appendWithIdentityClaim(
  recordFile: string,
  record: SitianRecord,
  row: string,
): RecordPointer {
  sealTornTail(recordFile);
  const existing = findIdentityPointer(recordFile, record.identity, record.kind, record.level);
  if (existing !== undefined) return existing;

  const claimPath = identityClaimPath(recordFile, record.identity);
  const acquired = publishExclusiveFile(claimPath, row);
  if (!acquired) {
    return waitForIdentityPointer(recordFile, record.identity, record.kind, record.level);
  }

  sealTornTail(recordFile);
  const raced = findIdentityPointer(recordFile, record.identity, record.kind, record.level);
  if (raced !== undefined) return raced;
  appendFileSync(recordFile, row, "utf8");
  return {
    identity: record.identity,
    recordFile,
    kind: record.kind,
    level: record.level,
  };
}

/** Authorized S4 submission ledger kinds that share a common run submission volume. */
export const S4_SUBMISSION_LEDGER_KINDS = new Set([
  "candidate",
  "roundContext",
  "outcome",
  "sealed",
  "post-seal-anomaly",
]);

/** Compute the volume partition key for directory placement. */
export function resolveSitianVolumeCategory(kind: string): string {
  if (S4_SUBMISSION_LEDGER_KINDS.has(kind)) {
    return "submission-ledger";
  }
  return kind;
}

function safeBookKey(cwd: string): string {
  try {
    return resolveBookKeyFromGit(cwd);
  } catch {
    return basename(resolve(cwd)) || "default";
  }
}

type SitianRecordPath = {
  readonly sessionDir: string;
  readonly recordFile: string;
  readonly ledgerHome: string;
};

/** Pure topology owner shared by ambient writes and explicit-home submission reads. */
export function resolveSitianRecordPathInLedger(
  input: SitianRecordInput,
  ledgerHome: string,
): SitianRecordPath {
  const cwd = input.cwd ?? process.cwd();
  const category = resolveSitianVolumeCategory(input.kind);

  let sessionDir: string;

  if (input.sessionParent !== undefined && input.sessionParent.length > 0 && physicallyContainedIn(ledgerHome, input.sessionParent)) {
    sessionDir = join(dirname(input.sessionParent), category);
  } else {
    const bookKey = safeBookKey(cwd);
    const bookDir = activationBookDirectory(ledgerHome, bookKey);
    if (input.subject !== undefined) {
      let subjectStr: string;
      if (typeof input.subject === "string") {
        subjectStr = input.subject;
      } else if (typeof input.subject.runId === "string" && input.subject.runId.length > 0) {
        subjectStr = input.subject.runId;
      } else {
        subjectStr = JSON.stringify(input.subject);
      }
      const digest = createHash("sha256").update(subjectStr).digest("hex").slice(0, 32);
      sessionDir = join(bookDir, category, digest);
    } else {
      sessionDir = join(bookDir, category);
    }
  }

  const recordFile = join(sessionDir, "records.jsonl");
  return { sessionDir, recordFile, ledgerHome };
}

/** Compute a write destination from ambient ledger topology (ADR 0065). */
export function resolveSitianRecordPath(input: SitianRecordInput): SitianRecordPath {
  const ledgerHome =
    input.home !== undefined && input.home.length > 0
      ? resolveActivationLedgerHome(input.home)
      : resolveActivationLedgerHomeForPath(input.sessionParent);
  return resolveSitianRecordPathInLedger(input, ledgerHome);
}

/**
 * Appends a canonical record to its self-computed volume under the Sitian contract.
 * - Idempotency: checks volume by deterministic canonical identity; returns existing pointer on hit.
 * - Torn-tail recovery: checks file tail; un-terminated trailing bytes are sealed with a newline and re-parsed.
 *   Substate a (valid JSON): committed on recovery, returns existing pointer.
 *   Substate b (malformed): preserved as bad line, check misses, appends new row.
 * - Commit point: full JSON string ending with newline.
 */
export function appendSitianRecord(input: SitianRecordInput): RecordPointer {
  try {
    const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
    ensureRealDirectoryTree(ledgerHome, sessionDir);

    const identity = input.identity ?? randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();
    const host = input.host ?? "pi";

    const record: SitianRecord = {
      level: input.level,
      kind: input.kind,
      identity,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.sessionParent === undefined ? {} : { sessionParent: input.sessionParent }),
      ...(input.priorEventId === undefined ? {} : { priorEventId: input.priorEventId }),
      timestamp,
      host,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    };

    const row = `${JSON.stringify(record)}\n`;
    return appendWithIdentityClaim(recordFile, record, row);
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}
