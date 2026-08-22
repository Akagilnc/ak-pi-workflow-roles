/**
 * Single generic auto-resume loop for #416 (owner scope = single LLM call).
 * Call-local retries, at most the effective autoResumeLimit times (injected once
 * per call by the caller, #422 — never re-read from disk inside the loop),
 * in-place (same runId/session).
 * Unifies presentation: intermediate attempts use dummyIo, only final Terminal is presented.
 */
import { AUTO_RESUME_LIMIT, isSessionPrincipalAvailable, acquireRunWriterLease, RunWriterLeaseHeldError, type RunWriterLease } from "./run-lifecycle.ts";
import { parseAutoResumeLimit } from "./config.ts";
import { isLawfulTypedTerminalOutcome, formatTerminalResult, type TerminalResult } from "./terminal.ts";
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

export async function runWithAutoResumeLoop<T extends AutoResumeDispatchResult>(options: {
  admitted: { sessionFile: string; runDirectory: string };
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

    if (autoResumeAttempts >= limit) {
      if (terminal !== undefined) presentTerminal(terminal, options.io);
      return result;
    }
    if (!(await isSessionPrincipalAvailable(options.admitted.sessionFile))) {
      if (terminal !== undefined) presentTerminal(terminal, options.io);
      return result;
    }

    autoResumeAttempts++;
    currentExtraArgs = options.buildResumeArgs();
    isFirst = false;
  }
}
