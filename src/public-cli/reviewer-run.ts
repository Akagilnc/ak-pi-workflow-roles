/**
 * Public Reviewer Role run: admit → post-admission coordinator → settle Terminal result (#111 / #517).
 * Package-owned adapted code-review method is forced; users never submit
 * extra packets. Controlled-failure settlement reuses #107.
 * #526: execution via RoleTurnHost; argv is Pi adapter internal.
 */
import type {
  DurablePrincipalAuthority,
  MethodBinding,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
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
} from "./invocation.ts";
import {
  loadResumableReviewerRun,
  markRunAdmitted,
  selectResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import { clearReviewerDispatchRejection } from "./reviewer-dispatch-rejection.ts";
import {
  hasLawfulReviewerTerminalResult,
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
  runPostAdmissionManualResume,
  runPostAdmissionResumable,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";

export type ReviewerRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

function reviewerMethods(packageRoot: string): readonly MethodBinding[] {
  return [{ kind: "skill", path: resolvePackagedMethodSkillPath(packageRoot, "code-review") }];
}

/** Project admitted Reviewer invocation onto the host-neutral turn request. */
export function buildReviewerTurnRequest(
  admitted: AdmittedReviewerInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "reviewer",
        baseRevision: admitted.baseRevision,
        authorityRefs: admitted.authorityRefs,
        ...(admitted.ticketNumber === undefined ? {} : { ticketNumber: admitted.ticketNumber }),
      },
      methods: reviewerMethods(options.packageRoot),
    },
    options,
  );
}

function reviewerAdapters(
  packageRoot: string,
  methodMaterial?: PackagedMethodSkillMaterial,
): PostAdmissionAdapters<AdmittedReviewerInvocation> {
  return {
    beforeDispatch: (admitted) => clearReviewerDispatchRejection(admitted.runDirectory),
    trySettle: (admitted, authority) =>
      methodMaterial === undefined
        ? Promise.resolve(undefined)
        : trySettleReviewerTerminalResult(admitted, authority, {
            methodProvenance: methodMaterial.provenance,
            methodSkillPath: methodMaterial.skillPath,
            methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
              packageRoot,
              "code-review",
            ),
          }),
    hasLawfulTerminalResult: (admitted, authority) => hasLawfulReviewerTerminalResult(admitted, authority),
    isResumableRole: true,
    resolveRunnerKnownFailure: async ({ result, sessionFile }) => {
      const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
      return infrastructureFailure === undefined
        ? result.knownFailure
        : {
            cause: infrastructureFailure.cause,
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
  return await loadPackagedMethodSkillMaterial(packageRoot, "code-review");
}

export async function runPublicReviewer(
  argv: readonly string[],
  env: ReviewerRunEnv,
  io: CliIo,
  parseReviewerArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    baseRevision: string;
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
      authorityRefs: parsed.authorityRefs,
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
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "initial",
          prompt: buildReviewerTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...(env.engine === undefined ? {} : { engine: env.engine }),
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
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
        ...(admitted.correlationId === undefined && env.correlationId === undefined
          ? {}
          : { correlationId: admitted.correlationId ?? env.correlationId }),
        continuation: {
          kind: "resume",
          prompt: selectResumeContinuationPrompt(),
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
  let loaded;
  try {
    loaded = await loadResumableReviewerRun(env.home, request.runId, env.principalAuthority);
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

  const turnRequest = buildReviewerTurnRequest(admitted, {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(admitted.model === undefined ? (env.model === undefined ? {} : { model: env.model }) : { model: admitted.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(admitted.correlationId === undefined && env.correlationId === undefined
      ? {}
      : { correlationId: admitted.correlationId ?? env.correlationId }),
    continuation: {
      kind: "resume",
      prompt: selectResumeContinuationPrompt(request.message),
    },
  });

  return await runPostAdmissionManualResume({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: reviewerAdapters(env.packageRoot, methodMaterial),
  });
}

export type { RoleTurnKnownFailure, PackagedMethodSkillProvenance };
