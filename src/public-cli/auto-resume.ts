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
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  SessionCustomEntryAppender,
} from "../host-contracts.ts";
import {
  AUTO_RESUME_LIMIT,
  describeErrorIdentity,
  acquireRunWriterLease,
  markRunTerminal,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import { parseAutoResumeLimit } from "./config.ts";
import { processCancelSignalName } from "./process-cancel.ts";
import { isLawfulTypedTerminalOutcome, formatTerminalResult, receiptErrorRows, type TerminalArtifactRef, type TerminalResult, type TerminalRoleName } from "./terminal.ts";
import {
  attachRecordedSubmissions,
  besideConclusion,
  filedIdentity,
  packageFaultNoteFor,
  presentFailureDiagnostic,
  retainPackageFault,
} from "./settlement.ts";

import { discardStdout, type CliIo } from "./cli-io.ts";
import { serializeThrownValue } from "../serialize-thrown-value.ts";
import { reportRunRecord } from "../sitian-facade.ts";

import { errorText } from "../unknown-value.ts";

const dummyIo: CliIo = { stdout: discardStdout, stderr: discardStdout };

/**
 * Persist run-state after a host-turn result, outside the retried dispatch try.
 * The host outcome already decided the terminal. This write only seals the run.
 */
export async function persistReturnedRunState(
  admitted: { runDirectory: string },
): Promise<void> {
  await markRunTerminal(admitted.runDirectory);
}

// A quiet caller can still deliver a returned volume; only the other two stay here.
type VolumeDelivery = "returned" | "alongside" | "discarded";

export async function presentSeatVolume(
  seat: Pick<import("../public-role-summons.ts").PublicSummonResult, "terminal" | "admitted" | "runDirectory"> | undefined,
  io: CliIo, delivery: VolumeDelivery,
): Promise<void> {
  if (!seat?.terminal || (delivery === "discarded" && !seat.terminal.receiptErrors?.length)) return;
  const dir = seat.admitted?.runDirectory ?? seat.runDirectory;
  if (dir) await presentTerminal(seat.terminal, { ...io, omitFailureStderrDiagnostic: true }, dir, delivery);
}

export async function presentTerminal(terminal: TerminalResult, io: CliIo, runDirectory: string, delivery: VolumeDelivery = "returned"): Promise<void> {
  try {
    if (delivery !== "discarded" && io.stdout !== discardStdout) io.stdout(formatTerminalResult(terminal));
    else if (delivery !== "returned") {
      for (const row of receiptErrorRows(terminal)) (io.receiptDiagnostic ?? io.stderr)(`${row}\n`);
    }
    if (delivery !== "discarded" && io.stderr !== discardStdout && (terminal.roleOutcome.kind === "failure" || terminal.roleOutcome.kind === "no_receipt")) {
      presentFailureDiagnostic(terminal, io);
    }
  } catch (error) {
    // Presentation consumes a settled report; it never reopens dispatch or
    // replaces the host's cause, identity or open details.
    await retainPackageFault({
      runDirectory,
      diagnostic: `terminal presentation failed beside host terminal: ${describeErrorIdentity(error)}`,
      error,
      stderr: (text) => io.stderr(text),
    });
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
 * genuinely started — never to fabricate a replacement terminal (ADR 0080:
 * one settlement disposition owner — settlement stays exactly presentControlledFailure
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
        errorText(cause)
      }`,
      { cause },
    );
  }
}

/** Session custom-entry type carrying the pointer to one dispatch error file. */
export const DISPATCH_ERROR_RETENTION_ENTRY_TYPE = "ak_run_dispatch_error_retention" as const;

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
 * Retain one throwing dispatch attempt's complete exception as a line in the
 * run's log.jsonl, then leave an addressable pointer in the session principal
 * (custom entry). The log only appends (史必追加, #419): a later attempt can
 * never overwrite an earlier attempt's record.
 */
async function retainDispatchError(
  admitted: { runDirectory: string; principal: DurablePrincipal },
  principalAuthority: DurablePrincipalAuthority,
  sessionAppender: SessionCustomEntryAppender,
  attempt: number,
  error: unknown,
): Promise<{ file: string; pointerError?: unknown }> {
  // Whole-object dump: everything the thrown value carries, nothing picked.
  const filePath = reportRunRecord(admitted.runDirectory, "dispatch-exception", JSON.parse(JSON.stringify({
    version: 1,
    attempt,
    recordedAt: new Date().toISOString(),
    error: serializeThrownValue(error),
  }, jsonSafeReplacer())) as Record<string, unknown>, "auto-resume").recordFile;
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
  runDirectory: string;
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
  // #881: no fabricated cause class — original error identity + error-file pointers carry the fact.
  const decisiveFacts: Record<string, unknown> = {
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
      diagnostic,
      decisiveFacts,
    },
    navigator: { disposition: "no-advice" },
    artifacts,
    ...filedIdentity(input.runDirectory),
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
    /** Required: exception terminals attach the ledger via this existing admitted fact. */
    projectRoot: string;
  };
  principalAuthority: DurablePrincipalAuthority;
  io: CliIo;
  sessionAppender: SessionCustomEntryAppender;
  /**
   * Effective ceiling (#422), resolved by the caller before the loop; never re-read
   * per round. undefined = package default (AUTO_RESUME_LIMIT). Domain-validated at
   * this single entry point (#422): NaN/negative/fractional/Infinity reject loudly
   * before the first dispatch instead of silently bypassing the ceiling comparison.
   */
  autoResumeLimit?: number | undefined;
  /**
   * #855: process-cancel signal. Once aborted by a catchable process signal,
   * the loop must not dispatch another turn or spawn another child.
   */
  signal?: AbortSignal;
  buildInitialPayload: () => TPayload;
  buildResumePayload: () => TPayload;
  /**
   * #987: the initial turn retains the existing writer lease/liveness guard;
   * actual resume attempts pass no lease so a live holder cannot pre-block the
   * host CLI's own continuation contract.
   */
  dispatch: (
    payload: TPayload,
    lease: RunWriterLease | undefined,
    isFirst: boolean,
    attemptIo: CliIo,
  ) => Promise<T>;
}): Promise<T> {
  // #422 single-point resolution + domain validation. NaN would bypass every
  // `attempts >= limit` comparison (always false) — reject here, before any dispatch.
  const limit = options.autoResumeLimit ?? AUTO_RESUME_LIMIT;
  parseAutoResumeLimit(limit);
  let autoResumeAttempts = 0;
  let isFirst = true;
  let currentPayload = options.buildInitialPayload();
  let dispatchOrdinal = 0;
  let lastThrownError: unknown;
  let everyAttemptThrew = true;
  const retainedErrorFiles: string[] = [];
  const failedAttempts: Array<{
    attempt: number;
    diagnostic: string;
    decisiveFacts?: Readonly<Record<string, unknown>>;
    errorFile?: string;
  }> = [];
  let stoppedResult: T | undefined;
  let endReason: string | undefined;

  while (true) {
    let result: T | undefined;
    // Set only when the caught throw is a TurnDispatchedFailure (#840 r9 判词
    // class 1): the host turn genuinely started this attempt even though
    // dispatch produced no result — the next payload must still be a resume,
    // not a replay of the initial one.
    let turnStartedBeforeThrow = false;
    try {
      // #987: guard the initial new turn with the existing lease, but do not
      // pre-block a real host CLI resume on a package-side live holder.
      const lease = isFirst
        ? await acquireRunWriterLease(options.admitted.runDirectory)
        : undefined;
      result = await options.dispatch(currentPayload, lease, isFirst, dummyIo);
    } catch (error) {
      // Owner 2026-08-23: 「出了异常，就原地记录错误信息，然后重试。」
      // Retain the whole exception in place (per-attempt full file + dossier
      // pointer); recording failure must not break the retry path (PR #418
      // diagnostic-sink-isolation precedent). When a lease is held inside
      // dispatch, that path owns release in its own finally.
      lastThrownError = error;
      const failedAttempt: (typeof failedAttempts)[number] = {
        attempt: dispatchOrdinal,
        diagnostic: describeErrorIdentity(unwrapTurnDispatchedFailure(error)),
      };
      failedAttempts.push(failedAttempt);
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
        failedAttempt.errorFile = file;
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
      const terminal = result.terminal;
      if (terminal !== undefined) {
        (terminal as { autoResumeCount?: number }).autoResumeCount = autoResumeAttempts;
        if (terminal.roleOutcome.kind === "failure") {
          failedAttempts.push({
            attempt: dispatchOrdinal - 1,
            diagnostic: terminal.roleOutcome.diagnostic,
            decisiveFacts: terminal.roleOutcome.decisiveFacts,
          });
        }
      }

      if (terminal !== undefined && isLawfulTypedTerminalOutcome(terminal.roleOutcome)
        || result.skipAutoResume === true
        || autoResumeAttempts >= limit
        || processCancelSignalName(options.signal) !== undefined) {
        stoppedResult = result;
        break;
      }
      if (terminal) await presentTerminal(terminal, options.io, options.admitted.runDirectory, "discarded");
    } else {
      if (autoResumeAttempts >= limit) {
        endReason = "auto-resume budget exhausted";
        break;
      }
      const cancelName = processCancelSignalName(options.signal);
      if (cancelName !== undefined) {
        endReason = `ak-role terminated by ${cancelName}`;
        break;
      }
    }

    autoResumeAttempts++;
    // Resume payload only after a host turn actually started — either a
    // returned result says so, or the attempt threw a TurnDispatchedFailure
    // after genuinely starting the turn (#840 r9 判词 class 1). Pre-turn
    // throws and beforeDispatch failures retry the initial payload (#840 / #416).
    if (result?.turnDispatched === true || turnStartedBeforeThrow) {
      currentPayload = options.buildResumePayload();
      isFirst = false;
    }
  }

  // The loop's own terminal is in hand: finishing steps keep it (ADR 0080).
  const note = packageFaultNoteFor(options.admitted, options, options.io);
  let terminal = stoppedResult?.terminal;
  if (stoppedResult === undefined) {
    const exception = dispatchExceptionFailureTerminal({
      role: options.admitted.role,
      runDirectory: options.admitted.runDirectory,
      causeError: lastThrownError,
      errorFiles: retainedErrorFiles,
      autoResumeAttempts,
      endReason: endReason!,
      everyAttemptThrew,
    });
    terminal = await besideConclusion(note, "dispatch exception ledger attach",
      () => attachRecordedSubmissions(options.admitted, exception)) ?? exception;
    // An exhausted invocation must not stay live (#426); finalization never masks the cause.
    await besideConclusion(note, "run terminal-state finalization", () => markRunTerminal(options.admitted.runDirectory));
  }
  const complete: TerminalResult | undefined = terminal !== undefined && failedAttempts.length > 0
    ? { ...terminal, roleOutcome: {
      ...terminal.roleOutcome,
      decisiveFacts: { ...terminal.roleOutcome.decisiveFacts, failedAttempts },
    } } as TerminalResult
    : terminal;
  // The seat selects its accepted volume after routing; other stops are final here.
  if (complete !== undefined && complete.roleOutcome.kind !== "accepted") {
    await presentTerminal(complete, options.io, options.admitted.runDirectory);
  }
  return stoppedResult === undefined
    ? { exitCode: 1, terminal: complete } as T
    : { ...stoppedResult, ...(complete === undefined ? {} : { terminal: complete }) } as T;
}
