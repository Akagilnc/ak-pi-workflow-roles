/**
 * Public Gleaner-Left Role run: admit (instruction may be empty; --base required)
 * → shared post-admission coordinator → settle Terminal result (#502 / ADR 0067).
 * #599: manual resume continues the exact session; 只上弹章.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitGleanerLeftInvocation,
  buildGleanerLeftTransportPrompt,
  type AdmittedGleanerLeftInvocation,
  type ParseGleanerLeftArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  loadResumableGleanerLeftRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleGleanerLeftTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type GleanerLeftRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildGleanerLeftTurnRequest(
  admitted: AdmittedGleanerLeftInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "gleaner-left" as const,
        baseRevision: admitted.baseRevision,
      },
    },
    options,
  );
}

export async function runPublicGleanerLeft(
  argv: readonly string[],
  env: GleanerLeftRunEnv,
  io: CliIo,
  parseGleanerLeftArgv: (args: readonly string[]) => ParseGleanerLeftArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedGleanerLeftInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedGleanerLeftInvocation;
  try {
    const parsed = parseGleanerLeftArgv(argv);
    admitted = await admitGleanerLeftInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      baseRevision: parsed.baseRevision,
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

  const turnRequest = buildGleanerLeftTurnRequest(admitted, {
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
      prompt: buildGleanerLeftTransportPrompt(
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
    adapters: gleanerLeftAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function gleanerLeftAdapters() {
  return {
    trySettle: (admitted: AdmittedGleanerLeftInvocation, authority: DurablePrincipalAuthority) =>
      trySettleGleanerLeftTerminalResult(admitted, authority),
    shouldPresentSettled: () => true,
  };
}

/**
 * Resume a previously admitted Gleaner-Left run (#599 / DK-3).
 * Restores role/base/session identity; model override is temporary.
 */
export async function runPublicGleanerLeftResume(
  request: PublicResumeRequest,
  env: GleanerLeftRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedGleanerLeftInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: () =>
      loadResumableGleanerLeftRun(
      env.home,
      request.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: (admitted) =>
      buildGleanerLeftTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, request, env),
    ),
    adapters: gleanerLeftAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
