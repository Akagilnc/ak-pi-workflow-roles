/**
 * Single generic auto-resume loop for #416 (owner scope = single LLM call).
 * Call-local retries, at most the effective autoResumeLimit times (injected once
 * per call by the caller, #422 — never re-read from disk inside the loop),
 * in-place (same runId/session).
 * Unifies presentation: intermediate attempts use dummyIo, only final Terminal is presented.
 *
 * Owner 2026-08-23: a dispatch that exits by throwing used to bypass the entire
 * retry mechanism (the throw escaped the while-loop before the count check ever
 * ran). Every exception is now retained whole, in place, and the ordinary retry
 * path continues: same budget, same call-local count semantics. No failure-type
 * classification — every thrown value is treated identically.
 */
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AUTO_RESUME_LIMIT,
  describeErrorIdentity,
  isSessionPrincipalAvailable,
  acquireRunWriterLease,
  markRunTerminal,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import { parseAutoResumeLimit } from "./config.ts";
import { isLawfulTypedTerminalOutcome, formatTerminalResult, type TerminalArtifactRef, type TerminalResult, type TerminalRoleName } from "./terminal.ts";
import { presentFailureTerminal, presentStructuralRejection } from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";

const dummyIo: CliIo = { stdout: () => {}, stderr: () => {} };

function presentTerminal(terminal: TerminalResult, io: CliIo): void {
  if (terminal.roleOutcome.kind === "failure" || terminal.roleOutcome.kind === "no_receipt") {
    presentFailureTerminal(terminal, io);
  } else {
    io.stdout(formatTerminalResult(terminal));
  }
}

/**
 * Best-effort finalization of the durable run state before an exception-path
 * synthetic failure terminal is returned (#426 review: taishi-ledger classifies
 * running runs as live — an exhausted invocation must not remain live
 * indefinitely). Finalization failure must not mask the real cause.
 */
async function finalizeExceptionRunBestEffort(runDirectory: string, io: CliIo): Promise<void> {
  try {
    await markRunTerminal(runDirectory);
  } catch (error) {
    io.stderr(
      `run terminal-state finalization failed (best-effort continue): ${describeErrorIdentity(error)}\n`,
    );
  }
}

export type AutoResumeDispatchResult = {
  exitCode: number;
  terminal?: TerminalResult;
};

/** Session custom-entry type carrying the pointer to one dispatch error file. */
export const DISPATCH_ERROR_RETENTION_ENTRY_TYPE = "ak_run_dispatch_error_retention" as const;

/** Artifacts subdirectory of a run directory (established run-artifacts location). */
function runArtifactsDirectory(runDirectory: string): string {
  return join(runDirectory, "artifacts");
}

/**
 * #182-A hardened path identity, mirrored from settlement.ts's
 * ensureAuditEvidenceDirectory: a planted symlink at the run directory or the
 * artifacts path must not receive the dispatch error dump (O_NOFOLLOW only
 * protects the final file name; recursive mkdir would accept a symlinked
 * parent). Fails loudly with the true cause instead.
 */
async function ensureRealArtifactsDirectory(runDirectory: string): Promise<string> {
  const runStat = await lstat(runDirectory);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new Error("dispatch error retention: run directory is not a real directory");
  }
  const artifactsDir = runArtifactsDirectory(runDirectory);
  try {
    const existing = await lstat(artifactsDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("dispatch error retention: artifacts path is not a real directory");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(artifactsDir, { recursive: true });
    const created = await lstat(artifactsDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("dispatch error retention: artifacts directory is not a real directory");
    }
  }
  return artifactsDir;
}

/**
 * Whole-object transfer of a thrown value (owner 2026-08-23: 「记录所有错误信息。
 * 不能丢详细情况」). Every own property of the Error object — enumerable or not,
 * which is how message/stack and any attached identity land verbatim — plus the
 * constructor name and the full cause chain. No field list is prescribed or
 * filtered: whatever the exception object carries goes into the file as-is.
 */
function serializeThrownValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const transferred: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      transferred[key] = transferNestedValue(
        (value as unknown as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
    return {
      errorKind: "Error",
      constructorName: value.constructor?.name,
      ...transferred,
      ...(value.cause === undefined
        ? {}
        : {
            causeChain:
              depth >= 10
                ? "[cause-chain-depth-limit]"
                : serializeThrownValue(value.cause, depth + 1, seen),
          }),
    };
  }
  return value;
}

/** ENOENT identity shared with settlement.ts's hardened audit-artifact path. */
function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Recursive Error-property transfer (#426 review: nested Errors must not be
 * passed raw to JSON.stringify — their non-enumerable message/stack would
 * serialize as {}). Depth-limited; cycle-safe via the seen set so the recursive
 * construction itself cannot diverge before stringify runs.
 */
function transferNestedValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error) return serializeThrownValue(value, depth, seen);
  if (depth >= 10) return "[nested-depth-limit]";
  if (Array.isArray(value)) {
    return value.map((item) => transferNestedValue(item, depth + 1, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const transferred: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      transferred[key] = transferNestedValue(
        (value as unknown as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
    return transferred;
  }
  return value;
}

/** Cycle- and bigint-safe JSON replacer so serialization itself cannot drop data. */
function jsonSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  };
}

/**
 * Retain one throwing dispatch attempt's complete exception as an independent
 * per-attempt file under the run's artifacts directory, then leave an
 * addressable pointer in the session principal (custom entry). Exclusive-create
 * open (O_EXCL) with a per-attempt unique name enforces 史必追加 (#419): a later
 * attempt can never overwrite an earlier attempt's file.
 */
async function retainDispatchError(
  admitted: { sessionFile: string; runDirectory: string },
  attempt: number,
  error: unknown,
): Promise<string> {
  const artifactsDir = await ensureRealArtifactsDirectory(admitted.runDirectory);
  const filePath = join(
    artifactsDir,
    `dispatch-error-attempt-${attempt}-${randomUUID()}.json`,
  );
  // Whole-object dump: everything the thrown value carries, nothing picked.
  const payload = `${JSON.stringify(
    {
      version: 1,
      attempt,
      recordedAt: new Date().toISOString(),
      error: serializeThrownValue(error),
    },
    jsonSafeReplacer(),
    2,
  )}\n`;
  // O_EXCL: exclusive create — the retention history is append-only by
  // construction; a colliding name fails loudly instead of overwriting.
  // O_NOFOLLOW when the platform provides it keeps a planted symlink from
  // being followed; on platforms without it, exclusivity still holds.
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag,
    0o600,
  );
  try {
    await handle.writeFile(payload, "utf8");
  } finally {
    await handle.close();
  }
  // Addressable pointer in the dossier (卷宗): reuses the session principal's
  // appended custom-entry shape (mirrors pi SessionManager.appendCustomEntry,
  // same mechanism as #419 attempt history — no second ledger introduced).
  // The one-writer lease is held for the append (#426 review: production
  // dispatchers release the lease in their finally before the rejection reaches
  // this point); if a concurrent writer already holds it, the append is skipped
  // gracefully — the error file itself is already durably retained.
  let pointerLease: RunWriterLease;
  try {
    pointerLease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) return filePath;
    throw error;
  }
  try {
    const text = await readFile(admitted.sessionFile, "utf8");
    // Session headers are not branch entries (#419 precedent in
    // appendRunAttemptHistory excludes type === "session"); leave parentId null
    // until a non-header entry exists so the pointer stays addressable.
    let parentId: string | null = null;
    for (const line of text.trim().split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as { id?: unknown; type?: unknown };
      if (typeof entry.id === "string" && entry.type !== "session") parentId = entry.id;
    }
    const timestamp = new Date().toISOString();
    const pointerLine = `${JSON.stringify({
      type: "custom",
      customType: DISPATCH_ERROR_RETENTION_ENTRY_TYPE,
      data: { version: 1, attempt, file: filePath, recordedAt: timestamp },
      id: randomUUID(),
      parentId,
      timestamp,
    })}\n`;
    await appendFile(admitted.sessionFile, pointerLine, "utf8");
  } finally {
    await pointerLease.release();
  }
  return filePath;
}

