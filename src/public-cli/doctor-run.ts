/**
 * Public Doctor Role run: admit Issue → retained case via #78 → shared post-admission
 * coordinator → settle Terminal result (#113 / #517). Lifecycle is the shared
 * post-admission seam; this module keeps only Doctor adapters.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitDoctorInvocation,
  buildDoctorTransportPrompt,
  type AdmittedDoctorInvocation,
  type ParseDoctorArgvResult
} from "./invocation.ts";
import {
  runPostAdmissionOneShot,
  type PostAdmissionAdapters,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
} from "./post-admission.ts";
import {
  loadResumableDoctorRun,
  markRunAdmitted,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  presentStructuralRejection,
  trySettleDoctorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import {
  isLawfulTypedTerminalOutcome,
  type TerminalResult,
} from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type DoctorRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
};

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

  await markRunAdmitted(admitted, env.principalAuthority);

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

  return await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: doctorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}

function doctorAdapters(): PostAdmissionAdapters<AdmittedDoctorInvocation> {
  return {
    trySettle: (admitted, authority) => trySettleDoctorTerminalResult(admitted, authority),
    shouldPresentSettled: (terminal) =>
      isLawfulTypedTerminalOutcome(terminal.roleOutcome),
  };
}

/**
 * Resume a previously admitted Doctor run (#633). Issue + retained case
 * identity restore from the durable admitted request; the session principal reopens.
 */
export async function runPublicDoctorResume(
  request: PublicResumeRequest,
  env: DoctorRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedDoctorInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableDoctorRun(
      env.home,
      effective.runId,
      env.principalAuthority,
    ),
    buildTurnRequest: (admitted, effective) =>
      buildDoctorTurnRequest(
      admitted,
      resumeTurnRequestProjectionOptions(admitted, effective, env),
    ),
    adapters: doctorAdapters(),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
