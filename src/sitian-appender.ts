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

const SITIAN_VOLUME_LOCK_RETRY_MS = 10;
const syncSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function errorCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** True error identity — name/code/message as-is, never a guessed label. */
function describeErrorIdentity(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const name =
    typeof candidate?.name === "string" && candidate.name !== ""
      ? candidate.name
      : typeof error;
  const code =
    typeof candidate?.code === "string" || typeof candidate?.code === "number"
      ? ` code=${String(candidate.code)}`
      : "";
  const message =
    typeof candidate?.message === "string" && candidate.message !== ""
      ? `: ${candidate.message}`
      : "";
  return `${name}${code}${message}`;
}

/**
 * Signal-0 liveness probe. Only ESRCH proves absence; any other refusal
 * (e.g. EPERM) means the holder process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) !== "ESRCH";
  }
}

type SitianVolumeLockAutopsy =
  | { verdict: "absent"; readFailure?: unknown }
  | { verdict: "dead"; pid: number }
  | { verdict: "alive"; pid: number };

/**
 * Holder autopsy for an existing volume lock. "absent" covers no file, no
 * parseable pid (live creator mid-acquisition, or crash-window leftover), and
 * unreadable files — absent alone never authorizes reclaim; only "dead" does.
 */
function autopsySitianVolumeLock(lockFile: string): SitianVolumeLockAutopsy {
  let content: string;
  try {
    content = readFileSync(lockFile, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { verdict: "absent" };
    return { verdict: "absent", readFailure: error };
  }
  const normalized = content.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return { verdict: "absent" };
  const pid = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { verdict: "absent" };
  return isProcessAlive(pid) ? { verdict: "alive", pid } : { verdict: "dead", pid };
}

/**
 * Remove one lock whose re-read autopsy is still a verified-dead holder, or
 * leave it otherwise. The pre-unlink re-read means a contender that re-locked
 * between the first autopsy and the unlink cannot have its live lock stolen.
 */
function reclaimDeadSitianVolumeLock(lockFile: string): boolean {
  const current = autopsySitianVolumeLock(lockFile);
  if (current.verdict !== "dead") return false;
  try {
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Serialize one volume's recovery + identity check + append across processes.
 *
 * Contested lock: live holder → wait (no wall-clock ceiling, no steal);
 * verified-dead holder → reclaim and retry create; absent/unparseable → wait
 * for mid-acquisition to finish (absent alone never authorizes reclaim).
 * Unreadable lock fails with the true read identity — cause is not laundered
 * into a timeout.
 */
function withSitianVolumeLock<T>(recordFile: string, action: () => T): T {
  const lockFile = `${recordFile}.lock`;
  let descriptor: number;
  while (true) {
    try {
      descriptor = openSync(lockFile, "wx");
      try {
        writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      } catch (error) {
        try { closeSync(descriptor); } finally { unlinkSync(lockFile); }
        throw error;
      }
      break;
    } catch (error) {
      if (errorCodeOf(error) !== "EEXIST") throw error;
      const autopsy = autopsySitianVolumeLock(lockFile);
      if (autopsy.verdict === "absent" && autopsy.readFailure !== undefined) {
        throw new Error(
          `Sitian volume lock is unreadable at ${lockFile}: ${describeErrorIdentity(autopsy.readFailure)}; holder liveness unverifiable, lock left in place`,
          { cause: autopsy.readFailure },
        );
      }
      if (autopsy.verdict === "dead") {
        try {
          reclaimDeadSitianVolumeLock(lockFile);
        } catch (reclaimError) {
          throw new Error(
            `Sitian volume lock reclaim failed at ${lockFile} (dead pid ${autopsy.pid}): ${describeErrorIdentity(reclaimError)}`,
            { cause: reclaimError },
          );
        }
        continue;
      }
      // live contention, or absent mid-acquisition: wait and retry create.
      Atomics.wait(syncSleepBuffer, 0, 0, SITIAN_VOLUME_LOCK_RETRY_MS);
    }
  }

  let result: T | undefined;
  let primaryFailure: unknown;
  try {
    result = action();
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupFailures: unknown[] = [];
  try {
    closeSync(descriptor!);
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    unlinkSync(lockFile);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Sitian volume operation and lock cleanup failed",
      { cause: primaryFailure },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, "Sitian volume lock cleanup failed", {
      cause: cleanupFailures[0],
    });
  }
  return result as T;
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

    return withSitianVolumeLock(recordFile, () => {
      if (existsSync(recordFile)) {
        const buffer = readFileSync(recordFile);
        if (buffer.length > 0) {
          // Torn-tail check: if last byte is not newline, seal the fragment with \n
          if (buffer[buffer.length - 1] !== 0x0a) {
            appendFileSync(recordFile, "\n", "utf8");
          }

          // Self-check volume by canonical identity while holding the same lock as append.
          const text = readFileSync(recordFile, "utf8");
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (isRecord(parsed) && parsed.identity === identity) {
                return {
                  identity,
                  recordFile,
                  kind: record.kind,
                  level: record.level,
                };
              }
            } catch {
              // Malformed lines (including substate b preserved bad lines) are ignored during self-check
            }
          }
        }
      }

      // Not found -> append new canonical row terminating with newline.
      const row = `${JSON.stringify(record)}\n`;
      appendFileSync(recordFile, row, "utf8");

      return {
        identity,
        recordFile,
        kind: record.kind,
        level: record.level,
      };
    });
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}
