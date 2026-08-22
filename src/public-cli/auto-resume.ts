/**
 * Single generic auto-resume loop for #416 (owner scope = single LLM call).
 * Call-local retries, at most AUTO_RESUME_LIMIT times, in-place (same runId/session).
 * Unifies presentation: intermediate attempts use dummyIo, only final Terminal is presented.
 * Only `roleOutcome.kind === "failure"` is retryable. Settled typed terminals
 * — accepted, audit_escalation, no_receipt, audit_incomplete, incomplete —
 * stop immediately. Feeding those to presentFailureTerminal throws.
 */
import { AUTO_RESUME_LIMIT, isSessionPrincipalAvailable, acquireRunWriterLease, RunWriterLeaseHeldError, type RunWriterLease } from "./run-lifecycle.ts";
import { formatTerminalResult, type TerminalResult } from "./terminal.ts";
import { presentFailureTerminal, presentStructuralRejection } from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";

const dummyIo: CliIo = { stdout: () => {}, stderr: () => {} };

export type AutoResumeDispatchResult = {
  exitCode: number;
  terminal?: TerminalResult;
};

function presentSettledTerminal(terminal: TerminalResult, io: CliIo): void {
  if (terminal.roleOutcome.kind === "failure") {
    presentFailureTerminal(terminal, io);
    return;
  }
  io.stdout(formatTerminalResult(terminal));
}

export async function runWithAutoResumeLoop<T extends AutoResumeDispatchResult>(options: {
  admitted: { sessionFile: string; runDirectory: string };
  io: CliIo;
  buildInitialArgs: () => string[];
  buildResumeArgs: () => string[];
  dispatch: (extraArgs: string[], lease: RunWriterLease, isFirst: boolean, attemptIo: CliIo) => Promise<T>;
}): Promise<T> {
  let autoResumeAttempts = 0;
  let isFirst = true;
  let currentExtraArgs = options.buildInitialArgs();
  let previous: T | undefined;

  while (true) {
    let lease: RunWriterLease;
    try {
      lease = await acquireRunWriterLease(options.admitted.runDirectory);
    } catch (error) {
      if (error instanceof RunWriterLeaseHeldError) {
        // A prior attempt already settled. Do not wash that Terminal into a
        // structural lease rejection (e.g. unlink failed on an unwritable run
        // tree, so the lock file remains). First-attempt lease conflict stays 2.
        if (previous !== undefined) {
          const priorTerminal = (previous as { terminal?: TerminalResult }).terminal;
          if (priorTerminal !== undefined) presentSettledTerminal(priorTerminal, options.io);
          return previous;
        }
        presentStructuralRejection(error, options.io);
        return { exitCode: 2 } as T;
      }
      throw error;
    }

    const result = await options.dispatch(currentExtraArgs, lease, isFirst, dummyIo);
    previous = result;

    const terminal = (result as { terminal?: TerminalResult }).terminal;
    if (terminal !== undefined) {
      (terminal as { autoResumeCount?: number }).autoResumeCount = autoResumeAttempts;
    }

    // Cut-off retries only. Settled incompletes are already a final typed outcome.
    const retryable = terminal === undefined || terminal.roleOutcome.kind === "failure";
    if (!retryable) {
      presentSettledTerminal(terminal, options.io);
      return result;
    }

    if (autoResumeAttempts >= AUTO_RESUME_LIMIT) {
      if (terminal !== undefined) presentSettledTerminal(terminal, options.io);
      return result;
    }
    if (!(await isSessionPrincipalAvailable(options.admitted.sessionFile))) {
      if (terminal !== undefined) presentSettledTerminal(terminal, options.io);
      return result;
    }

    autoResumeAttempts++;
    currentExtraArgs = options.buildResumeArgs();
    isFirst = false;
  }
}
