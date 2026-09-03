/**
 * Public Navigator Role run (#639): thin instruction-seat binding over the
 * shared admit → turn-request → post-admission → settle seam
 * (instruction-seat-run.ts). Direct command face of the route-advice seat;
 * automatic attendance is unchanged and orthogonal. Manual resume continues
 * the exact session (same law as other roles).
 */
import type { RoleTurnRequest } from "../host-contracts.ts";
import {
  buildInstructionSeatTurnRequest,
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
  type InstructionSeatRunEnv,
} from "./instruction-seat-run.ts";
import type {
  AdmittedNavigatorInvocation,
  ParseNavigatorArgvResult,
} from "./invocation.ts";
import type { PublicResumeRequest } from "./run-lifecycle.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import type { RoleTurnRequestProjectionOptions } from "./turn-request.ts";

export type NavigatorRunEnv = InstructionSeatRunEnv;

/** Project admitted invocation onto the host-neutral turn request. */
export function buildNavigatorTurnRequest(
  admitted: AdmittedNavigatorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return buildInstructionSeatTurnRequest(admitted, options);
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
  return runPublicInstructionSeat(argv, env, io, "navigator", parseNavigatorArgv);
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
  return runPublicInstructionSeatResume(request, env, io, "navigator");
}
