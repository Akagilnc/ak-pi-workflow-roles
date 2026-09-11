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
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { roleRunArtifactsDirectory } from "../role-run-placement.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  SessionCustomEntryAppender,
} from "../host-contracts.ts";
import {
  AUTO_RESUME_LIMIT,
  describeErrorIdentity,
  acquireRunWriterLease,
  markRunResumable,
  markRunTerminal,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import { parseAutoResumeLimit } from "./config.ts";
import { isLawfulTypedTerminalOutcome, formatTerminalResult, type TerminalArtifactRef, type TerminalResult, type TerminalRoleName } from "./terminal.ts";
import {
  presentFailureTerminal,
  presentStructuralRejection,
  resolveControlledFailureResumeObservation,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";

const dummyIo: CliIo = { stdout: () => {}, stderr: () => {} };

/**
 * Persist run-state after a host-turn result, outside the retried dispatch try.
 * Lawful settlement always seals terminal — a typed 429 observation must not
 * win (#416 成功即停). 429 only marks resumable on the controlled-failure path.
 * Write failure must escape the retried dispatch try instead of becoming a
 * synthetic host-turn terminal.
 */
export async function persistReturnedRunState(
  admitted: { runDirectory: string; principal?: DurablePrincipal },
  authority: Pick<DurablePrincipalAuthority, "isAvailable">,
  options?: { readonly lawful?: boolean },
): Promise<void> {
  if (options?.lawful === true) {
    await markRunTerminal(admitted.runDirectory);
    return;
  }
  const resumeObservation = await resolveControlledFailureResumeObservation({
    runDirectory: admitted.runDirectory,
  });
  const typedHttp429 = resumeObservation.typedHttp429;
  if (admitted.principal !== undefined && typedHttp429 !== undefined) {
    if (await authority.isAvailable(admitted.principal)) {
      await markRunResumable(admitted.runDirectory, typedHttp429);
      return;
    }
  }
  await markRunTerminal(admitted.runDirectory);
}

function presentTerminal(terminal: TerminalResult, io: CliIo): void {
  if (terminal.roleOutcome.kind === "failure" || terminal.roleOutcome.kind === "no_receipt") {
    presentFailureTerminal(terminal, io);
  } else {
    io.stdout(formatTerminalResult(terminal));
  }
}

/**
 * Best-effort finalization of the durable run state before an exception-path
 * synthetic failure terminal is returned (#426 review: analyst-ledger classifies
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
  /**
   * Pre-turn settlement under the writer lease (station child exhausted).
   * Loop presents this result and must not redispatch (#840 父子不层叠).
   */
  skipAutoResume?: true;
  /**
   * Host turn actually started. Absent on beforeDispatch / pre-turn settlement
   * so the loop retries the initial payload instead of a session resume.
   */
  turnDispatched?: true;
  /**
   * Dispatch skipped run-state persist so this loop seam owns it.
   * Absent when dispatch already persisted or never produced a terminal.
   */
  needsPersist?: true;
};

/**
 * Thrown by dispatchPostAdmissionTurn when a failure happens inside its own
 * settlement authority (presentControlledFailure) after the host turn
 * genuinely started — never to fabricate a replacement terminal (ADR 0080
 * single-settlement-disposition: settlement stays exactly presentControlledFailure
 * / settleFailureTerminalResult, or — once the retry budget is exhausted —
 * this loop's own dispatchExceptionFailureTerminal). Its only job is to carry
 * the "turn already started" fact across the throw boundary so this loop
 * selects a resume payload on the next attempt instead of replaying the
 * initial one (#840 r9 判词 class 1 boundary — 覆盖 executeTurn 已启动后至
 * 返回带 turnDispatched 结果前的全部异常). `cause` is the true failure;
 * retention below serializes it whole via the standard Error.cause chain.
 */
export class TurnDispatchedFailure extends Error {
  override readonly name = "TurnDispatchedFailure";
  constructor(cause: unknown) {
    super(
      `settlement failed after the host turn genuinely started: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Session custom-entry type carrying the pointer to one dispatch error file. */
export const DISPATCH_ERROR_RETENTION_ENTRY_TYPE = "ak_run_dispatch_error_retention" as const;

/**
 * #182-A hardened path identity, mirrored from settlement.ts's
 * ensureAuditEvidenceDirectory: a planted symlink at the run directory or the
 * artifacts path must not receive a durable run artifact (O_NOFOLLOW only
 * protects the final file name; recursive mkdir would accept a symlinked
 * parent). Fails loudly with the true cause instead. Shared by every caller
 * that needs a durable run-artifacts write independent of session/dossier
 * health — dispatch-error retention here, and post-admission's best-effort
 * cleanup diagnostic (#840 bounce class 2).
 */
export async function ensureRealArtifactsDirectory(runDirectory: string): Promise<string> {
  const runStat = await lstat(runDirectory);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new Error("run artifact retention: run directory is not a real directory");
  }
  const artifactsDir = roleRunArtifactsDirectory(runDirectory);
  try {
    const existing = await lstat(artifactsDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("run artifact retention: artifacts path is not a real directory");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(artifactsDir, { recursive: true });
    const created = await lstat(artifactsDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("run artifact retention: artifacts directory is not a real directory");
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
/**
 * Hardened create-once JSON write shared by every durable artifact this loop
 * retains directly (dispatch-error dumps, lawful-persist-failure error/
 * evidence records): O_EXCL (fail loud on a colliding name, never overwrite)
 * + O_NOFOLLOW where the platform provides it (a planted symlink is never
 * followed) — mirrors settlement.ts's own hardened artifact writers.
 */
async function writeHardenedArtifactFile(
  artifactsDir: string,
  namePrefix: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const filePath = join(artifactsDir, `${namePrefix}-${randomUUID()}.json`);
  const body = `${JSON.stringify(payload, jsonSafeReplacer(), 2)}\n`;
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag,
    0o600,
  );
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  return filePath;
}

async function retainDispatchError(
  admitted: { runDirectory: string; principal: DurablePrincipal },
  principalAuthority: DurablePrincipalAuthority,
  sessionAppender: SessionCustomEntryAppender,
  attempt: number,
  error: unknown,
): Promise<{ file: string; pointerError?: unknown }> {
  const artifactsDir = await ensureRealArtifactsDirectory(admitted.runDirectory);
  // Whole-object dump: everything the thrown value carries, nothing picked.
  const filePath = await writeHardenedArtifactFile(artifactsDir, `dispatch-error-attempt-${attempt}`, {
    version: 1,
    attempt,
    recordedAt: new Date().toISOString(),
    error: serializeThrownValue(error),
  });
  // Addressable pointer in the dossier (卷宗): Pi session custom-entry codec
  // (appendPiSessionCustomEntry). Lease still owned here with run-writer.
  let pointerLease: RunWriterLease;
  try {
    pointerLease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) return { file: filePath };
    throw error;
  }
  // Pointer-stage failure (#426 fix_now #5) is separated from the file write:
  // once the error file is durably on disk, a failed session append must not
  // reject through here and orphan it — the file path is still handed back.
  let pointerError: unknown;
  try {
    const timestamp = new Date().toISOString();
    await sessionAppender(
      principalAuthority,
      admitted.principal,
      DISPATCH_ERROR_RETENTION_ENTRY_TYPE,
      { version: 1, attempt, file: filePath, recordedAt: timestamp },
    );
  } catch (error) {
    pointerError = error;
  } finally {
    await pointerLease.release();
  }
  return pointerError === undefined ? { file: filePath } : { file: filePath, pointerError };
}

/**
 * Unwrap TurnDispatchedFailure before this loop's own final presentation
 * (#840 r9 判词 class 1 — the auto-resume.ts final presentation boundary).
 * The wrapper only carries the "turn already genuinely started" signal
 * across the throw boundary so the loop above selects a resume payload; the
 * typed decisiveFacts and diagnostic text below must name the real cause it
 * wraps (接住可以，洗白不行 — 未识别异常不得冒用具体标签，真因必须落痕), not
 * the internal signal's own identity.
 */
function unwrapTurnDispatchedFailure(error: unknown): unknown {
  let current = error;
  while (current instanceof TurnDispatchedFailure) {
    current = current.cause;
  }
  return current;
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
  const causeError = unwrapTurnDispatchedFailure(input.causeError);
  // #426 review: this terminal fires whenever the FINAL dispatch throws, not
  // only when every attempt threw — do not misrepresent a mixed retry history.
  const history = input.everyAttemptThrew
    ? "dispatch threw an exception on every attempt"
    : "the final dispatch threw an exception";
  const diagnostic = `${history} (${input.endReason}; resumes used ${input.autoResumeAttempts}); last cause: ${describeErrorIdentity(causeError)}`;
  const decisiveFacts: Record<string, unknown> = {
    cause: "unrecognized",
    diagnostic,
    resumesUsed: input.autoResumeAttempts,
    dispatchErrorFiles: [...input.errorFiles],
  };
  if (input.errorFiles.length > 0) {
    decisiveFacts.lastDispatchErrorFile = input.errorFiles[input.errorFiles.length - 1];
  }
  const candidate = causeError as { name?: unknown; code?: unknown };
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

export async function runWithAutoResumeLoop<
  T extends AutoResumeDispatchResult,
  TPayload = unknown,
>(options: {
  admitted: {
    runDirectory: string;
    /** Identity for the loop-owned typed failure terminal (dispatch-exception exhaustion). */
    role: TerminalRoleName;
    runId: string;
    principal: DurablePrincipal;
  };
  principalAuthority: DurablePrincipalAuthority;
  /**
   * Host-aware "can this principal's turn still be resumed" probe (#840 P1).
   * Callers that know the selected host pass
   * session-identity.ts's resolveHostAwareSessionAvailability(host,
   * principalAuthority) so an ACP/headless turn's own binding file — not
   * pi's session.jsonl — decides continuation for that host. Defaults to
   * principalAuthority.isAvailable (pi-only check) when omitted, so a
   * caller that never leaves the pi host keeps identical behavior.
   */
  isPrincipalAvailable?: (principal: DurablePrincipal) => Promise<boolean>;
  io: CliIo;
  sessionAppender: SessionCustomEntryAppender;
  /**
   * Effective ceiling (#422), resolved by the caller before the loop; never re-read
   * per round. undefined = package default (AUTO_RESUME_LIMIT). Domain-validated at
   * this single entry point (#422): NaN/negative/fractional/Infinity reject loudly
   * before the first dispatch instead of silently bypassing the ceiling comparison.
   */
  autoResumeLimit?: number | undefined;
  buildInitialPayload: () => TPayload;
  buildResumePayload: () => TPayload;
  dispatch: (payload: TPayload, lease: RunWriterLease, isFirst: boolean, attemptIo: CliIo) => Promise<T>;
}): Promise<T> {
  // #422 single-point resolution + domain validation. NaN would bypass every
  // `attempts >= limit` comparison (always false) — reject here, before any dispatch.
  const limit = options.autoResumeLimit ?? AUTO_RESUME_LIMIT;
  parseAutoResumeLimit(limit);
  const isPrincipalAvailable =
    options.isPrincipalAvailable ??
    ((principal: DurablePrincipal) => options.principalAuthority.isAvailable(principal));
  let autoResumeAttempts = 0;
  let isFirst = true;
  let currentPayload = options.buildInitialPayload();
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
    // Set only when the caught throw is a TurnDispatchedFailure (#840 r9 判词
    // class 1): the host turn genuinely started this attempt even though
    // dispatch produced no result — the next payload must still be a resume,
    // not a replay of the initial one.
    let turnStartedBeforeThrow = false;
    try {
      result = await options.dispatch(currentPayload, lease, isFirst, dummyIo);
    } catch (error) {
      // Owner 2026-08-23: 「出了异常，就原地记录错误信息，然后重试。」
      // Retain the whole exception in place (per-attempt full file + dossier
      // pointer); recording failure must not break the retry path (PR #418
      // diagnostic-sink-isolation precedent). The dispatcher owns lease release
      // in its own finally, so the retry round starts with the lock free.
      lastThrownError = error;
      turnStartedBeforeThrow = error instanceof TurnDispatchedFailure;
      const attempt = dispatchOrdinal;
      try {
        // Track the file as soon as it is durably written (#426 review):
        // a pointer-stage failure comes back separately (pointerError) and must
        // never orphan the retained file (#426 fix_now #5).
        const { file, pointerError } = await retainDispatchError(
          options.admitted,
          options.principalAuthority,
          options.sessionAppender,
          attempt,
          error,
        );
        retainedErrorFiles.push(file);
        options.io.stderr(
          `dispatch attempt ${attempt} threw (${describeErrorIdentity(error)}); full error retained at ${file}\n`,
        );
        if (pointerError !== undefined) {
          options.io.stderr(
            `dispatch error retention failed (best-effort continue): ${describeErrorIdentity(pointerError)}\n`,
          );
        }
      } catch (retentionError) {
        options.io.stderr(
          `dispatch error retention failed (best-effort continue): ${describeErrorIdentity(retentionError)}\n`,
        );
      }
    }
    dispatchOrdinal += 1;

    // #836 r12 class 3: run-state persist for a dispatch that deferred it
    // (needsPersist) is settled by the dispatch closure itself, before this
    // loop ever sees the result — through the single existing
    // presentControlledFailure / settleFailureTerminalResult authority (ADR
    // 0080), never a second hand-rolled classify/artifact/Terminal here. This
    // loop only ever sees the already-resolved outcome: a lawful/failure
    // Terminal (with skipAutoResume set when persist failed after an
    // already-settled result) or the original non-lawful result unchanged.
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
      if (result.skipAutoResume === true) {
        if (terminal !== undefined) presentTerminal(terminal, options.io);
        return result;
      }
    }

    if (result !== undefined) {
      const terminal = (result as { terminal?: TerminalResult }).terminal;
      if (autoResumeAttempts >= limit) {
        if (terminal !== undefined) presentTerminal(terminal, options.io);
        return result;
      }
      if (
        result.turnDispatched === true
        && !(await isPrincipalAvailable(options.admitted.principal))
      ) {
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
      if (!(await isPrincipalAvailable(options.admitted.principal))) {
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
    // Resume payload only after a host turn actually started — either a
    // returned result says so, or the attempt threw a TurnDispatchedFailure
    // after genuinely starting the turn (#840 r9 判词 class 1). Pre-turn
    // throws and beforeDispatch failures retry the initial payload (#840 / #416).
    if (result?.turnDispatched === true || turnStartedBeforeThrow) {
      currentPayload = options.buildResumePayload();
    }
    isFirst = false;
  }
}
