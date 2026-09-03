/**
 * Public Inspector Role run: admit instruction/attachments → shared post-admission
 * coordinator → settle Terminal result (#568 / ADR 0074). #633: manual resume
 * continues the exact session. Dual path with gate-province dispatch; this module
 * is the direct command face.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitInspectorInvocation,
  buildInspectorTransportPrompt,
  type AdmittedInspectorInvocation,
  type ParseInspectorArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionManualResume,
  runPostAdmissionOneShot,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  buildResumeContinuationPrompt,
  loadResumableInspectorRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleInspectorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type InspectorRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildInspectorTurnRequest(
  admitted: AdmittedInspectorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "inspector" as const,
      },
    },
    options,
  );
}

export async function runPublicInspector(
  argv: readonly string[],
  env: InspectorRunEnv,
  io: CliIo,
  parseInspectorArgv: (args: readonly string[]) => ParseInspectorArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInspectorInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedInspectorInvocation;
  try {
    const parsed = parseInspectorArgv(argv);
    admitted = await admitInspectorInvocation({
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

  const turnRequest = buildInspectorTurnRequest(admitted, {
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
      prompt: buildInspectorTransportPrompt(
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
    adapters: inspectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function inspectorAdapters(): PostAdmissionAdapters<AdmittedInspectorInvocation> {
  return {
    trySettle: (admitted, authority) => trySettleInspectorTerminalResult(admitted, authority),
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Inspector run (#633); the session principal reopens.
 */
export async function runPublicInspectorResume(
  request: PublicResumeRequest,
  env: InspectorRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInspectorInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableInspectorRun(
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
  const turnRequest = buildInspectorTurnRequest(admitted, {
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
    adapters: inspectorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
