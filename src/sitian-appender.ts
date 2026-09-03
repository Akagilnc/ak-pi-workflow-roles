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

const SITIAN_VOLUME_LOCK_TIMEOUT_MS = 30_000;
const SITIAN_VOLUME_LOCK_RETRY_MS = 10;
const syncSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Serialize one volume's recovery + identity check + append across processes. */
function withSitianVolumeLock<T>(recordFile: string, action: () => T): T {
  const lockFile = `${recordFile}.lock`;
  const startedAt = Date.now();
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - startedAt > SITIAN_VOLUME_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Sitian volume lock timeout after ${SITIAN_VOLUME_LOCK_TIMEOUT_MS}ms: ${lockFile}`,
        );
      }
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
