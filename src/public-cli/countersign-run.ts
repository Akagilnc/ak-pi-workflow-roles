/**
 * Public Countersign Role run: admit ticket materials → shared one-shot dispatch
 * → settle Terminal result (#572 / ADR 0074). One-shot: 署/封驳/上呈，无 resume。
 */
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCountersignInvocation,
  buildCountersignTransportPrompt,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
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
  trySettleCountersignTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";

export type CountersignRunEnv = OneShotRunEnv & {
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
};

export function buildCountersignActivationExtraArgs(
  admitted: AdmittedCountersignInvocation,
  options: {
    model?: SeatModelConfig;
    engine?: string;
    packageRoot?: string;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildCountersignTransportPrompt(
    admitted,
    engineSessionMaterialFromOptions(options),
  );
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    admitted.sessionFile,
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "countersign",
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    prompt,
  ];
}

export async function runPublicCountersign(
  argv: readonly string[],
  env: CountersignRunEnv,
  io: CliIo,
  parseCountersignArgv: (args: readonly string[]) => ParseCountersignArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCountersignInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedCountersignInvocation;
  try {
    const parsed = parseCountersignArgv(argv);
    admitted = await admitCountersignInvocation({
      home: env.home,
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

  const extraArgs = buildCountersignActivationExtraArgs(admitted, {
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
      trySettle: trySettleCountersignTerminalResult,
      // Accepted receipts and failure terminals both present via shared path.
      shouldPresentSettled: () => true,
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
