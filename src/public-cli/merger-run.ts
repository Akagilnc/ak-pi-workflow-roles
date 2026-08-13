/**
 * Public Merger Role run: derive active-merge envelope → force package
 * merge-only method → explicit Internal activate → settle Terminal result (#114).
 * Controlled-failure settlement reuses the #107 shared owner.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ensureRealDirectoryTree } from "../activation-ledger-topology.ts";
import { roleRunSessionCoordinates } from "../sitian-role-run-coordinates.ts";
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
  hasLawfulMergerTerminalResult,
  inspectJudgeSession,
  presentFailureTerminal,
  presentStructuralRejection,
  explicitInternalKnownFailureClassificationInput,
  resolveAuditedRunnerKnownFailure,
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
 * Build Internal activation extra-args for an admitted Merger run.
 * Package resolving-merge-conflicts Skill is forced via --skill; ambient home off.
 * Transport prompt forces `/skill:resolving-merge-conflicts` expansion first.
 */
export function buildMergerActivationExtraArgs(
  admitted: AdmittedMergerInvocation,
  options: {
    packageRoot: string;
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const prompt = buildMergerTransportPrompt(admitted);
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
    ...buildModelArgs(options.model),
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
    ...buildModelArgs(options.model),
    RESUME_TRANSPORT_ENVELOPE,
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
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedMergerInvocation;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    failureInput.knownFailure === undefined &&
    failureInput.knownCause === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
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
}): Promise<{
  exitCode: number;
  admitted: AdmittedMergerInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, methodMaterial } = input;
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
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure,
    });
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...(knownFailure === undefined ? {} : { knownFailure }),
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

  const extraArgs = buildMergerActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedMerger({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
}

/**
 * Resume a previously admitted Merger Role run after a typed HTTP 429.
 * Restores derived input/session identity; model override is temporary.
 */
export async function runPublicMergerResume(
  argv: readonly string[],
  env: MergerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedMergerInvocation;
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
    loaded = await loadResumableMergerRun(env.home, runId);
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
  });

  return await dispatchAdmittedMerger({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    methodMaterial,
  });
}

export type { ExplicitInternalKnownFailure, PackagedMethodSkillProvenance };
