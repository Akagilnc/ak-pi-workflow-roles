/**
 * Shared instruction-seat run (#639 repair seam): gatekeeper and navigator are
 * the same admit → turn-request → post-admission → settle shape, parameterized
 * by seat. Same direction as the settlement one-shot shared skeleton. cli.ts
 * calls this parameterized module directly; no per-seat wrappers.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitGatekeeperInvocation,
  admitNavigatorInvocation,
  buildInstructionTransportPrompt,
  type AdmittedGatekeeperInvocation,
  type AdmittedNavigatorInvocation,
  type ParseInstructionArgvResult,
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
  type PostAdmissionEnv,
} from "./post-admission.ts";
import {
  loadResumableInstructionSeatRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleGatekeeperTerminalResult,
  trySettleNavigatorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type InstructionSeatRole = "gatekeeper" | "navigator";

export type AdmittedInstructionSeatInvocation =
  | AdmittedGatekeeperInvocation
  | AdmittedNavigatorInvocation;

export type InstructionSeatRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

/** Project an admitted instruction-seat invocation onto the host-neutral turn request. */
export function buildInstructionSeatTurnRequest(
  admitted: AdmittedInstructionSeatInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: admitted.role,
      },
    },
    options,
  );
}

function instructionSeatAdapters() {
  return {
    trySettle: (
      admitted: AdmittedInstructionSeatInvocation,
      authority: DurablePrincipalAuthority,
      scope?: { readonly courtAttemptId?: string },
    ) =>
      admitted.role === "gatekeeper"
        ? trySettleGatekeeperTerminalResult(admitted, authority, scope)
        : trySettleNavigatorTerminalResult(admitted, authority, scope),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
  };
}

export async function runPublicInstructionSeatResume(
  request: PublicResumeRequest,
  env: InstructionSeatRunEnv,
  io: CliIo,
): Promise<{ exitCode: number; terminal?: TerminalResult }> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: () => loadResumableInstructionSeatRun(
      env.home,
      request.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: (admitted) => buildInstructionSeatTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, request, env),
    ),
    adapters: instructionSeatAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

export async function runPublicInstructionSeat(
  argv: readonly string[],
  env: InstructionSeatRunEnv,
  io: CliIo,
  role: InstructionSeatRole,
  parseArgv: (args: readonly string[]) => ParseInstructionArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedInstructionSeatInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedInstructionSeatInvocation;
  try {
    const parsed = parseArgv(argv);
    const options = {
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    };
    admitted =
      role === "gatekeeper"
        ? await admitGatekeeperInvocation(options)
        : await admitNavigatorInvocation(options);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  const turnRequest = buildInstructionSeatTurnRequest(admitted, {
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
      prompt: buildInstructionTransportPrompt(
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
    adapters: instructionSeatAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
