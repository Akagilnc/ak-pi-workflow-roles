/**
 * Public Judge Role run: admit → explicit Internal activate → settle Terminal result.
 * #107: controlled post-admission failures and human decisions settle honestly.
 * #108: typed HTTP 429 resume of the exact Pi session.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyEngineChildEnv } from "../engine-detour.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
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
  buildSeatModelCliArgs,
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
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
  renderResumeCommand,
  type TypedProviderHttpObservation,
  type PublicResumeRequest,
  selectResumeContinuationPrompt,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import { runWithAutoResumeLoop } from "./auto-resume.ts";
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
  resolveAuditedRunnerFailureResolution,
  resolveControlledFailureResumeObservation,
  controlledFailureInputFromResolution,
  explicitInternalKnownFailureClassificationInput,
  readEngineDetourInfrastructureFailure,
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
  /** Optional labor engine name (config→activation; session material only). */
  engine?: string;
  /**
   * Credential presence for public providers (auth.json shape).
   * Used as the production-owned typed channel when a selected public provider
   * has no configured credential — never inferred from child stderr prose.
   */
  credentials?: CredentialProviders;
  createRunId?: () => string;
  /** #422: effective single-call auto-resume ceiling; undefined = package default (AUTO_RESUME_LIMIT). */
  autoResumeLimit?: number;
  /** Extra Pi args inserted before the prompt (tests: faux provider extension). */
  extraPiArgs?: readonly string[];
  /** Override default role-run timeout. */
  timeoutMs?: number;
};



/**
 * Build Internal activation extra-args for an admitted Judge run
 * (everything after `--no-extensions -e <entrypoint>`).
 * No public burden selector. Session placed under the #78 ledger book.
 */
export function buildJudgeActivationExtraArgs(
  admitted: AdmittedJudgeInvocation,
  options: {
    model?: SeatModelConfig;
    engine?: string;
    packageRoot?: string;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildJudgeTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions(options),
  );
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
    ...buildSeatModelCliArgs(options.model),
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
    message?: string;
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
    ...buildSeatModelCliArgs(options.model),
    selectResumeContinuationPrompt(options.message),
  ];
}

async function presentControlledFailure(
  admitted: AdmittedJudgeInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: ExplicitInternalKnownFailure;
    /** Pre-resolved typed-HTTP outcome — no second sidecar read when settled. */
    typedHttpObservationSettled?: true;
    typedHttpObservation?: TypedProviderHttpObservation;
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedJudgeInvocation;
  terminal: TerminalResult;
}> {
  // Own-key presence, not value: `throw undefined` must not look like "no throw".
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  // v1 resume observation: reuse audited resolution when present; otherwise one
  // controlled read. Non-absence failures fold into knownFailure — never escape.
  const resumeObservation = await resolveControlledFailureResumeObservation({
    runDirectory: admitted.runDirectory,
    ...(failureInput.typedHttpObservationSettled === true
      ? {
        typedHttpObservationSettled: true as const,
        ...(failureInput.typedHttpObservation === undefined
          ? {}
          : { typedHttpObservation: failureInput.typedHttpObservation }),
      }
      : {}),
  });
  const knownFailure =
    failureInput.knownFailure ?? resumeObservation.observationReadFailure;
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    knownFailure === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(knownFailure),
    ...(session === undefined ? {} : { session }),
  });

  // v1 resume: only *this attempt's* typed HTTP 429 with independently confirmed
  // absence of a lawful Judge result, and a durable exact Pi session principal.
  // Lawful presence is session-owned and must not depend on artifact publication.
  const hasLawfulTerminalResult = await hasLawfulJudgeTerminalResult(admitted);
  const typedHttp429 = resumeObservation.typedHttp429;
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
  /**
   * Mechanical engine provenance for initial Judge dispatch only.
   * Explicit — never read from env.engine here, so resume cannot rewrite it.
   */
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedJudgeInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, effectiveEngine } = input;
  try {
    // Fail closed at the public credential seam before model dispatch: missing
    // selected-provider auth must not be washed by ambient keys or zero-exit runs.
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        io,
      );
    }
    await markRunRunning(
      admitted.runDirectory,
      env.model,
      effectiveEngine,
    );
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
    applyEngineChildEnv(childEnv, env.engine);
    const correlationId = admitted.correlationId ?? env.correlationId;
    if (correlationId !== undefined && correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = correlationId;
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
        timeoutMs: env.timeoutMs,
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

    // Prefer engine-detour infrastructure failure already on the session principal
    // over a later secondary provider-stop after abort (#357 T2 / collector-isomorphic).
    const infrastructureFailure = await readEngineDetourInfrastructureFailure(
      admitted.sessionFile,
    );
    // Production-owned typed cause channel — never inferred from stderr wording.
    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const resolution = await resolveAuditedRunnerFailureResolution({
      runner:
        result.knownFailure ??
        (infrastructureFailure === undefined
          ? undefined
          : {
              cause: infrastructureFailure.cause,
              diagnostic: infrastructureFailure.diagnostic,
              ...(infrastructureFailure.identity === undefined
                ? {}
                : { identity: infrastructureFailure.identity }),
            }),
      sessionFile: admitted.sessionFile,
      credential: credentialFailure,
      runDirectory: admitted.runDirectory,
    });
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...controlledFailureInputFromResolution(resolution),
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
      ...(env.model === undefined ? {} : { model: env.model }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted);

  return runWithAutoResumeLoop({
    admitted,
    io,
    // #422: pass-through only; the loop entry resolves the default and validates the domain once.
    autoResumeLimit: env.autoResumeLimit,
    buildInitialArgs: () =>
      buildJudgeActivationExtraArgs(admitted, {
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    buildResumeArgs: () =>
      buildJudgeResumeActivationExtraArgs(admitted, {
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    dispatch: (extraArgs, lease, isFirst, attemptIo) =>
      dispatchAdmittedJudge({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        extraArgs,
        lease,
        ...(isFirst && env.engine !== undefined ? { effectiveEngine: env.engine } : {}),
      }),
  });
}

/**
 * Resume a previously admitted Role run after a typed HTTP 429 interruption.
 * Restores role/project/instruction/attachments/session identity; model override
 * is temporary for this invocation only.
 */
export async function runPublicResume(
  request: PublicResumeRequest,
  env: JudgeRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedJudgeInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableJudgeRun(env.home, request.runId);
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
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic) => io.stderr(diagnostic));
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
    ...(request.message === undefined ? {} : { message: request.message }),
  });

  const result = await dispatchAdmittedJudge({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    extraArgs,
    lease,
  });
  // Manual resume: distinct scope from per-call auto retry; just expose observation.
  if (result.terminal !== undefined) {
    (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  }
  return result;
}
