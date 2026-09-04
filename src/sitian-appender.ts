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
  describeErrorIdentity,
  errorCodeOf,
  isProcessAlive,
} from "./error-identity.ts";
import {
  SitianInfrastructureError,
  type RecordPointer,
  type SitianRecord,
  type SitianRecordInput,
} from "./sitian-contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityClaimPath(recordFile: string, identity: string): string {
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
  return `${recordFile}.id-${digest}`;
}

function identityRecoveryPath(claimPath: string): string {
  return `${claimPath}.recovery`;
}

/** Claim body: holder pid + complete JSONL row (write-ahead for dead-winner recovery). */
function encodeIdentityClaim(row: string): string {
  return `${process.pid}\n${row}`;
}

type IdentityClaimBody = {
  readonly pid: number;
  readonly row: string;
};

/** Typed claim read: absent ≠ malformed ≠ unreadable (read-failure throws). */
type IdentityClaimRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "present"; readonly claim: IdentityClaimBody };

/** Typed recovery-holder read: absent ≠ malformed ≠ unreadable (read-failure throws). */
type RecoveryHolderRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "present"; readonly pid: number };

function parseIdentityClaim(contents: string): IdentityClaimBody | undefined {
  const nl = contents.indexOf('\n');
  if (nl <= 0) return undefined;
  const pidText = contents.slice(0, nl);
  if (!/^[1-9]\d*$/.test(pidText)) return undefined;
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const row = contents.slice(nl + 1);
  if (!row.endsWith('\n')) return undefined;
  try {
    JSON.parse(row.trimEnd());
  } catch {
    return undefined;
  }
  return { pid, row };
}

function readIdentityClaim(claimPath: string): IdentityClaimRead {
  let contents: string;
  try {
    contents = readFileSync(claimPath, 'utf8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return { kind: "absent" };
    throw new SitianInfrastructureError(
      `Sitian identity claim is unreadable at ${claimPath}: ${describeErrorIdentity(error)}; holder liveness unverifiable, claim left in place`,
      { cause: error },
    );
  }
  const claim = parseIdentityClaim(contents);
  if (claim === undefined) return { kind: "malformed" };
  return { kind: "present", claim };
}

/** Recovery token carries only a holder pid (no JSONL row). */
function readRecoveryHolderPid(recoveryPath: string): RecoveryHolderRead {
  let contents: string;
  try {
    contents = readFileSync(recoveryPath, 'utf8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return { kind: "absent" };
    throw new SitianInfrastructureError(
      `Sitian identity recovery token is unreadable at ${recoveryPath}: ${describeErrorIdentity(error)}; holder liveness unverifiable, token left in place`,
      { cause: error },
    );
  }
  const line = contents.split('\n', 1)[0] ?? '';
  if (!/^[1-9]\d*$/.test(line)) return { kind: "malformed" };
  const pid = Number.parseInt(line, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "malformed" };
  return { kind: "present", pid };
}

/**
 * Publish `contents` at `path` exactly once across processes.
 * Temp file + linkSync is the portable exclusive-create primitive: link fails
 * with EEXIST when the destination already exists (unlike rename, which
 * replaces an existing destination on POSIX).
 */
function publishExclusiveFile(path: string, contents: string): boolean {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (errorCodeOf(error) !== 'EEXIST') throw error;
    return false;
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    }
  }
}

function sealTornTail(recordFile: string): void {
  if (!existsSync(recordFile)) return;
  const buffer = readFileSync(recordFile);
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    appendFileSync(recordFile, '\n', 'utf8');
  }
}

function findIdentityPointer(
  recordFile: string,
  identity: string,
  kind: string,
  level: SitianRecord['level'],
): RecordPointer | undefined {
  if (!existsSync(recordFile)) return undefined;
  const text = readFileSync(recordFile, 'utf8');
  for (const line of text.split('\n')) {
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
    if (errorCodeOf(error) === 'ENOENT') return undefined;
    return error instanceof Error ? error : new Error(describeErrorIdentity(error));
  }
}

