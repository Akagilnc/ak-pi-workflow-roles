/**
 * Public Doctor Role run: admit Issue → retained case via #78 → shared one-shot
 * dispatch → settle Terminal result (#113). Lifecycle is the shared
 * Doctor-isomorphic seam; this module keeps only Doctor adapters.
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
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
  buildSeatModelCliArgs,
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
  extraPiArgs?: readonly string[];
};

/**
 * Build Internal activation extra-args for an admitted Doctor run.
 * Always --no-skills (Doctor forbids every Skill). Session under #78 book.
 * Case path is the retained runs root — never a legacy case packet.
 */
export function buildDoctorActivationExtraArgs(
  admitted: AdmittedDoctorInvocation,
  options: {
    principalAuthority: DurablePrincipalAuthority;
    model?: SeatModelConfig;
    engine?: string;
    packageRoot?: string;
    extraPiArgs?: readonly string[];
  },
): string[] {
  const { sessionFile, sessionDirectory } = decodePiDurablePrincipal(options.principalAuthority, admitted.principal!);
  const prompt = buildDoctorTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions(options),
  );
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    sessionFile,
    "--session-dir",
    sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "doctor",
    "--ak-doctor-case",
    admitted.caseRunsPath,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    prompt,
  ];
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

  const extraArgs = buildDoctorActivationExtraArgs(admitted, {
        principalAuthority: env.principalAuthority,
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await runAdmittedOneShotRole({
    admitted,
    env,
    io,
    extraArgs,
    adapters: {
      trySettle: (admitted) => trySettleDoctorTerminalResult(admitted, env.principalAuthority),
      shouldPresentSettled: (terminal) =>
        isLawfulTypedTerminalOutcome(terminal.roleOutcome),
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
