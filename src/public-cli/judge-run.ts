/**
 * Public Judge Role run: admit → post-admission coordinator → settle Terminal result (#106 / #517).
 * #107: controlled post-admission failures and human decisions settle honestly.
 * #108: typed HTTP 429 resume of the exact Pi session.
 */
import type {
  DurablePrincipalAuthority,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitJudgeInvocation,
  buildJudgeTransportPrompt,
  type AdmittedJudgeInvocation,
} from "./invocation.ts";
import {
  loadResumableJudgeRun,
  markRunAdmitted,
  selectResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  hasLawfulJudgeTerminalResult,
  presentStructuralRejection,
  readEngineDetourInfrastructureFailure,
  trySettleJudgeTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";
import {
  runPostAdmissionManualResume,
  runPostAdmissionResumable,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";

export type JudgeRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildJudgeTurnRequest(
  admitted: AdmittedJudgeInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(admitted, { activation: { role: "judge" as const } }, options);
}

function judgeAdapters(): PostAdmissionAdapters<AdmittedJudgeInvocation> {
  return {
    trySettle: (admitted, authority) => trySettleJudgeTerminalResult(admitted, authority),
    hasLawfulTerminalResult: (admitted, authority) => hasLawfulJudgeTerminalResult(admitted, authority),
    isResumableRole: true,
    resolveRunnerKnownFailure: async ({ result, sessionFile }) => {
      const infrastructureFailure = await readEngineDetourInfrastructureFailure(sessionFile);
      return (
        result.knownFailure ??
        (infrastructureFailure === undefined
          ? undefined
          : {
              cause: infrastructureFailure.cause,
              diagnostic: infrastructureFailure.diagnostic,
              ...(infrastructureFailure.identity === undefined
                ? {}
                : { identity: infrastructureFailure.identity }),
            })
      );
    },
  };
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
  let admitted: AdmittedJudgeInvocation;
  try {
    const parsed = parseJudgeArgv(argv);
    admitted = await admitJudgeInvocation({
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
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  return await runPostAdmissionResumable({
    admitted,
    env,
    io,
    buildInitialRequest: () =>
      buildJudgeTurnRequest(admitted, {
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
          prompt: buildJudgeTransportPrompt(
            admitted,
            engineSessionMaterialFromOptions({
              ...(env.engine === undefined ? {} : { engine: env.engine }),
              packageRoot: env.packageRoot,
            }),
          ),
        },
      }),
    buildResumeRequest: () =>
      buildJudgeTurnRequest(admitted, {
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
    adapters: judgeAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
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
    loaded = await loadResumableJudgeRun(env.home, request.runId, env.principalAuthority);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const { admitted } = loaded;
  const turnRequest = buildJudgeTurnRequest(admitted, {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? (admitted.model === undefined ? {} : { model: admitted.model }) : { model: env.model }),
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
    adapters: judgeAdapters(),
  });
}

export type { RoleTurnKnownFailure };
