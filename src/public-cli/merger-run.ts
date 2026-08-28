/**
 * Public Merger Role run: derive active-merge envelope → force package
 * merge-only method → host turn execute → settle Terminal result (#114).
 * Controlled-failure settlement reuses the #107 shared owner.
 * #526: execution via RoleTurnHost; argv is Pi adapter internal.
 */
import type {
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "../host-contracts.ts";
import type { ControlledFailureCause } from "../host-contracts.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ensureRealDirectoryTree } from "../activation-ledger-topology.ts";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import { uuidv7 } from "../uuidv7.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitMergerInvocation,
  buildMergerTransportPrompt,
  issueAdmissionPlacement,
  MergerEnvelopeDerivationError,
  type AdmittedMergerInvocation
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
  isLawfulTypedTerminalOutcome,
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
  TerminalResult,
} from "./terminal.ts";

export type MergerRunEnv = {
  home: string;
  principalAuthority: DurablePrincipalAuthority;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  roleTurnHost: RoleTurnHost;
  model?: SeatModelConfig;
  /** Optional labor engine name (config→activation; session material + env signal). */
  engine?: string;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  /** #422: effective single-call auto-resume ceiling; undefined = package default (AUTO_RESUME_LIMIT). */
  autoResumeLimit?: number;
  timeoutMs?: number;
};

function mergerMethods(packageRoot: string): readonly MethodBinding[] {
  return [
    {
      kind: "skill",
      path: resolvePackagedMethodSkillPath(packageRoot, "resolving-merge-conflicts"),
    },
  ];
}

/** Project admitted Merger invocation onto the host-neutral turn request. */
export function buildMergerTurnRequest(
  admitted: AdmittedMergerInvocation,
  options: {
    packageRoot: string;
    home: string;
    agentDir: string;
    model?: SeatModelConfig;
    engine?: string;
    timeoutMs?: number;
    correlationId?: string;
    continuation: RoleTurnRequest["continuation"];
  },
): RoleTurnRequest {
  return {
    principal: admitted.principal!,
    activation: {
      role: "merger",
      inputPath: admitted.mergerInputPath,
    },
    methods: mergerMethods(options.packageRoot),
    continuation: options.continuation,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    cwd: admitted.projectRoot,
    home: options.home,
    agentDir: options.agentDir,
    runDirectory: admitted.runDirectory,
    ...(options.correlationId === undefined || options.correlationId.trim() === ""
      ? {}
      : { correlationId: options.correlationId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

async function presentControlledFailure(
  admitted: AdmittedMergerInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: RoleTurnKnownFailure;
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

  const hasLawfulTerminalResult = await hasLawfulMergerTerminalResult(admitted, authority);
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

async function dispatchAdmittedMerger(input: {
  admitted: AdmittedMergerInvocation;
  env: MergerRunEnv;
  io: CliIo;
  request: RoleTurnRequest;
  lease: RunWriterLease;
  methodMaterial: PackagedMethodSkillMaterial;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedMergerInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, request, lease, methodMaterial, effectiveEngine } = input;
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

    let result: RoleTurnResult;
    try {
      result = await env.roleTurnHost.executeTurn(request);
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
      lawful = await trySettleMergerTerminalResult(admitted, env.principalAuthority, {
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
        env.principalAuthority,
        io,
      );
    }
    // Residual malformed output is a typed incomplete Terminal, not a missing
    // lawful outcome — do not wash it into the generic failure channel.
    if (
      lawful !== undefined &&
      (isLawfulTypedTerminalOutcome(lawful.roleOutcome) ||
        lawful.roleOutcome.kind === "incomplete")
    ) {
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
  principalAuthority: DurablePrincipalAuthority;
}): Promise<AdmittedMergerInvocation> {
  const projectRoot = resolve(options.project ?? options.cwd);
  const runId = (options.createRunId ?? uuidv7)();
  const {
    principal,
    sessionDirectory,
    sessionFile,
    runDirectory,
    ledgerHome,
    bookKey,
  } = issueAdmissionPlacement(options.principalAuthority, {
    cwd: projectRoot,
    runId,
    role: "merger",
    home: options.home,
  });
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
        sessionDirectory,
        sessionFile,
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
    principal,
    admittedRequestPath,
    mergerInputPath,
    derived: emptyDerived,
  };
}

function mergerTurnOptions(
  admitted: AdmittedMergerInvocation,
  env: MergerRunEnv,
): {
  packageRoot: string;
  home: string;
  agentDir: string;
  model?: SeatModelConfig;
  engine?: string;
  timeoutMs?: number;
  correlationId?: string;
} {
  return {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(admitted.correlationId === undefined && env.correlationId === undefined
      ? {}
      : { correlationId: admitted.correlationId ?? env.correlationId }),
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
      principalAuthority: env.principalAuthority,
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
      principalAuthority: env.principalAuthority,
        cwd: env.cwd,
        instruction: parsed.instruction,
        ...(parsed.project === undefined ? {} : { project: parsed.project }),
        ...(env.createRunId === undefined
          ? {}
          : { createRunId: env.createRunId }),
      });
      await markRunAdmitted(shell, env.principalAuthority);
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
        env.principalAuthority,
        io,
      );
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

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
      env.principalAuthority,
      io,
    );
  }

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    io,
    // #422: pass-through only; the loop entry resolves the default and validates the domain once.
    autoResumeLimit: env.autoResumeLimit,
    buildInitialPayload: () =>
      buildMergerTurnRequest(admitted, {
        ...mergerTurnOptions(admitted, env),
        continuation: {
          kind: "initial",
          prompt: buildMergerTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...(env.engine === undefined ? {} : { engine: env.engine }),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      }),
    buildResumePayload: () =>
      buildMergerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "resume",
          prompt: selectResumeContinuationPrompt(),
        },
      }),
    dispatch: (request, lease, isFirst, attemptIo) =>
      dispatchAdmittedMerger({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        request,
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
    loaded = await loadResumableMergerRun(env.home, request.runId, env.principalAuthority);
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
      env.principalAuthority,
      io,
    );
  }

  const turnRequest = buildMergerTurnRequest(admitted, {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(admitted.correlationId === undefined && env.correlationId === undefined
      ? {}
      : { correlationId: admitted.correlationId ?? env.correlationId }),
    continuation: {
      kind: "resume",
      prompt: selectResumeContinuationPrompt(request.message),
    },
  });

  const result = await dispatchAdmittedMerger({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    request: turnRequest,
    lease,
    methodMaterial,
  });
  if (result.terminal !== undefined) (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  return result;
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