/**
 * Remove claim/recovery sidecars only after the canonical row is durably visible.
 * Non-ENOENT unlink failures are aggregated and thrown; the committed row stays.
 * Crash residue may remain while recovery still needs it.
 */
function releaseIdentityArtifactsAfterPublish(
  recordFile: string,
  identity: string,
  kind: string,
  level: SitianRecord['level'],
  claimPath: string,
): RecordPointer {
  sealTornTail(recordFile);
  const published = findIdentityPointer(recordFile, identity, kind, level);
  if (published === undefined) {
    throw new SitianInfrastructureError(
      `Sitian identity claim artifacts at ${claimPath} cannot be released: canonical row for identity ${identity} is not durably visible at ${recordFile}`,
    );
  }
  const failures: Error[] = [];
  for (const artifact of [identityRecoveryPath(claimPath), claimPath]) {
    const failure = unlinkAbsentOk(artifact);
    if (failure !== undefined) failures.push(failure);
  }
  if (failures.length === 1) {
    throw new SitianInfrastructureError(
      `Sitian identity claim artifacts at ${claimPath} could not be released after canonical row for identity ${identity} was committed at ${recordFile}: ${describeErrorIdentity(failures[0])}`,
      { cause: failures[0] },
    );
  }
  if (failures.length > 1) {
    throw new SitianInfrastructureError(
      `Sitian identity claim artifacts at ${claimPath} could not be released after canonical row for identity ${identity} was committed at ${recordFile}: ${failures.map(describeErrorIdentity).join('; ')}`,
      { cause: new AggregateError(failures, 'Sitian identity claim sidecar cleanup failures') },
    );
  }
  return published;
}

function publishIdentityRow(
  recordFile: string,
  identity: string,
  kind: string,
  level: SitianRecord['level'],
  row: string,
): RecordPointer {
  sealTornTail(recordFile);
  const existing = findIdentityPointer(recordFile, identity, kind, level);
  if (existing !== undefined) return existing;
  appendFileSync(recordFile, row, 'utf8');
  const published = findIdentityPointer(recordFile, identity, kind, level);
  if (published === undefined) {
    throw new SitianInfrastructureError(
      `Sitian identity row for ${identity} was written but is not durably visible at ${recordFile}`,
    );
  }
  return published;
}

/**
 * Contended claim: never wait on a live holder (typed live contention — callers
 * retry after publication). Materialize a dead unpublished claim from the
 * write-ahead row; fail closed on dead recovery residue. Absent ≠ malformed ≠
 * read-failure; races that observe true absence rescan the canonical row.
 * No pathname compare-and-unlink; no wall-clock wait.
 */
