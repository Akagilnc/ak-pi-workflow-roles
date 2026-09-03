/**
 * Public Collector Role run: admit a structured PR target → explicit Internal activate
 * → settle Terminal result (#112 / #517). #633: manual resume continues the exact
 * session. Lifecycle is the shared post-admission coordinator.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCollectorInvocation,
  buildCollectorTransportPrompt,
  type AdmittedCollectorInvocation,
  type ParseCollectorArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionManualResume,
  runPostAdmissionOneShot,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  buildResumeContinuationPrompt,
  loadResumableCollectorRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  readCollectorInfrastructureFailure,
  trySettleCollectorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type CollectorRunEnv = PostAdmissionEnv & {
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildCollectorTurnRequest(
  admitted: AdmittedCollectorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "collector" as const,
        repo: admitted.repository.display,
        pr: String(admitted.prNumber),
        ...(admitted.requestManifestPath === undefined ? {} : { requestManifestPath: admitted.requestManifestPath }),
      },
    },
    options,
  );
}

export async function runPublicCollector(
  argv: readonly string[],
  env: CollectorRunEnv,
  io: CliIo,
  parseCollectorArgv: (args: readonly string[]) => ParseCollectorArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCollectorInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedCollectorInvocation;
  try {
    const parsed = parseCollectorArgv(argv);
    admitted = await admitCollectorInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      prNumber: parsed.prNumber,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
      ...(parsed.requestManifestPath === undefined ? {} : { requestManifestPath: parsed.requestManifestPath }),
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

  const turnRequest = buildCollectorTurnRequest(admitted, {
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
      prompt: buildCollectorTransportPrompt(admitted, engineSessionMaterialFromOptions({ ...(env.engine === undefined ? {} : { engine: env.engine }), packageRoot: env.packageRoot })),
    },
  });

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: collectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function collectorAdapters(): PostAdmissionAdapters<AdmittedCollectorInvocation> {
  return {
    trySettle: (admitted, authority) => trySettleCollectorTerminalResult(admitted, authority),
    shouldPresentSettled: () => true,
    resolveRunnerKnownFailure: async ({ result, sessionFile }) => {
      const infrastructureFailure = await readCollectorInfrastructureFailure(sessionFile);
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

/**
 * Resume a previously admitted Collector run (#633). Repository/PR identity
 * restores from the durable admitted request; the session principal reopens.
 */
export async function runPublicCollectorResume(
  request: PublicResumeRequest,
  env: CollectorRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCollectorInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableCollectorRun(
      env.home,
      request.runId,
      env.principalAuthority,
    );
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const { admitted } = loaded;
  const turnRequest = buildCollectorTurnRequest(admitted, {
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
        ...(request.message === undefined ? {} : { message: request.message }),
      }),
    },
  });

  return await runPostAdmissionManualResume({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: collectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
