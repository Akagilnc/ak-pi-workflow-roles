/**
 * Public Merger Role run: derive active-merge envelope → force package
 * merge-only method → post-admission coordinator → settle Terminal result (#114 / #517).
 * #526: execution via RoleTurnHost; argv is Pi adapter internal.
 */
import type {
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ensureRealDirectoryTree } from "../activation-ledger-topology.ts";
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
  type AdmittedMergerInvocation,
} from "./invocation.ts";
import {
  loadResumableMergerRun,
  markRunAdmitted,
  buildResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  isLawfulTypedTerminalOutcome,
  presentStructuralRejection,
  trySettleMergerTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  presentControlledFailure,
  runPostAdmissionManualResume,
  runPostAdmissionResumable,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";

export type MergerRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
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
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "merger",
        inputPath: admitted.mergerInputPath,
      },
      methods: mergerMethods(options.packageRoot),
    },
    options,
  );
}

function mergerAdapters(
  packageRoot: string,
  methodMaterial?: PackagedMethodSkillMaterial,
): PostAdmissionAdapters<AdmittedMergerInvocation> {
  return {
    trySettle: (admitted, authority) =>
      methodMaterial === undefined
        ? Promise.resolve(undefined)
        : trySettleMergerTerminalResult(admitted, authority, {
            methodProvenance: methodMaterial.provenance,
            methodSkillPath: methodMaterial.skillPath,
            methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
              packageRoot,
              "resolving-merge-conflicts",
            ),
          }),
    shouldPresentSettled: (t) =>
      isLawfulTypedTerminalOutcome(t.roleOutcome) || t.roleOutcome.kind === "incomplete",
  };
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
  model?: import("./config.ts").SeatModelConfig;
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
      return (await presentControlledFailure(
        shell,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
          knownCause: "activation",
          knownDiagnostic: error.message,
        },
        mergerAdapters(env.packageRoot),
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: AdmittedMergerInvocation; terminal: TerminalResult };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadMergerMethodMaterial(env.packageRoot);
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
        knownCause: "activation",
      },
      mergerAdapters(env.packageRoot),
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: AdmittedMergerInvocation; terminal: TerminalResult };
  }

  return await runPostAdmissionResumable({
    admitted,
    env,
    io,
    buildInitialRequest: () =>
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
    buildResumeRequest: () =>
      buildMergerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "resume",
          prompt: buildResumeContinuationPrompt({
            packageRoot: env.packageRoot,
            ...(env.engine === undefined ? {} : { engine: env.engine }),
          }),
        },
      }),
    adapters: mergerAdapters(env.packageRoot, methodMaterial),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
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

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadMergerMethodMaterial(env.packageRoot);
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
        knownCause: "activation",
      },
      mergerAdapters(env.packageRoot),
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: AdmittedMergerInvocation; terminal: TerminalResult };
  }

  const turnRequest = buildMergerTurnRequest(
    admitted,
    resumeTurnRequestProjectionOptions(admitted, request, env),
  );

  return await runPostAdmissionManualResume({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: mergerAdapters(env.packageRoot, methodMaterial),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
