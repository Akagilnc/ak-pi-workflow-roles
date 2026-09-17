/**
 * Public Reviewer Role run: admit → post-admission coordinator → settle Terminal result (#917 / #517).
 * Package-owned ak-cross-m-review method is forced; users never submit
 * extra packets. Controlled-failure settlement reuses #107.
 * #526: execution via RoleTurnHost; argv is Pi adapter internal.
 */
import type {
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions,
  pickEngineAxis,
} from "../package-resources/engine-material.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillMaterial,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitReviewerInvocation,
  buildReviewerTransportPrompt,
  type AdmittedReviewerInvocation,
  type ReviewerLens,
} from "./invocation.ts";
import {
  AUTO_RESUME_LIMIT,
  loadResumableReviewerRun,
  markRunAdmitted,
  RESUME_TRANSPORT_ENVELOPE,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  readEngineDetourInfrastructureFailure,
  trySettleReviewerTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  presentControlledFailure,
  resolveResumeMethodMaterialAdapters,
  runPostAdmissionResumable,
  runPostAdmissionSeatResume,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";

export type ReviewerRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

function reviewerMethods(packageRoot: string): readonly MethodBinding[] {
  return [{ kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "ak-cross-m-review") }];
}

/** Project admitted Reviewer invocation onto the host-neutral turn request. */
export function buildReviewerTurnRequest(
  admitted: AdmittedReviewerInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  const request = projectRoleTurnRequest(
    admitted,
    {
      activation: admitted.lens === "all"
        ? { role: "reviewer-parent" }
        : {
            role: "reviewer",
            baseRevision: admitted.baseRevision,
            lens: admitted.lens,
            authorityRefs: admitted.authorityRefs,
            ...(admitted.ticketNumber === undefined ? {} : { ticketNumber: admitted.ticketNumber }),
          },
      methods: admitted.lens === "all" ? [] : reviewerMethods(options.packageRoot),
    },
    options,
  );
  return admitted.lens === "all" ? { ...request, modelLess: true } : request;
}

function reviewerAdapters(
  packageRoot: string,
  methodMaterial?: PackagedMethodSkillMaterial,
): PostAdmissionAdapters<AdmittedReviewerInvocation> {
  return {
    trySettle: (admitted, authority, scope) =>
      methodMaterial === undefined
        ? Promise.resolve(undefined)
        : trySettleReviewerTerminalResult(
            admitted,
            authority,
            {
              methodProvenance: methodMaterial.provenance,
              methodSkillPath: methodMaterial.skillPath,
              methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
                packageRoot,
                "ak-cross-m-review",
              ),
            },
            scope,
          ),
    resolveRunnerKnownFailure: async ({ result, sessionFile }) => {
      const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
      return infrastructureFailure === undefined
        ? result.knownFailure
        : {
            ...(infrastructureFailure.cause === undefined
              ? {}
              : { cause: infrastructureFailure.cause }),
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined
              ? {}
              : { identity: infrastructureFailure.identity }),
          };
    },
  };
}

async function loadReviewerMethodMaterial(
  packageRoot: string,
): Promise<PackagedMethodSkillMaterial> {
  return await loadPackagedMethodSkillMaterial(packageRoot, "ak-cross-m-review");
}

/** Continue the existing method turn; frozen axes remain on typed activation fields. */
function reviewerResumePrompt(env: ReviewerRunEnv, message?: string): string {
  const lines: string[] = [RESUME_TRANSPORT_ENVELOPE];
  if (message !== undefined) lines.push("", message);
  return appendEngineSessionMaterial(
    lines,
    engineSessionMaterialFromOptions({
      ...pickEngineAxis(env),
      packageRoot: env.packageRoot,
    }),
  ).join("\n");
}

