/**
 * Public Navigator Role run (#639): admit instruction materials → shared
 * post-admission coordinator → settle Terminal result. Direct command face of
 * the route-advice seat; automatic attendance is unchanged and orthogonal.
 * Manual resume continues the exact session (same law as other roles).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitNavigatorInvocation,
  buildNavigatorTransportPrompt,
  type AdmittedNavigatorInvocation,
  type ParseNavigatorArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionManualResume,
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  loadResumableNavigatorRun,
  markRunAdmitted,
  buildResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleNavigatorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type NavigatorRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildNavigatorTurnRequest(
  admitted: AdmittedNavigatorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "navigator" as const,
      },
    },
    options,
  );
}

export async function runPublicNavigator(
  argv: readonly string[],
  env: NavigatorRunEnv,
  io: CliIo,
  parseNavigatorArgv: (args: readonly string[]) => ParseNavigatorArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedNavigatorInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedNavigatorInvocation;
  try {
    const parsed = parseNavigatorArgv(argv);
    admitted = await admitNavigatorInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  const turnRequest = buildNavigatorTurnRequest(admitted, {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(env.correlationId === undefined || env.correlationId.trim() === ""
      ? {}
      : { correlationId: env.correlationId }),
    continuation: {
      kind: "initial",
      prompt: buildNavigatorTransportPrompt(
        admitted,
        engineSessionMaterialFromOptions({
          ...(env.engine === undefined ? {} : { engine: env.engine }),
          packageRoot: env.packageRoot,
        }),
      ),
    },
  });

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: navigatorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function navigatorAdapters() {
  return {
    trySettle: (admitted: AdmittedNavigatorInvocation, authority: DurablePrincipalAuthority) =>
      trySettleNavigatorTerminalResult(admitted, authority),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Navigator run (#639 / DK-3).
 * Restores role/attachments/session identity; seat axes follow the live table.
 */
export async function runPublicNavigatorResume(
  request: PublicResumeRequest,
  env: NavigatorRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedNavigatorInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableNavigatorRun(
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
  const turnRequest = buildNavigatorTurnRequest(admitted, {
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
    adapters: navigatorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
