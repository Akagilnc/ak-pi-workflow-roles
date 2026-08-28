/**
 * Public Doctor Role run: admit Issue → retained case via #78 → shared one-shot
 * dispatch → settle Terminal result (#113). Lifecycle is the shared
 * Doctor-isomorphic seam; this module keeps only Doctor adapters.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitDoctorInvocation,
  buildDoctorTransportPrompt,
  type AdmittedDoctorInvocation,
  type ParseDoctorArgvResult
} from "./invocation.ts";
import {
  type SeatModelConfig,
} from "./config.ts";
import {
  runAdmittedOneShotRole,
  type OneShotRunEnv,
} from "./one-shot-dispatch.ts";
import {
  presentStructuralRejection,
  trySettleDoctorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import {
  isLawfulTypedTerminalOutcome,
  type TerminalResult,
} from "./terminal.ts";

export type DoctorRunEnv = OneShotRunEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

/** Project admitted invocation onto the host-neutral turn request. */
export function buildDoctorTurnRequest(
  admitted: AdmittedDoctorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: { role: "doctor" as const, casePath: admitted.caseRunsPath },
    },
    options,
  );
}

export async function runPublicDoctor(
  argv: readonly string[],
  env: DoctorRunEnv,
  io: CliIo,
  parseDoctorArgv: (args: readonly string[]) => ParseDoctorArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedDoctorInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedDoctorInvocation;
  try {
    const parsed = parseDoctorArgv(argv);
    admitted = await admitDoctorInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      issueNumber: parsed.issueNumber,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.runs === undefined ? {} : { runs: parsed.runs }),
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

  const turnRequest = buildDoctorTurnRequest(admitted, {
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
      prompt: buildDoctorTransportPrompt(admitted, engineSessionMaterialFromOptions({ ...(env.engine === undefined ? {} : { engine: env.engine }), packageRoot: env.packageRoot })),
    },
  });

  return await runAdmittedOneShotRole({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: {
      trySettle: (admitted) => trySettleDoctorTerminalResult(admitted, env.principalAuthority),
      shouldPresentSettled: (terminal) =>
        isLawfulTypedTerminalOutcome(terminal.roleOutcome),
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
