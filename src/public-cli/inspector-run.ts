import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitInspectorInvocation,
  buildInspectorTransportPrompt,
  type AdmittedInspectorInvocation,
  type ParseInspectorArgvResult,
} from "./invocation.ts";
import { buildSeatModelCliArgs, type SeatModelConfig } from "./config.ts";
import { runAdmittedOneShotRole, type OneShotRunEnv } from "./one-shot-dispatch.ts";
import { presentStructuralRejection, trySettleInspectorTerminalResult } from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";

export type InspectorRunEnv = OneShotRunEnv & { createRunId?: () => string; extraPiArgs?: readonly string[] };

export function buildInspectorActivationExtraArgs(
  admitted: AdmittedInspectorInvocation,
  options: { model?: SeatModelConfig; engine?: string; packageRoot?: string; extraPiArgs?: readonly string[] } = {},
): string[] {
  return [
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--session", admitted.sessionFile, "--session-dir", admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []), "--ak-role", "inspector", "--mode", "json",
    ...buildSeatModelCliArgs(options.model),
    buildInspectorTransportPrompt(admitted, engineSessionMaterialFromOptions(options)),
  ];
}

export async function runPublicInspector(
  argv: readonly string[], env: InspectorRunEnv, io: CliIo,
  parse: (args: readonly string[]) => ParseInspectorArgvResult,
): Promise<{ exitCode: number; admitted?: AdmittedInspectorInvocation; terminal?: TerminalResult }> {
  let admitted: AdmittedInspectorInvocation;
  try {
    const parsed = parse(argv);
    admitted = await admitInspectorInvocation({
      home: env.home, cwd: env.cwd, instruction: parsed.instruction, attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
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
  const extraArgs = buildInspectorActivationExtraArgs(admitted, {
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });
  return runAdmittedOneShotRole({
    admitted, env, io, extraArgs,
    adapters: { trySettle: trySettleInspectorTerminalResult, shouldPresentSettled: () => true },
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
