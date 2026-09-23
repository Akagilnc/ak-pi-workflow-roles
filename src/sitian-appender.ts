/**
 * Sitian Appender kernel (ADR 0065).
 * Computes destination automatically from ledger topology without destination parameters.
 * Owns volume open, torn-tail recovery, entry-level idempotency, and commit boundary.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

function errorCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

function identityClaimPath(recordFile: string, identity: string): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `${recordFile}.id-${digest}`;
}

/**
 * Exclusive create at `path` exactly once across processes.
 * Reuses the package's existing `wx` / O_EXCL zero-content occupancy primitive
 * (same shape as activation-ledger-session / archivist-record-entry).
 */
function createExclusiveFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
}

function sealTornTail(recordFile: string): void {
  if (!existsSync(recordFile)) return;
  const buffer = readFileSync(recordFile);
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    appendFileSync(recordFile, "\n", "utf8");
  }
}

/** Assign an already-recorded volume without changing any of its rows. */
export function appendSitianRecordBlock(input: SitianRecordInput, block: string, sourceRunDirectory: string): void {
  if (block === "") return;
  try {
    const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
    ensureRealDirectoryTree(ledgerHome, sessionDir);
    appendFileSync(recordFile, "", "utf8");
    const marker = `${recordFile}.block-${createHash("sha256").update(sourceRunDirectory).digest("hex")}`;
    const bytes = Buffer.from(block, "utf8");
    if (existsSync(marker)) {
      const offset = Number(readFileSync(marker, "utf8"));
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error(`Invalid Sitian block offset in ${marker}`);
      }
      const remaining = statSync(recordFile).size - offset;
      if (remaining < 0) {
        throw new Error(`Sitian block at ${marker} changed after append`);
      }
      const compared = Math.min(remaining, bytes.length);
      const actual = Buffer.alloc(compared);
      const fd = openSync(recordFile, "r");
      try {
        if (readSync(fd, actual, 0, actual.length, offset) !== compared || !bytes.subarray(0, compared).equals(actual)) {
          throw new Error(`Sitian block at ${marker} does not match its source`);
        }
      } finally {
        closeSync(fd);
      }
      if (remaining >= bytes.length) return;
      truncateSync(recordFile, offset);
      appendFileSync(recordFile, bytes);
      return;
    }
    sealTornTail(recordFile);
    const offset = statSync(recordFile).size;
    writeFileSync(marker, String(offset), "utf8");
    appendFileSync(recordFile, bytes);
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(error)}`,
      { cause: error },
    );
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

function unlinkAbsentOk(path: string): Error | undefined {
  try {
    unlinkSync(path);
    return undefined;
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return undefined;
    return error instanceof Error ? error : new Error(errorText(error));
  }
}

/**
 * Same-identity uniqueness under normal concurrent writers.
 *
 * Exclusive per-identity claim (`wx`) makes check+append atomic for one
 * identity. The winner appends under the claim and always releases it on both
 * normal and throwing exits. A loser that already sees the published row
 * returns that pointer; a loser that hits claim EEXIST without a published row
 * fails as SitianInfrastructureError (knownCause session). Crash residue can
 * leave that one identity blocked — identity-scoped, never a volume lock. No
 * wait loop, write-ahead recovery, PID reclaim, or compare-and-unlink.
 */
function appendWithIdentityClaim(
  recordFile: string,
  record: SitianRecord,
  row: string,
): RecordPointer {
  sealTornTail(recordFile);
  const claimPath = identityClaimPath(recordFile, record.identity);
  const existing = findIdentityPointer(
    recordFile,
    record.identity,
    record.kind,
    record.level,
  );
  if (existing !== undefined) {
    // Best-effort: drop leftover claim after a prior crash-after-append.
    unlinkAbsentOk(claimPath);
    return existing;
  }

  try {
    createExclusiveFile(claimPath, "");
  } catch (error) {
    if (errorCodeOf(error) !== "EEXIST") throw error;
    sealTornTail(recordFile);
    const published = findIdentityPointer(
      recordFile,
      record.identity,
      record.kind,
      record.level,
    );
    if (published !== undefined) {
      unlinkAbsentOk(claimPath);
      return published;
    }
    throw new SitianInfrastructureError(
      `Sitian identity claim at ${claimPath} already exists for identity ${record.identity}`,
      { cause: error },
    );
  }

  let primaryFailure: unknown;
  let result: RecordPointer | undefined;
  let cleanupFailure: Error | undefined;
  try {
    sealTornTail(recordFile);
    const raced = findIdentityPointer(
      recordFile,
      record.identity,
      record.kind,
      record.level,
    );
    if (raced !== undefined) {
      result = raced;
    } else {
      appendFileSync(recordFile, row, "utf8");
      result = {
        identity: record.identity,
        recordFile,
        kind: record.kind,
        level: record.level,
      };
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    cleanupFailure = unlinkAbsentOk(claimPath);
  }

  if (primaryFailure !== undefined) {
    if (primaryFailure instanceof SitianInfrastructureError) throw primaryFailure;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(primaryFailure)}`,
      { cause: primaryFailure },
    );
  }
  if (cleanupFailure !== undefined) {
    throw new SitianInfrastructureError(
      `Sitian identity claim at ${claimPath} could not be released after append for identity ${record.identity}: ${errorText(cleanupFailure)}`,
      { cause: cleanupFailure },
    );
  }
  return result as RecordPointer;
}

