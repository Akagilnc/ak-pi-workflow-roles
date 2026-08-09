/**
 * Public Fixer Role run: admit → explicit Internal activate → settle Terminal result.
 * #110/#177: package-owned diagnosing-bugs and tdd methods (available, not forced),
 * common Invocation + structural prerequisites, default apply / explicit plan,
 * shared #106 success interface. Controlled-failure settlement reuses #107.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
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
  admitFixerInvocation,
  buildFixerTransportPrompt,
  type AdmittedFixerInvocation,
} from "./invocation.ts";
import {
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
  isSessionPrincipalAvailable,
  isV1ResumableFailure,
  loadResumableFixerRun,
  markRunAdmitted,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  renderResumeCommand,
  RESUME_TRANSPORT_ENVELOPE,
  RunWriterLeaseHeldError,
  type RunWriterLease,
  readTypedHttp429Observation,
} from "./run-lifecycle.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  formatCliDiagnostic,
  formatTerminalResult,
  hasLawfulFixerTerminalResult,
  inspectJudgeSession,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  readSessionProviderStop,
  settleFailureTerminalResult,
  trySettleFixerTerminalResult,
  trySettleComplianceAuditIncompleteTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";
import { knownFailureForMissingProviderCredential } from "./judge-run.ts";

export type FixerRunEnv = {
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
 * Build Internal activation extra-args for an admitted Fixer run.
 * Package diagnosing-bugs and tdd Skills are available via --skill on every phase
 * (not forced into the first prompt). Ambient home skills stay disabled.
 */
export function buildFixerActivationExtraArgs(
  admitted: AdmittedFixerInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const prompt = buildFixerTransportPrompt(admitted);
  const diagnosisSkillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "diagnosing-bugs",
  );
  const tddSkillPath = resolvePackagedMethodSkillPath(options.packageRoot, "tdd");
  const prerequisiteArgs =
    admitted.prerequisitesPath === undefined
      ? []
      : ["--ak-fixer-prerequisites", admitted.prerequisitesPath];
  return [
    "--no-skills",
    "--skill",
    diagnosisSkillPath,
    "--skill",
    tddSkillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "fixer",
    "--ak-fixer-phase",
    admitted.phase,
    "--ak-fix-packet",
    admitted.packetPath,
    ...prerequisiteArgs,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    prompt,
  ];
}

/**
 * Reopen the exact Fixer Pi session for resume. Preserves admitted phase,
 * prerequisites, and package diagnosis/tdd availability; does not resubmit instruction.
 */
export function buildFixerResumeActivationExtraArgs(
  admitted: AdmittedFixerInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const diagnosisSkillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "diagnosing-bugs",
  );
  const tddSkillPath = resolvePackagedMethodSkillPath(options.packageRoot, "tdd");
  const prerequisiteArgs =
    admitted.prerequisitesPath === undefined
      ? []
      : ["--ak-fixer-prerequisites", admitted.prerequisitesPath];
  return [
    "--no-skills",
    "--skill",
    diagnosisSkillPath,
    "--skill",
    tddSkillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "fixer",
    "--ak-fixer-phase",
    admitted.phase,
    "--ak-fix-packet",
    admitted.packetPath,
    ...prerequisiteArgs,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    RESUME_TRANSPORT_ENVELOPE,
  ];
}

async function presentControlledFailure(
  admitted: AdmittedFixerInvocation,
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
    knownDetails?: Readonly<Record<string, unknown>>;
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedFixerInvocation;
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
    ...(failureInput.knownDetails === undefined
      ? {}
      : { knownDetails: failureInput.knownDetails }),
    ...(session === undefined ? {} : { session }),
  });

  const hasLawfulTerminalResult = await hasLawfulFixerTerminalResult(admitted);
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

async function dispatchAdmittedFixer(input: {
  admitted: AdmittedFixerInvocation;
  env: FixerRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
  methodMaterial: PackagedMethodSkillMaterial;
}): Promise<{
  exitCode: number;
  admitted: AdmittedFixerInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodMaterial } = input;
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
      lawful = await trySettleFixerTerminalResult(admitted, {
        methodProvenance: methodMaterial.provenance,
        methodSkillPath: methodMaterial.skillPath,
        methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
          env.packageRoot,
          "diagnosing-bugs",
        ),
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
              ...(knownFailure.details === undefined
                ? {}
                : { knownDetails: knownFailure.details }),
            }),
      },
      io,
    );
  } finally {
    await lease.release();
  }
}

async function loadFixerMethodMaterial(
  packageRoot: string,
): Promise<PackagedMethodSkillMaterial> {
  return await loadPackagedMethodSkillMaterial(packageRoot, "diagnosing-bugs");
}

export async function runPublicFixer(
  argv: readonly string[],
  env: FixerRunEnv,
  io: CliIo,
  parseFixerArgv: (args: readonly string[]) => {
    phase: "plan" | "apply";
    instruction: string;
    attachmentPaths: string[];
    prerequisitesPath?: string;
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedFixerInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedFixerInvocation;
  try {
    const parsed = parseFixerArgv(argv);
    admitted = await admitFixerInvocation({
      home: env.home,
      cwd: env.cwd,
      phase: parsed.phase,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.prerequisitesPath === undefined
        ? {}
        : { prerequisitesPath: parsed.prerequisitesPath }),
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

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadFixerMethodMaterial(env.packageRoot);
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

  const extraArgs = buildFixerActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedFixer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
}

/**
 * Resume a previously admitted Fixer Role run after a typed HTTP 429.
 * Restores role/phase/packet/prerequisites/session identity; model override is temporary.
 */
export async function runPublicFixerResume(
  argv: readonly string[],
  env: FixerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedFixerInvocation;
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
    loaded = await loadResumableFixerRun(env.home, runId);
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
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadFixerMethodMaterial(env.packageRoot);
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

  const extraArgs = buildFixerResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedFixer({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
}

// Re-export for tests that assert typed credential failure channel shape.
export type { ExplicitInternalKnownFailure, PackagedMethodSkillProvenance };
