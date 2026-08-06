/**
 * Public Judge Role run: admit → explicit Internal activate → settle Terminal result.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runExplicitInternalActivation,
  type ExplicitInternalPiRunner,
} from "./explicit-internal.ts";
import {
  admitJudgeInvocation,
  buildJudgeTransportPrompt,
  type AdmittedJudgeInvocation,
} from "./invocation.ts";
import type { SeatModelConfig } from "./config.ts";
import {
  formatTerminalResult,
  settleJudgeTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";

export type JudgeRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  /** Effective judge seat model (persistent/startup/invocation). */
  model?: SeatModelConfig;
  createRunId?: () => string;
  /** Extra Pi args inserted before the prompt (tests: faux provider extension). */
  extraPiArgs?: readonly string[];
  /** Override default role-run timeout. */
  timeoutMs?: number;
};

function buildModelArgs(model: SeatModelConfig | undefined): string[] {
  if (model === undefined) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    "--thinking",
    model.thinking,
  ];
}

/**
 * Build Internal activation extra-args for an admitted Judge run
 * (everything after `--no-extensions -e <entrypoint>`).
 * No public burden selector. Session placed under the #78 ledger book.
 */
export function buildJudgeActivationExtraArgs(
  admitted: AdmittedJudgeInvocation,
  options: {
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildJudgeTransportPrompt(admitted);
  return [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session-dir",
    admitted.sessionDirectory,
    ...(options.extraPiArgs ?? []),
    "--ak-role",
    "judge",
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    prompt,
  ];
}

export async function runPublicJudge(
  argv: readonly string[],
  env: JudgeRunEnv,
  io: CliIo,
  parseJudgeArgv: (args: readonly string[]) => {
    instruction: string;
    attachmentPaths: string[];
    project?: string;
  },
): Promise<{ exitCode: number; admitted?: AdmittedJudgeInvocation }> {
  const parsed = parseJudgeArgv(argv);
  const admitted = await admitJudgeInvocation({
    home: env.home,
    cwd: env.cwd,
    instruction: parsed.instruction,
    attachmentPaths: parsed.attachmentPaths,
    ...(parsed.project === undefined ? {} : { project: parsed.project }),
    ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
  });

  const extraArgs = buildJudgeActivationExtraArgs(admitted, {
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: env.home,
    PI_CODING_AGENT_DIR: env.agentDir,
    // Public-run marker so Navigator work context prefers admitted instruction.
    AK_ROLE_RUN_DIR: admitted.runDirectory,
  };
  if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
    childEnv.AK_CORRELATION_ID = env.correlationId;
  }

  const result = await runExplicitInternalActivation({
    packageRoot: env.packageRoot,
    extraArgs,
    cwd: admitted.projectRoot,
    home: env.home,
    agentDir: env.agentDir,
    env: childEnv,
    ...(env.timeoutMs === undefined ? { timeoutMs: 600_000 } : { timeoutMs: env.timeoutMs }),
    ...(env.piRunner === undefined ? {} : { runner: env.piRunner }),
  });

  await writeFile(
    join(admitted.runDirectory, "stderr.log"),
    result.stderr,
    "utf8",
  );

  if (result.timedOut) {
    io.stderr("ak-role: judge role run timed out\n");
    return { exitCode: 1, admitted };
  }
  if (result.code !== 0) {
    const last =
      result.stderr.trim() === ""
        ? ""
        : `: ${result.stderr.trim().split("\n").at(-1)}`;
    io.stderr(`ak-role: judge role run failed${last}\n`);
    return { exitCode: 1, admitted };
  }

  try {
    const terminal = await settleJudgeTerminalResult(admitted);
    io.stdout(formatTerminalResult(terminal));
    return { exitCode: 0, admitted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`ak-role: ${message}\n`);
    return { exitCode: 1, admitted };
  }
}
