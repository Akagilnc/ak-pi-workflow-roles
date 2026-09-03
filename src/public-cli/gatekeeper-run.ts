/**
 * Public Gatekeeper Role run (#639): thin instruction-seat binding over the
 * shared admit → turn-request → post-admission → settle seam
 * (instruction-seat-run.ts). Direct command face of the province seat;
 * province dispatch chains stay on the internal gate seam. Manual resume
 * continues the exact session (same law as other roles).
 */
import type { RoleTurnRequest } from "../host-contracts.ts";
import {
  buildInstructionSeatTurnRequest,
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
  type InstructionSeatRunEnv,
} from "./instruction-seat-run.ts";
import type {
  AdmittedGatekeeperInvocation,
  ParseGatekeeperArgvResult,
} from "./invocation.ts";
import type { PublicResumeRequest } from "./run-lifecycle.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";
import type { RoleTurnRequestProjectionOptions } from "./turn-request.ts";

export type GatekeeperRunEnv = InstructionSeatRunEnv;

/** Project admitted invocation onto the host-neutral turn request. */
export function buildGatekeeperTurnRequest(
  admitted: AdmittedGatekeeperInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return buildInstructionSeatTurnRequest(admitted, options);
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
  return runPublicInstructionSeat(argv, env, io, "gatekeeper", parseGatekeeperArgv);
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
  return runPublicInstructionSeatResume(request, env, io, "gatekeeper");
}