function resolveContendedIdentityClaim(
  recordFile: string,
  identity: string,
  kind: string,
  level: SitianRecord['level'],
  claimPath: string,
): RecordPointer {
  sealTornTail(recordFile);
  const found = findIdentityPointer(recordFile, identity, kind, level);
  if (found !== undefined) {
    return releaseIdentityArtifactsAfterPublish(
      recordFile,
      identity,
      kind,
      level,
      claimPath,
    );
  }

  const claimRead = readIdentityClaim(claimPath);
  if (claimRead.kind === 'absent') {
    sealTornTail(recordFile);
    const raced = findIdentityPointer(recordFile, identity, kind, level);
    if (raced !== undefined) return raced;
    throw new SitianInfrastructureError(
      `Sitian identity claim at ${claimPath} disappeared without a published canonical row for identity ${identity}; failing closed`,
    );
  }
  if (claimRead.kind === 'malformed') {
    throw new SitianInfrastructureError(
      `Sitian identity claim at ${claimPath} is malformed; refusing to treat as disappeared, claim left in place`,
    );
  }
  const claim = claimRead.claim;

  if (isProcessAlive(claim.pid)) {
    throw new SitianInfrastructureError(
      `Sitian identity claim at ${claimPath} is held by live pid ${claim.pid}; typed live contention — retry after the holder publishes`,
    );
  }

  const recoveryPath = identityRecoveryPath(claimPath);
  if (publishExclusiveFile(recoveryPath, `${process.pid}\n`)) {
    publishIdentityRow(recordFile, identity, kind, level, claim.row);
    return releaseIdentityArtifactsAfterPublish(
      recordFile,
      identity,
      kind,
      level,
      claimPath,
    );
  }

  sealTornTail(recordFile);
  const published = findIdentityPointer(recordFile, identity, kind, level);
  if (published !== undefined) {
    return releaseIdentityArtifactsAfterPublish(
      recordFile,
      identity,
      kind,
      level,
      claimPath,
    );
  }

  const recoveryRead = readRecoveryHolderPid(recoveryPath);
  if (recoveryRead.kind === 'absent') {
    sealTornTail(recordFile);
    const raced = findIdentityPointer(recordFile, identity, kind, level);
    if (raced !== undefined) {
      return releaseIdentityArtifactsAfterPublish(
        recordFile,
        identity,
        kind,
        level,
        claimPath,
      );
    }
    throw new SitianInfrastructureError(
      `Sitian identity recovery token at ${recoveryPath} disappeared without a published canonical row for identity ${identity}; failing closed`,
    );
  }
  if (recoveryRead.kind === 'malformed') {
    throw new SitianInfrastructureError(
      `Sitian identity recovery token at ${recoveryPath} is malformed; refusing to treat as disappeared, claim left in place`,
    );
  }
  if (isProcessAlive(recoveryRead.pid)) {
    throw new SitianInfrastructureError(
      `Sitian identity recovery token at ${recoveryPath} is held by live pid ${recoveryRead.pid}; typed live contention — retry after the holder publishes`,
    );
  }

  throw new SitianInfrastructureError(
    `Sitian identity claim stayed unpublished at ${claimPath} after dead holder pid ${claim.pid}; recovery residue at ${recoveryPath} is not safely reclaimable without pathname compare-and-unlink, claim left in place`,
  );
}

/**
 * Same-identity uniqueness without a crash-reclaimable pathname volume lock.
 *
 * Exclusive identity claim (linkSync) stores the complete JSONL row and the
 * claim holder's pid — uniqueness commit plus write-ahead data so dead-winner
 * recovery does not depend on lost append bytes. The winner appends that row,
 * then removes claim/recovery only after the canonical row is durably visible.
 * A live EEXIST holder fails immediately as typed live contention (uniqueness
 * forbids duplicate rows; it does not require every concurrent caller to
 * succeed). Dead unpublished claims recover from write-ahead once. Contested
 * dead recovery fails closed. Crash residue may remain only while needed for
 * recovery. No wait loop; no pathname compare-and-unlink reclaim (#629).
 */
function appendWithIdentityClaim(
  recordFile: string,
  record: SitianRecord,
  row: string,
): RecordPointer {
  sealTornTail(recordFile);
  const claimPath = identityClaimPath(recordFile, record.identity);
  const existing = findIdentityPointer(recordFile, record.identity, record.kind, record.level);
  if (existing !== undefined) {
    // Canonical row already visible — leftover crash sidecars are no longer needed.
    return releaseIdentityArtifactsAfterPublish(
      recordFile,
      record.identity,
      record.kind,
      record.level,
      claimPath,
    );
  }

  const acquired = publishExclusiveFile(claimPath, encodeIdentityClaim(row));
  if (!acquired) {
    return resolveContendedIdentityClaim(
      recordFile,
      record.identity,
      record.kind,
      record.level,
      claimPath,
    );
  }

  publishIdentityRow(
    recordFile,
    record.identity,
    record.kind,
    record.level,
    row,
  );
  return releaseIdentityArtifactsAfterPublish(
    recordFile,
    record.identity,
    record.kind,
    record.level,
    claimPath,
  );
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
