/**
 * Public Judge Role run: admit → explicit Internal activate → settle Terminal result.
 * #107: controlled post-admission failures and human decisions settle honestly.
 * #108: typed HTTP 429 resume of the exact Pi session.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  knownFailureFromProviderStop,
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitJudgeInvocation,
  buildJudgeTransportPrompt,
  type AdmittedJudgeInvocation,
} from "./invocation.ts";
import {
  missingPublicProviderCredential,
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
  isSessionPrincipalAvailable,
  isV1ResumableFailure,
  loadResumableJudgeRun,
  markRunAdmitted,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  readTypedHttp429Observation,
  renderResumeCommand,
  RESUME_TRANSPORT_ENVELOPE,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  formatCliDiagnostic,
  formatTerminalResult,
  hasLawfulJudgeTerminalResult,
  inspectJudgeSession,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  readSessionProviderStop,
  settleJudgeFailureTerminalResult,
  trySettleJudgeTerminalResult,
  trySettleComplianceAuditIncompleteTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type JudgeRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  /** Effective judge seat model (persistent/startup/invocation). */
  model?: SeatModelConfig;
  /**
   * Credential presence for public providers (auth.json shape).
   * Used as the production-owned typed channel when a selected public provider
   * has no configured credential — never inferred from child stderr prose.
   */
  credentials?: CredentialProviders;
  createRunId?: () => string;
  /** Extra Pi args inserted before the prompt (tests: faux provider extension). */
  extraPiArgs?: readonly string[];
  /** Override default role-run timeout. */
  timeoutMs?: number;
};

/**
 * Production-owned provider failure when the selected public seat provider has
 * no configured credential. Cause/identity come from CredentialProviders, not
 * stderr wording. Runner-supplied knownFailure still wins over this annotation.
 */
export function knownFailureForMissingProviderCredential(
  model: SeatModelConfig | undefined,
  credentials: CredentialProviders | undefined,
): ExplicitInternalKnownFailure | undefined {
  if (model === undefined || credentials === undefined) return undefined;
  if (!missingPublicProviderCredential(model.provider, credentials)) {
    return undefined;
  }
  return {
    cause: "provider",
    identity: {
      name: "MissingProviderCredential",
      code: model.provider,
    },
  };
}

function buildModelArgs(model: SeatModelConfig | undefined): string[] {
  if (model === undefined) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking,
  ];
}

/**
 * Build Internal activation extra-args for an admitted Judge run
 * (everything after `--no-extensions -e <entrypoint>`).
 * No public burden selector. Session placed under the #78 ledger book.
 */
export function buildJudgeActivationExtraArgs(
  admitted: AdmittedJudgeInvocation,
  options: {
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildJudgeTransportPrompt(admitted);
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    // Exact Pi session file principal (SessionManager.open), not directory-latest.
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "judge",
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    prompt,
  ];
}

/**
 * Build Internal activation args that reopen the exact Pi session for resume.
 * Does not resubmit the admitted instruction; uses the package resume envelope.
 * Reopens the durable session file principal explicitly — never --continue latest.
 */
export function buildJudgeResumeActivationExtraArgs(
  admitted: AdmittedJudgeInvocation,
  options: {
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "judge",
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    RESUME_TRANSPORT_ENVELOPE,
  ];
}

