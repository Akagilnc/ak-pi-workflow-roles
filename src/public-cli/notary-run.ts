/**
 * Public Notary Role run: admit source-run locator → shared one-shot dispatch
 * → settle Terminal result (#448). Zero caller prompt/attachment. Lifecycle is
 * the shared Doctor-isomorphic seam; this module keeps only Notary adapters.
 */
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  type AdmittedNotaryInvocation,
  type ParseNotaryArgvResult,
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
  trySettleNotaryTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";

export type NotaryRunEnv = OneShotRunEnv & {
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
};

export function buildNotaryActivationExtraArgs(
  admitted: AdmittedNotaryInvocation,
  options: {
    model?: SeatModelConfig;
    engine?: string;
    packageRoot?: string;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildNotaryTransportPrompt(
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
    "notary",
    "--ak-notary-source-run",
    admitted.sourceRunPath,
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
    prompt,
  ];
}

export async function runPublicNotary(
  argv: readonly string[],
  env: NotaryRunEnv,
  io: CliIo,
  parseNotaryArgv: (args: readonly string[]) => ParseNotaryArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedNotaryInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedNotaryInvocation;
  try {
    const parsed = parseNotaryArgv(argv);
    admitted = await admitNotaryInvocation({
      home: env.home,
      cwd: env.cwd,
      sourceRun: parsed.sourceRun,
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

  const extraArgs = buildNotaryActivationExtraArgs(admitted, {
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
      trySettle: trySettleNotaryTerminalResult,
      // Accepted receipts and failure terminals both present via shared path.
      shouldPresentSettled: () => true,
    },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
