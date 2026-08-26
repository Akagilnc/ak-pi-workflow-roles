/**
 * Public Merger Role run: derive active-merge envelope → force package
 * merge-only method → explicit Internal activate → settle Terminal result (#114).
 * Controlled-failure settlement reuses the #107 shared owner.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ensureRealDirectoryTree } from "../activation-ledger-topology.ts";
import { roleRunSessionCoordinates } from "../archivist-role-run-coordinates.ts";
import { applyEngineChildEnv } from "../engine-detour.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import { uuidv7 } from "../uuidv7.ts";
import {
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitMergerInvocation,
  buildMergerTransportPrompt,
  MergerEnvelopeDerivationError,
  type AdmittedMergerInvocation,
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
  loadResumableMergerRun,
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
  hasLawfulMergerTerminalResult,
  inspectJudgeSession,
  presentFailureTerminal,
  presentStructuralRejection,
  explicitInternalKnownFailureClassificationInput,
  resolveAuditedRunnerFailureResolution,
  resolveControlledFailureResumeObservation,
  controlledFailureInputFromResolution,
  settleFailureTerminalResult,
  trySettleMergerTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type MergerRunEnv = {
  home: string;
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
 * Build Internal activation extra-args for an admitted Merger run.
 * Package resolving-merge-conflicts Skill is forced via --skill; ambient home off.
 * Transport prompt forces `/skill:resolving-merge-conflicts` expansion first.
 */
export function buildMergerActivationExtraArgs(
  admitted: AdmittedMergerInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    engine?: string;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const prompt = buildMergerTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions(options),
  );
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "resolving-merge-conflicts",
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "merger",
    "--ak-merger-input",
    admitted.mergerInputPath,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    prompt,
  ];
}

/**
 * Reopen the exact Merger Pi session for resume. Preserves derived input and
 * package method binding; does not resubmit the original instruction.
 */
export function buildMergerResumeActivationExtraArgs(
  admitted: AdmittedMergerInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
    message?: string;
  },
): string[] {
  const skillPath = resolvePackagedMethodSkillPath(
    options.packageRoot,
    "resolving-merge-conflicts",
  );
  return [
    "--no-skills",
    "--skill",
    skillPath,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "merger",
    "--ak-merger-input",
    admitted.mergerInputPath,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    selectResumeContinuationPrompt(options.message),
  ];
}

async function presentControlledFailure(
  admitted: AdmittedMergerInvocation,
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
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedMergerInvocation;
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
      ? await inspectJudgeSession(admitted.sessionFile)
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

  const hasLawfulTerminalResult = await hasLawfulMergerTerminalResult(admitted);
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

async function dispatchAdmittedMerger(input: {
  admitted: AdmittedMergerInvocation;
  env: MergerRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
  methodMaterial: PackagedMethodSkillMaterial;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedMergerInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodMaterial, effectiveEngine } = input;
  try {
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
      lawful = await trySettleMergerTerminalResult(admitted, {
        methodProvenance: methodMaterial.provenance,
        methodSkillPath: methodMaterial.skillPath,
        methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
          env.packageRoot,
          "resolving-merge-conflicts",
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
    if (lawful !== undefined) {
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

async function loadMergerMethodMaterial(
  packageRoot: string,
): Promise<PackagedMethodSkillMaterial> {
  return await loadPackagedMethodSkillMaterial(
    packageRoot,
    "resolving-merge-conflicts",
  );
}

/**
 * Structural admit shell when envelope derivation fails: keeps role-correct
 * Terminal identity for honest activation-class settlement without inventing
 * parents/conflicts (those stay empty; the gate never receives a guessed packet).
 */
async function admitMergerShellForActivationFailure(options: {
  home: string;
  cwd: string;
  instruction: string;
  project?: string;
  createRunId?: () => string;
}): Promise<AdmittedMergerInvocation> {
  const projectRoot = resolve(options.project ?? options.cwd);
  const runId = (options.createRunId ?? uuidv7)();
  const { ledgerHome, bookKey, runDirectory, sessionDirectory, sessionFile } =
    roleRunSessionCoordinates({ cwd: projectRoot, runId, role: "merger", home: options.home });
  ensureRealDirectoryTree(ledgerHome, sessionDirectory);
  await mkdir(runDirectory, { recursive: true });
  const emptyDerived = {
    targetObjectId: "",
    sourceObjectId: "",
    automaticMergeTreeId: "",
    expectedConflictPaths: [] as string[],
    resolutionScope: [] as string[],
  };
  const admittedRequestPath = join(runDirectory, "admitted-request.json");
  const mergerInputPath = join(runDirectory, "merger-input.json");
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify(
      {
        role: "merger",
        runId,
        bookKey,
        projectRoot,
        instruction: options.instruction,
        instructionEmpty: false,
        mergerInputPath,
        derived: emptyDerived,
        attachments: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    role: "merger",
    runId,
    bookKey,
    projectRoot,
    instruction: options.instruction,
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath,
    mergerInputPath,
    derived: emptyDerived,
  };
}

export async function runPublicMerger(
  argv: readonly string[],
  env: MergerRunEnv,
  io: CliIo,
  parseMergerArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedMergerInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: {
    instruction: string;
    attachmentPaths: string[];
    project?: string;
  };
  try {
    parsed = parseMergerArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  let admitted: AdmittedMergerInvocation;
  try {
    admitted = await admitMergerInvocation({
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
    if (error instanceof MergerEnvelopeDerivationError) {
      // No active merge / incomplete conflict set: honest activation failure.
      // Place a shell admitted run so Terminal identity stays role-correct.
      const shell = await admitMergerShellForActivationFailure({
        home: env.home,
        cwd: env.cwd,
        instruction: parsed.instruction,
        ...(parsed.project === undefined ? {} : { project: parsed.project }),
        ...(env.createRunId === undefined
          ? {}
          : { createRunId: env.createRunId }),
      });
      await markRunAdmitted(shell);
      return await presentControlledFailure(
        shell,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
          knownDiagnostic: error.message,
        },
        io,
      );
    }
    throw error;
  }

  await markRunAdmitted(admitted);

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadMergerMethodMaterial(env.packageRoot);
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
      io,
    );
  }

  return runWithAutoResumeLoop({
    admitted,
    io,
    // #422: pass-through only; the loop entry resolves the default and validates the domain once.
    autoResumeLimit: env.autoResumeLimit,
    buildInitialArgs: () =>
      buildMergerActivationExtraArgs(admitted, {
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    buildResumeArgs: () =>
      buildMergerResumeActivationExtraArgs(admitted, {
        packageRoot: env.packageRoot,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      }),
    dispatch: (extraArgs, lease, isFirst, attemptIo) =>
      dispatchAdmittedMerger({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        extraArgs,
        lease,
        methodMaterial,
        ...(isFirst && env.engine !== undefined ? { effectiveEngine: env.engine } : {}),
      }),
  });
}

/**
 * Resume a previously admitted Merger Role run after a typed HTTP 429.
 * Restores derived input/session identity; model override is temporary.
 */
export async function runPublicMergerResume(
  request: PublicResumeRequest,
  env: MergerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedMergerInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableMergerRun(env.home, request.runId);
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
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadMergerMethodMaterial(env.packageRoot);
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

  const extraArgs = buildMergerResumeActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
    ...(request.message === undefined ? {} : { message: request.message }),
  });

  const result = await dispatchAdmittedMerger({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
  if (result.terminal !== undefined) (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  return result;
}

export type { ExplicitInternalKnownFailure, PackagedMethodSkillProvenance };