/**
 * Typed failure terminal for a retry path that ended with only exceptions:
 * loud, non-lawful, carrying the last true cause and the pointers to the
 * full per-attempt error files. Never rethrows the raw exception at callers.
 */
function dispatchExceptionFailureTerminal(input: {
  role: TerminalRoleName;
  runId: string;
  causeError: unknown;
  errorFiles: readonly string[];
  autoResumeAttempts: number;
  endReason: string;
  /** True only when every attempt threw; otherwise describe just the final attempt. */
  everyAttemptThrew: boolean;
}): TerminalResult {
  // #426 review: this terminal fires whenever the FINAL dispatch throws, not
  // only when every attempt threw — do not misrepresent a mixed retry history.
  const history = input.everyAttemptThrew
    ? "dispatch threw an exception on every attempt"
    : "the final dispatch threw an exception";
  const diagnostic = `${history} (${input.endReason}; resumes used ${input.autoResumeAttempts}); last cause: ${describeErrorIdentity(input.causeError)}`;
  const decisiveFacts: Record<string, unknown> = {
    cause: "unrecognized",
    diagnostic,
    resumesUsed: input.autoResumeAttempts,
    dispatchErrorFiles: [...input.errorFiles],
  };
  if (input.errorFiles.length > 0) {
    decisiveFacts.lastDispatchErrorFile = input.errorFiles[input.errorFiles.length - 1];
  }
  const candidate = input.causeError as { name?: unknown; code?: unknown };
  if (typeof candidate?.name === "string") decisiveFacts.errorName = candidate.name;
  if (typeof candidate?.code === "string" || typeof candidate?.code === "number") {
    decisiveFacts.errorCode = candidate.code;
  }
  const artifacts: TerminalArtifactRef[] = input.errorFiles.map((path) => ({
    kind: "error",
    path,
  }));
  return {
    roleOutcome: {
      kind: "failure",
      role: input.role,
      cause: "unrecognized",
      diagnostic,
      decisiveFacts,
    },
    navigator: { disposition: "no-advice" },
    artifacts,
    runId: input.runId,
    autoResumeCount: input.autoResumeAttempts,
  };
}

