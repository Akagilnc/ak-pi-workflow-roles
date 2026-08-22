/**
 * Single generic auto-resume loop for #416 (owner scope = single LLM call).
 * Call-local retries, at most AUTO_RESUME_LIMIT times, in-place (same runId/session).
 * Unifies presentation: intermediate attempts use dummyIo, only final Terminal is presented.
 */
import { AUTO_RESUME_LIMIT, isSessionPrincipalAvailable, acquireRunWriterLease, RunWriterLeaseHeldError, type RunWriterLease } from "./run-lifecycle.ts";
import { isLawfulTypedTerminalOutcome, formatTerminalResult, type TerminalResult } from "./terminal.ts";
import { presentFailureTerminal, presentStructuralRejection } from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";

const dummyIo: CliIo = { stdout: () => {}, stderr: () => {} };

export type AutoResumeDispatchResult = {
  exitCode: number;
  terminal?: TerminalResult;
};

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

  while (true) {
    let lease: RunWriterLease;
    try {
      lease = await acquireRunWriterLease(options.admitted.runDirectory);
    } catch (error) {
      if (error instanceof RunWriterLeaseHeldError) {
        presentStructuralRejection(error, options.io);
        return { exitCode: 2 } as T;
      }
      throw error;
    }

    const result = await options.dispatch(currentExtraArgs, lease, isFirst, dummyIo);

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

    // Deterministic incomplete/audit_incomplete (merger/collector/judge) would duplicate callId bindings on retry and lose settlement
    if (terminal !== undefined && (terminal.roleOutcome.kind === "incomplete" || terminal.roleOutcome.kind === "audit_incomplete")) {
      if (terminal.roleOutcome.kind === "audit_incomplete") {
        options.io.stdout(formatTerminalResult(terminal));
      } else {
        options.io.stdout(formatTerminalResult(terminal));
      }
      return result;
    }
    // Rich auditor retention detail would be lost on retry (stale child binding)
    if (terminal !== undefined && terminal.roleOutcome.kind === "failure") {
      const terminalJson = JSON.stringify(terminal);
      if (terminalJson.includes("retentionFailure") || terminalJson.includes("ComplianceResponseRetentionError")) {
        presentFailureTerminal(terminal, options.io);
        return result;
      }
    }

    if (autoResumeAttempts >= AUTO_RESUME_LIMIT) {
      if (terminal !== undefined) {
        if (terminal.roleOutcome.kind === "failure" || terminal.roleOutcome.kind === "no_receipt") {
          presentFailureTerminal(terminal, options.io);
        } else {
          options.io.stdout(formatTerminalResult(terminal));
        }
      }
      return result;
    }
    if (!(await isSessionPrincipalAvailable(options.admitted.sessionFile))) {
      if (terminal !== undefined) {
        if (terminal.roleOutcome.kind === "failure" || terminal.roleOutcome.kind === "no_receipt") {
          presentFailureTerminal(terminal, options.io);
        } else {
          options.io.stdout(formatTerminalResult(terminal));
        }
      }
      return result;
    }

    autoResumeAttempts++;
    currentExtraArgs = options.buildResumeArgs();
    isFirst = false;
  }
}
