/**
 * Public Coder Role run: admit → explicit Internal activate → settle Terminal result.
 * #109: package-owned TDD method, default apply / explicit plan, shared #106 success interface.
 * Controlled-failure settlement reuses the #107 shared owner (no new failure classes).
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyEngineChildEnv } from "../engine-detour.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import {
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCoderInvocation,
  buildCoderTransportPrompt,
  type AdmittedCoderInvocation
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
  isV1ResumableFailure,
  loadResumableCoderRun,
  markRunAdmitted,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  renderResumeCommand,
  type PublicResumeRequest,
  selectResumeContinuationPrompt,
  RunWriterLeaseHeldError,
  type RunWriterLease,
  type TypedProviderHttpObservation,
} from "./run-lifecycle.ts";
import { runWithAutoResumeLoop } from "./auto-resume.ts";
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
  explicitInternalKnownFailureClassificationInput,
  resolveAuditedRunnerFailureResolution,
  resolveControlledFailureResumeObservation,
  controlledFailureInputFromResolution,
  settleFailureTerminalResult,
  trySettleCoderTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type CoderRunEnv = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  /** Optional labor engine name (config→activation; session material + env signal). */
  engine?: string;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  /** #422: effective single-call auto-resume ceiling; undefined = package default (AUTO_RESUME_LIMIT). */
  autoResumeLimit?: number;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
};

/**
 * Build Internal activation extra-args for an admitted Coder run.
 * Apply phase pins the package-owned TDD Skill via --skill (no ambient home).
 * Plan phase keeps --no-skills without a method Skill.
 */
export function buildCoderActivationExtraArgs(
  admitted: AdmittedCoderInvocation,
  options: {
    principalAuthority: DurablePrincipalAuthority;
    packageRoot: string;
    model?: SeatModelConfig;
    engine?: string;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const { sessionFile, sessionDirectory } = decodePiDurablePrincipal(options.principalAuthority, admitted.principal!);
  const prompt = buildCoderTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions(options),
  );
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
    sessionFile,
    "--session-dir",
    sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "coder",
    "--ak-coder-phase",
    admitted.phase,
    "--ak-coder-task",
    admitted.taskPath,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
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
    principalAuthority: DurablePrincipalAuthority;
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
    message?: string;
  },
): string[] {
  const { sessionFile, sessionDirectory } = decodePiDurablePrincipal(options.principalAuthority, admitted.principal!);
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
    sessionFile,
    "--session-dir",
    sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "coder",
    "--ak-coder-phase",
    admitted.phase,
    "--ak-coder-task",
    admitted.taskPath,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    selectResumeContinuationPrompt(options.message),
  ];
}

async function presentControlledFailure(
  admitted: AdmittedCoderInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: ExplicitInternalKnownFailure;
    knownCause?: ControlledFailureCause;
    knownIdentity?: {
      readonly name?: string;
      readonly code?: string | number;
    };
    knownDiagnostic?: string;
    typedHttpObservationSettled?: true;
    typedHttpObservation?: TypedProviderHttpObservation;
  },
  authority: DurablePrincipalAuthority,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedCoderInvocation;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
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
    knownFailure === undefined &&
    failureInput.knownCause === undefined
      ? await inspectJudgeSession(decodePiDurablePrincipal(authority, admitted.principal).sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(knownFailure),
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

  const hasLawfulTerminalResult = await hasLawfulCoderTerminalResult(admitted, authority);
  const typedHttp429 = resumeObservation.typedHttp429;
  const sessionPrincipalAvailable = await authority.isAvailable(admitted.principal!);
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
    authority,
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
  /** Mechanical engine provenance for initial Coder dispatch only. */
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedCoderInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodProvenance, effectiveEngine } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        env.principalAuthority,
        io,
      );
    }
    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
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
        env.principalAuthority,
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
      lawful = await trySettleCoderTerminalResult(admitted, env.principalAuthority, {
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
        env.principalAuthority,
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

    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const resolution = await resolveAuditedRunnerFailureResolution({
      runner: result.knownFailure,
      sessionFile: decodePiDurablePrincipal(env.principalAuthority, admitted.principal).sessionFile,
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
      env.principalAuthority,
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
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      phase: parsed.phase,
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

  await markRunAdmitted(admitted, env.principalAuthority);
  // #416 scope = single LLM call: call-local retry counter, no persistence.

  let methodProvenance: PackagedMethodSkillProvenance | undefined;
  if (admitted.phase === "apply") {
    try {
      const material = await loadPackagedMethodSkillMaterial(
        env.packageRoot,
        "tdd",
      );
      methodProvenance = material.provenance;
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
        },
        env.principalAuthority,
        io,
      );
    }
  }

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    io,
    // #422: pass-through only; the loop entry resolves the default and validates the domain once.
    autoResumeLimit: env.autoResumeLimit,
    buildInitialArgs: () =>
      buildCoderActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    buildResumeArgs: () =>
      buildCoderResumeActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    dispatch: (extraArgs, lease, isFirst, attemptIo) =>
      dispatchAdmittedCoder({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        extraArgs,
        lease,
        ...(methodProvenance === undefined ? {} : { methodProvenance }),
        ...(isFirst && env.engine !== undefined ? { effectiveEngine: env.engine } : {}),
      }),
  });
}

/**
 * Resume a previously admitted Coder Role run after a typed HTTP 429.
 * Restores role/phase/task/session identity; model override is temporary.
 */
export async function runPublicCoderResume(
  request: PublicResumeRequest,
  env: CoderRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCoderInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableCoderRun(env.home, request.runId, env.principalAuthority);
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
        env.principalAuthority,
        io,
      );
    }
  }

  const extraArgs = buildCoderResumeActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
    ...(request.message === undefined ? {} : { message: request.message }),
  });

  const result = await dispatchAdmittedCoder({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    extraArgs,
    lease,
    ...(methodProvenance === undefined ? {} : { methodProvenance }),
  });
  if (result.terminal !== undefined) {
    (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  }
  return result;
}

// Re-export for tests that assert typed credential failure channel shape.
export type { ExplicitInternalKnownFailure };