export async function runPublicReviewer(
  argv: readonly string[],
  env: ReviewerRunEnv,
  io: CliIo,
  parseReviewerArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    baseRevision: string;
    lens: ReviewerLens;
    authorityRefs: string[];
    project?: string;
  },
): Promise<{
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedReviewerInvocation;
  try {
    const parsed = parseReviewerArgv(argv);
    admitted = await admitReviewerInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      baseRevision: parsed.baseRevision,
      lens: parsed.lens,
      authorityRefs: parsed.authorityRefs,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
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

  if (admitted.lens === "all") {
    const { createParallelReviewerExecution } = await import("../public-role-summons.ts");
    const parallel = createParallelReviewerExecution(
      () => admitted,
      () => admitted.instruction,
      env,
      reviewerAdapters(env.packageRoot),
      AUTO_RESUME_LIMIT,
    );
    return await runPostAdmissionResumable({
      admitted,
      env: parallel.env,
      io,
      buildInitialRequest: () => buildReviewerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        continuation: { kind: "initial", prompt: admitted.instruction },
      }),
      buildResumeRequest: () => buildReviewerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        continuation: { kind: "resume", prompt: reviewerResumePrompt(env) },
      }),
      adapters: parallel.adapters,
      ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
    });
  }

  let methodMaterial: PackagedMethodSkillMaterial;
  try {
    methodMaterial = await loadReviewerMethodMaterial(env.packageRoot);
  } catch (error) {
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      reviewerAdapters(env.packageRoot),
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: AdmittedReviewerInvocation; terminal: TerminalResult };
  }

  return await runPostAdmissionResumable({
    admitted,
    env,
    io,
    buildInitialRequest: () =>
      buildReviewerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "initial",
          prompt: buildReviewerTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...pickEngineAxis(env),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      }),
    buildResumeRequest: () =>
      buildReviewerTurnRequest(admitted, {
        packageRoot: env.packageRoot,
        home: env.home,
        agentDir: env.agentDir,
        ...(env.model === undefined ? {} : { model: env.model }),
        ...pickEngineAxis(env),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "resume",
          prompt: reviewerResumePrompt(env),
        },
      }),
    adapters: reviewerAdapters(env.packageRoot, methodMaterial),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

/**
 * Resume a previously admitted Reviewer Role run after a typed HTTP 429.
 * Restores task/base/session identity; model override is temporary.
 */
export async function runPublicReviewerResume(
  request: PublicResumeRequest,
  env: ReviewerRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedReviewerInvocation;
  terminal?: TerminalResult;
}> {
  let activeAdmitted: AdmittedReviewerInvocation | undefined;
  const { createParallelReviewerExecution } = await import("../public-role-summons.ts");
  const parallel = createParallelReviewerExecution(
    () => {
      if (activeAdmitted === undefined) throw new Error("reviewer resume admission is not loaded");
      return activeAdmitted;
    },
    () => [activeAdmitted?.instruction, request.message]
      .filter((text): text is string => text !== undefined && text !== "")
      .join("\n\n"),
    env,
    reviewerAdapters(env.packageRoot),
    AUTO_RESUME_LIMIT,
  );
  return await runPostAdmissionSeatResume({
    request,
    env: parallel.env,
    io,
    load: (effective) =>
      loadResumableReviewerRun(env.home, effective.runId, env.principalAuthority),
    buildTurnRequest: (admitted, effective) => {
      activeAdmitted = admitted;
      const base = resumeTurnRequestProjectionOptions(admitted, effective, env);
      return buildReviewerTurnRequest(admitted, {
        ...base,
        continuation: {
          kind: "resume",
          prompt: reviewerResumePrompt(env, effective.message),
        },
      });
    },
    adapters: parallel.adapters,
    afterAdmittedLoad: async (admitted) => {
      activeAdmitted = admitted;
      if (admitted.lens === "all") {
        return { kind: "continue" as const, adapters: parallel.adapters };
      }
      return resolveResumeMethodMaterialAdapters({
        admitted,
        authority: env.principalAuthority,
        io,
        loadMaterial: () => loadReviewerMethodMaterial(env.packageRoot),
        adaptersWith: (material) => reviewerAdapters(env.packageRoot, material),
        emptyAdapters: reviewerAdapters(env.packageRoot),
      });
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
