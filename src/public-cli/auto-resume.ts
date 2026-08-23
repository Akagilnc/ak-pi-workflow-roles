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
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AUTO_RESUME_LIMIT,
  describeErrorIdentity,
  isSessionPrincipalAvailable,
  acquireRunWriterLease,
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
 * Whole-object transfer of a thrown value (owner 2026-08-23: 「记录所有错误信息。
 * 不能丢详细情况」). Every own property of the Error object — enumerable or not,
 * which is how message/stack and any attached identity land verbatim — plus the
 * constructor name and the full cause chain. No field list is prescribed or
 * filtered: whatever the exception object carries goes into the file as-is.
 */
function serializeThrownValue(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const transferred: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      transferred[key] = (value as unknown as Record<string, unknown>)[key];
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
                : serializeThrownValue(value.cause, depth + 1),
          }),
    };
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
  const artifactsDir = runArtifactsDirectory(admitted.runDirectory);
  await mkdir(artifactsDir, { recursive: true });
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
  const text = await readFile(admitted.sessionFile, "utf8");
  let parentId: string | null = null;
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as { id?: unknown };
    if (typeof entry.id === "string") parentId = entry.id;
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
}): TerminalResult {
  const diagnostic = `dispatch threw an exception on every attempt (${input.endReason}; resumes used ${input.autoResumeAttempts}); last cause: ${describeErrorIdentity(input.causeError)}`;
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
        const file = await retainDispatchError(options.admitted, attempt, error);
        retainedErrorFiles.push(file);
        options.io.stderr(
          `dispatch attempt ${attempt} threw (${describeErrorIdentity(error)}); full error retained at ${file}`,
        );
      } catch (retentionError) {
        options.io.stderr(
          `dispatch error retention failed (best-effort continue): ${describeErrorIdentity(retentionError)}`,
        );
      }
    }
    dispatchOrdinal += 1;

    if (result !== undefined) {
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
        return {
          exitCode: 1,
          terminal: dispatchExceptionFailureTerminal({
            role: options.admitted.role,
            runId: options.admitted.runId,
            causeError: lastThrownError,
            errorFiles: retainedErrorFiles,
            autoResumeAttempts,
            endReason: "auto-resume budget exhausted",
          }),
        } as T;
      }
      if (!(await isSessionPrincipalAvailable(options.admitted.sessionFile))) {
        return {
          exitCode: 1,
          terminal: dispatchExceptionFailureTerminal({
            role: options.admitted.role,
            runId: options.admitted.runId,
            causeError: lastThrownError,
            errorFiles: retainedErrorFiles,
            autoResumeAttempts,
            endReason: "session principal unavailable before further resume",
          }),
        } as T;
      }
    }

    autoResumeAttempts++;
    currentExtraArgs = options.buildResumeArgs();
    isFirst = false;
  }
}