/** Authorized S4 submission ledger kinds that share a common run submission volume. */
export const S4_SUBMISSION_LEDGER_KINDS = new Set([
  "candidate",
  "roundContext",
  "outcome",
  "sealed",
  "post-seal-anomaly"
]);

/** Compute the volume partition key for directory placement. */
export function resolveSitianVolumeCategory(kind: string): string {
  if (S4_SUBMISSION_LEDGER_KINDS.has(kind)) {
    return "submission-ledger";
  }
  return kind;
}

type SitianRecordPath = {
  readonly sessionDir: string;
  readonly recordFile: string;
  readonly ledgerHome: string;
};

/** Sole records leaf under every sitian volume directory. */
const SITIAN_RECORDS_LEAF = "records.jsonl" as const;

/**
 * Ticket-provenance under-book paths (docs/dossier-topology.md sole authority).
 * Writer ticket branch and owner-visible shape share this join — one code path.
 */
function ticketProvenanceUnderBookPaths(
  ledgerHome: string,
  bookKey: string,
  ticketId: string,
): { sessionDir: string; recordFile: string } {
  const sessionDir = join(activationBookDirectory(ledgerHome, bookKey), ticketId);
  return { sessionDir, recordFile: join(sessionDir, SITIAN_RECORDS_LEAF) };
}

/** Pure topology owner shared by ambient writes and explicit-home submission reads. */
export function resolveSitianRecordPathInLedger(
  input: SitianRecordInput,
  ledgerHome: string,
): SitianRecordPath {
  const category = resolveSitianVolumeCategory(input.kind);
  const ticketNumber = category === "ticket-provenance"
    ? typeof input.subject === "string" && /^[1-9][0-9]*$/.test(input.subject)
      ? input.subject
      : typeof input.subject === "object"
        && typeof input.subject.ticketNumber === "number"
        && Number.isSafeInteger(input.subject.ticketNumber)
        && input.subject.ticketNumber > 0
        ? String(input.subject.ticketNumber)
        : undefined
    : undefined;

  let sessionDir: string;
  let recordFile: string;
  if (ticketNumber !== undefined) {
    // docs/dossier-topology.md: ticket dir holds the unique records.jsonl directly (#900).
    const paths = ticketProvenanceUnderBookPaths(
      ledgerHome,
      resolveBookKeyFromGit(input.cwd ?? process.cwd()),
      ticketNumber,
    );
    sessionDir = paths.sessionDir;
    recordFile = paths.recordFile;
  } else if (category === "ticket-provenance" && input.runDirectory !== undefined) {
    sessionDir = input.runDirectory;
    recordFile = join(sessionDir, SITIAN_RECORDS_LEAF);
  } else {
    if (
      input.sessionParent === undefined
      || input.sessionParent.length === 0
      || !physicallyContainedIn(ledgerHome, input.sessionParent)
    ) {
      throw new Error("Sitian record ownership requires a parent session inside the ledger home");
    }
    sessionDir = join(dirname(input.sessionParent), category);
    recordFile = join(sessionDir, SITIAN_RECORDS_LEAF);
  }
  if (!physicallyContainedIn(ledgerHome, sessionDir)) {
    throw new Error("Sitian record ownership requires a directory inside the ledger home");
  }

  return { sessionDir, recordFile, ledgerHome };
}

/**
 * Owner-visible ticket 起居录 path shape via the writer ticket joins
 * (ticketProvenanceUnderBookPaths). Ledger leaf is the package-owned `.ak-roles`
 * name (ADR 0048); variable slots keep owner labels; no fake-home path reverse.
 */
export function projectTicketRecordsPathShape(): string {
  const { recordFile } = ticketProvenanceUnderBookPaths(
    join("~", ".ak-roles"),
    "<簿>",
    "<票号>",
  );
  return recordFile.replace(/\\/g, "/");
}

/** Compute a write destination from ambient ledger topology (ADR 0065). */
export function resolveSitianRecordPath(input: SitianRecordInput): SitianRecordPath {
  const ledgerHome =
    input.home !== undefined && input.home.length > 0
      ? resolveActivationLedgerHome(input.home)
      : resolveActivationLedgerHomeForPath(input.runDirectory ?? input.sessionParent);
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