export async function runWithAutoResumeLoop<T extends AutoResumeDispatchResult>(options: {
  admitted: {
    sessionFile: string;
    runDirectory: string;
    /** Identity for the loop-owned typed failure terminal (dispatch-exception exhaustion). */
    role: TerminalRoleName;
    runId: string;
  };
  io: CliIo;
  /**
   * Effective ceiling (#422), resolved by the caller before the loop; never re-read
   * per round. undefined = package default (AUTO_RESUME_LIMIT). Domain-validated at
   * this single entry point (#422): NaN/negative/fractional/Infinity reject loudly
   * before the first dispatch instead of silently bypassing the ceiling comparison.
   */
  autoResumeLimit?: number | undefined;
  buildInitialArgs: () => string[];
  buildResumeArgs: () => string[];
  dispatch: (extraArgs: string[], lease: RunWriterLease, isFirst: boolean, attemptIo: CliIo) => Promise<T>;
}): Promise<T> {
  // #422 single-point resolution + domain validation. NaN would bypass every
  // `attempts >= limit` comparison (always false) — reject here, before any dispatch.
  const limit = options.autoResumeLimit ?? AUTO_RESUME_LIMIT;
  parseAutoResumeLimit(limit);
  let autoResumeAttempts = 0;
  let isFirst = true;
  let currentExtraArgs = options.buildInitialArgs();
  let dispatchOrdinal = 0;
  let lastThrownError: unknown;
  let everyAttemptThrew = true;
  const retainedErrorFiles: string[] = [];

  while (true) {
    let lease: RunWriterLease;
    try {
      lease = await acquireRunWriterLease(options.admitted.runDirectory, (diagnostic) =>
        options.io.stderr(diagnostic),
      );
    } catch (error) {
      if (error instanceof RunWriterLeaseHeldError) {
        presentStructuralRejection(error, options.io);
        return { exitCode: 2 } as T;
      }
      throw error;
    }

    let result: T | undefined;
    try {
      result = await options.dispatch(currentExtraArgs, lease, isFirst, dummyIo);
    } catch (error) {
      // Owner 2026-08-23: 「出了异常，就原地记录错误信息，然后重试。」
      // Retain the whole exception in place (per-attempt full file + dossier
      // pointer); recording failure must not break the retry path (PR #418
      // diagnostic-sink-isolation precedent). The dispatcher owns lease release
      // in its own finally, so the retry round starts with the lock free.
      lastThrownError = error;
      const attempt = dispatchOrdinal;
      try {
        // Track the file immediately after its successful write (#426 review):
        // a later pointer-append failure must never orphan the retained file.
        const file = await retainDispatchError(options.admitted, attempt, error);
        retainedErrorFiles.push(file);
        options.io.stderr(
          `dispatch attempt ${attempt} threw (${describeErrorIdentity(error)}); full error retained at ${file}\n`,
        );
      } catch (retentionError) {
        options.io.stderr(
          `dispatch error retention failed (best-effort continue): ${describeErrorIdentity(retentionError)}\n`,
        );
      }
    }
    dispatchOrdinal += 1;

    if (result !== undefined) {
      everyAttemptThrew = false;
      const terminal = (result as { terminal?: TerminalResult }).terminal;
      if (terminal !== undefined) {
        (terminal as { autoResumeCount?: number }).autoResumeCount = autoResumeAttempts;
      }

      const lawful = terminal !== undefined && isLawfulTypedTerminalOutcome(terminal.roleOutcome);
      if (lawful) {
        if (terminal !== undefined) {
          // Present lawful terminal once to real io (dummy was used inside dispatch)
          options.io.stdout(formatTerminalResult(terminal));
        }
        return result;
      }

      if (autoResumeAttempts >= limit) {
        if (terminal !== undefined) presentTerminal(terminal, options.io);
        return result;
      }
      if (!(await isSessionPrincipalAvailable(options.admitted.sessionFile))) {
        if (terminal !== undefined) presentTerminal(terminal, options.io);
        return result;
      }
    } else {
      // Exception path: continue through the identical budget/session gates.
      if (autoResumeAttempts >= limit) {
        const terminal = dispatchExceptionFailureTerminal({
          role: options.admitted.role,
          runId: options.admitted.runId,
          causeError: lastThrownError,
          errorFiles: retainedErrorFiles,
          autoResumeAttempts,
          endReason: "auto-resume budget exhausted",
          everyAttemptThrew,
        });
        await finalizeExceptionRunBestEffort(options.admitted.runDirectory, options.io);
        presentTerminal(terminal, options.io);
        return {
          exitCode: 1,
          terminal,
        } as T;
      }
      if (!(await isSessionPrincipalAvailable(options.admitted.sessionFile))) {
        const terminal = dispatchExceptionFailureTerminal({
          role: options.admitted.role,
          runId: options.admitted.runId,
          causeError: lastThrownError,
          errorFiles: retainedErrorFiles,
          autoResumeAttempts,
          endReason: "session principal unavailable before further resume",
          everyAttemptThrew,
        });
        await finalizeExceptionRunBestEffort(options.admitted.runDirectory, options.io);
        presentTerminal(terminal, options.io);
        return {
          exitCode: 1,
          terminal,
        } as T;
      }
    }

    autoResumeAttempts++;
    currentExtraArgs = options.buildResumeArgs();
    isFirst = false;
  }
}