async function presentControlledFailure(
  admitted: AdmittedJudgeInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownCause?: ControlledFailureCause;
    knownIdentity?: {
      readonly name?: string;
      readonly code?: string | number;
    };
    knownDiagnostic?: string;
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedJudgeInvocation;
  terminal: TerminalResult;
}> {
  // Own-key presence, not value: `throw undefined` must not look like "no throw".
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    failureInput.knownCause === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...(failureInput.knownCause === undefined
      ? {}
      : { knownCause: failureInput.knownCause }),
    ...(failureInput.knownIdentity === undefined
      ? {}
      : { knownIdentity: failureInput.knownIdentity }),
    ...(failureInput.knownDiagnostic === undefined
      ? {}
      : { knownDiagnostic: failureInput.knownDiagnostic }),
    ...(session === undefined ? {} : { session }),
  });

  // v1 resume: only *this attempt's* typed HTTP 429 with independently confirmed
  // absence of a lawful Judge result, and a durable exact Pi session principal.
  // Lawful presence is session-owned and must not depend on artifact publication.
  const hasLawfulTerminalResult = await hasLawfulJudgeTerminalResult(admitted);
  const typedHttp429 = await readTypedHttp429Observation(admitted.runDirectory);
  const sessionPrincipalAvailable = await isSessionPrincipalAvailable(
    admitted.sessionFile,
  );
  const resumable =
    sessionPrincipalAvailable &&
    isV1ResumableFailure({
      hasLawfulTerminalResult,
      ...(typedHttp429 === undefined ? {} : { typedHttp429 }),
    });
  if (resumable && typedHttp429 !== undefined) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => undefined);
  }

  const terminal = await settleJudgeFailureTerminalResult(
    admitted,
    failure,
    resumable
      ? { resume: { command: renderResumeCommand(admitted.runId) } }
      : {},
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

async function dispatchAdmittedJudge(input: {
  admitted: AdmittedJudgeInvocation;
  env: JudgeRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
}): Promise<{
  exitCode: number;
  admitted: AdmittedJudgeInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease } = input;
  try {
    await markRunRunning(admitted.runDirectory);
    // Attempt-scoped observation: drop any prior dispatch's 429 evidence so only
    // the current initial/resume attempt can qualify v1 resume.
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      // Public-run marker so Navigator work context prefers admitted instruction
      // and role-runtime can record typed provider HTTP observations.
      AK_ROLE_RUN_DIR: admitted.runDirectory,
    };
    if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }

    let result: ExplicitInternalPiResult;
    try {
      result = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs,
        cwd: admitted.projectRoot,
        home: env.home,
        agentDir: env.agentDir,
        env: childEnv,
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(env.piRunner === undefined ? {} : { runner: env.piRunner }),
      });
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
        },
        io,
      );
    }

    // stderr.log is a best-effort ledger mirror.
    try {
      await writeFile(
        join(admitted.runDirectory, "stderr.log"),
        result.stderr,
        "utf8",
      );
    } catch {
      // continue to lawful / controlled-failure settlement below
    }

    let lawful: TerminalResult | undefined;
    try {
      lawful = await trySettleJudgeTerminalResult(admitted);
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: error,
        },
        io,
      );
    }
    if (lawful !== undefined && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful,
      };
    }

    const auditIncomplete = await trySettleComplianceAuditIncompleteTerminalResult(admitted);
    if (auditIncomplete !== undefined) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      if (auditIncomplete.roleOutcome.kind === "failure") {
        presentFailureTerminal(auditIncomplete, io);
      } else {
        io.stdout(formatTerminalResult(auditIncomplete));
      }
      return {
        exitCode: exitCodeForTerminalOutcome(auditIncomplete.roleOutcome),
        admitted,
        terminal: auditIncomplete,
      };
    }

    // Production-owned typed cause channel — never inferred from stderr wording.
    const sessionProviderStop = await readSessionProviderStop(
      admitted.sessionFile,
    );
    const sessionProviderFailure =
      sessionProviderStop === undefined
        ? undefined
        : knownFailureFromProviderStop(sessionProviderStop);
    const credentialFailure =
      result.timedOut || result.code !== 0
        ? knownFailureForMissingProviderCredential(env.model, env.credentials)
        : undefined;
    const knownFailure =
      result.knownFailure ?? sessionProviderFailure ?? credentialFailure;
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...(knownFailure === undefined
          ? {}
          : {
              knownCause: knownFailure.cause,
              ...(knownFailure.identity === undefined
                ? {}
                : { knownIdentity: knownFailure.identity }),
              ...(knownFailure.diagnostic === undefined
                ? {}
                : { knownDiagnostic: knownFailure.diagnostic }),
            }),
      },
      io,
    );
  } finally {
    await lease.release();
  }
}

export async function runPublicJudge(
  argv: readonly string[],
  env: JudgeRunEnv,
  io: CliIo,
  parseJudgeArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedJudgeInvocation;
  terminal?: TerminalResult;
}> {
  // Structural parse/admit rejects before model dispatch via shared settlement presenter.
  let admitted: AdmittedJudgeInvocation;
  try {
    const parsed = parseJudgeArgv(argv);
    admitted = await admitJudgeInvocation({
      home: env.home,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted);

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const extraArgs = buildJudgeActivationExtraArgs(admitted, {
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedJudge({
    admitted,
    env,
    io,
    extraArgs,
    lease,
  });
}

/**
 * Resume a previously admitted Role run after a typed HTTP 429 interruption.
 * Restores role/project/instruction/attachments/session identity; model override
 * is temporary for this invocation only.
 */
export async function runPublicResume(
  argv: readonly string[],
  env: JudgeRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedJudgeInvocation;
  terminal?: TerminalResult;
}> {
  const runId = argv[0];
  if (runId === undefined || runId.trim() === "" || runId.startsWith("-")) {
    presentStructuralRejection(
      new CliUsageError("usage: ak-role resume <runId>"),
      io,
    );
    return { exitCode: 2 };
  }
  if (argv.length > 1) {
    // Resume does not accept free positionals beyond runId (model/thinking are global).
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io,
    );
    return { exitCode: 2 };
  }

  let loaded;
  try {
    loaded = await loadResumableJudgeRun(env.home, runId);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const { admitted } = loaded;

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      // Concurrent resume: reject without second writer or dispatch.
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }

  const extraArgs = buildJudgeResumeActivationExtraArgs(admitted, {
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedJudge({
    admitted,
    env,
    io,
    extraArgs,
    lease,
  });
}
