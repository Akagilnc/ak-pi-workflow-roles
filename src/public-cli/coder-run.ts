/**
 * Public Coder Role run: admit → explicit Internal activate → settle Terminal result.
 * #109: package-owned TDD method, default apply / explicit plan, shared #106 success interface.
 * Controlled-failure settlement reuses the #107 shared owner (no new failure classes).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import {
  knownFailureFromProviderStop,
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCoderInvocation,
  buildCoderTransportPrompt,
  type AdmittedCoderInvocation,
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
  loadResumableCoderRun,
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
  hasLawfulCoderTerminalResult,
  inspectJudgeSession,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  readSessionProviderStop,
  settleFailureTerminalResult,
  trySettleCoderTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";
import { knownFailureForMissingProviderCredential } from "./judge-run.ts";

export type CoderRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
};

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
 * Build Internal activation extra-args for an admitted Coder run.
 * Apply phase pins the package-owned TDD Skill via --skill (no ambient home).
 * Plan phase keeps --no-skills without a method Skill.
 */
export function buildCoderActivationExtraArgs(
  admitted: AdmittedCoderInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const prompt = buildCoderTransportPrompt(admitted);
  const skillArgs =
    admitted.phase === "apply"
      ? [
          "--skill",
          resolvePackagedMethodSkillPath(options.packageRoot, "tdd"),
        ]
      : [];
  return [
    "--no-skills",
    ...skillArgs,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "coder",
    "--ak-coder-phase",
    admitted.phase,
    "--ak-coder-task",
    admitted.taskPath,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    prompt,
  ];
}

/**
 * Reopen the exact Coder Pi session for resume. Preserves admitted phase and
 * package TDD binding; does not resubmit the original instruction.
 */
export function buildCoderResumeActivationExtraArgs(
  admitted: AdmittedCoderInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const skillArgs =
    admitted.phase === "apply"
      ? [
          "--skill",
          resolvePackagedMethodSkillPath(options.packageRoot, "tdd"),
        ]
      : [];
  return [
    "--no-skills",
    ...skillArgs,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "coder",
    "--ak-coder-phase",
    admitted.phase,
    "--ak-coder-task",
    admitted.taskPath,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    RESUME_TRANSPORT_ENVELOPE,
  ];
}

async function presentControlledFailure(
  admitted: AdmittedCoderInvocation,
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
  admitted: AdmittedCoderInvocation;
  terminal: TerminalResult;
}> {
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

  const hasLawfulTerminalResult = await hasLawfulCoderTerminalResult(admitted);
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

  // #107 owns generic controlled-failure settlement — consume, do not re-own.
  const terminal = await settleFailureTerminalResult(
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

async function dispatchAdmittedCoder(input: {
  admitted: AdmittedCoderInvocation;
  env: CoderRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
  methodProvenance?: PackagedMethodSkillProvenance;
}): Promise<{
  exitCode: number;
  admitted: AdmittedCoderInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodProvenance } = input;
  try {
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
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

    try {
      await writeFile(
        join(admitted.runDirectory, "stderr.log"),
        result.stderr,
        "utf8",
      );
    } catch {
      // continue to lawful / controlled-failure settlement
    }

    let lawful: TerminalResult | undefined;
    try {
      lawful = await trySettleCoderTerminalResult(admitted, {
        ...(methodProvenance === undefined
          ? {}
          : { methodProvenance }),
      });
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
    if (lawful !== undefined && isLawfulTypedTerminalOutcome(lawful.roleOutcome) && knownFailureForMissingProviderCredential(env.model, env.credentials) === undefined) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful,
      };
    }

    const sessionProviderStop = await readSessionProviderStop(
      admitted.sessionFile,
    );
    const sessionProviderFailure =
      sessionProviderStop === undefined
        ? undefined
        : knownFailureFromProviderStop(sessionProviderStop);
    const credentialFailure =
      knownFailureForMissingProviderCredential(env.model, env.credentials);
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

export async function runPublicCoder(
  argv: readonly string[],
  env: CoderRunEnv,
  io: CliIo,
  parseCoderArgv: (args: readonly string[]) => {
    phase: "plan" | "apply";
    instruction: string;
    attachmentPaths: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedCoderInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedCoderInvocation;
  try {
    const parsed = parseCoderArgv(argv);
    admitted = await admitCoderInvocation({
      home: env.home,
      cwd: env.cwd,
      phase: parsed.phase,
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

  let methodProvenance: PackagedMethodSkillProvenance | undefined;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd",
      );
      methodProvenance = material.provenance;
    } catch (error) {
      await lease.release();
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
        },
        io,
      );
    }
  }

  const extraArgs = buildCoderActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedCoder({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    ...(methodProvenance === undefined ? {} : { methodProvenance }),
  });
}

/**
 * Resume a previously admitted Coder Role run after a typed HTTP 429.
 * Restores role/phase/task/session identity; model override is temporary.
 */
export async function runPublicCoderResume(
  argv: readonly string[],
  env: CoderRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCoderInvocation;
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
    presentStructuralRejection(
      new CliUsageError("resume takes exactly one run id"),
      io,
    );
    return { exitCode: 2 };
  }

  let loaded;
  try {
    loaded = await loadResumableCoderRun(env.home, runId);
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

  let methodProvenance: PackagedMethodSkillProvenance | undefined;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd",
      );
      methodProvenance = material.provenance;
    } catch (error) {
      await lease.release();
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
        },
        io,
      );
    }
  }

  const extraArgs = buildCoderResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedCoder({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    ...(methodProvenance === undefined ? {} : { methodProvenance }),
  });
}

// Re-export for tests that assert typed credential failure channel shape.
export type { ExplicitInternalKnownFailure };
