/**
 * Public Gatekeeper Role run (#639): admit instruction materials → shared
 * post-admission coordinator → settle Terminal result. Direct command face of
 * the province seat; province dispatch chains stay on the internal gate seam.
 * Manual resume continues the exact session (same law as other roles).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitGatekeeperInvocation,
  buildGatekeeperTransportPrompt,
  type AdmittedGatekeeperInvocation,
  type ParseGatekeeperArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionManualResume,
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  loadResumableGatekeeperRun,
  markRunAdmitted,
  buildResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleGatekeeperTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type GatekeeperRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildGatekeeperTurnRequest(
  admitted: AdmittedGatekeeperInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "gatekeeper" as const,
      },
    },
    options,
  );
}

export async function runPublicGatekeeper(
  argv: readonly string[],
  env: GatekeeperRunEnv,
  io: CliIo,
  parseGatekeeperArgv: (args: readonly string[]) => ParseGatekeeperArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedGatekeeperInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedGatekeeperInvocation;
  try {
    const parsed = parseGatekeeperArgv(argv);
    admitted = await admitGatekeeperInvocation({
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

  const turnRequest = buildGatekeeperTurnRequest(admitted, {
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
      prompt: buildGatekeeperTransportPrompt(
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
    adapters: gatekeeperAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function gatekeeperAdapters() {
  return {
    trySettle: (admitted: AdmittedGatekeeperInvocation, authority: DurablePrincipalAuthority) =>
      trySettleGatekeeperTerminalResult(admitted, authority),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Gatekeeper run (#639 / DK-3).
 * Restores role/attachments/session identity; seat axes follow the live table.
 */
export async function runPublicGatekeeperResume(
  request: PublicResumeRequest,
  env: GatekeeperRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedGatekeeperInvocation;
  terminal?: TerminalResult;
}> {
  let loaded;
  try {
    loaded = await loadResumableGatekeeperRun(
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
  const turnRequest = buildGatekeeperTurnRequest(admitted, {
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
    adapters: gatekeeperAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
