/**
 * Public Judge Role run: admit → explicit Internal activate → settle Terminal result.
 * #107: controlled post-admission failures and human decisions settle honestly.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitJudgeInvocation,
  buildJudgeTransportPrompt,
  type AdmittedJudgeInvocation,
} from "./invocation.ts";
import {
  missingPublicProviderCredential,
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  inspectJudgeSession,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  settleJudgeFailureTerminalResult,
  trySettleJudgeTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type JudgeRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  /** Effective judge seat model (persistent/startup/invocation). */
  model?: SeatModelConfig;
  /**
   * Credential presence for public providers (auth.json shape).
   * Used as the production-owned typed channel when a selected public provider
   * has no configured credential — never inferred from child stderr prose.
   */
  credentials?: CredentialProviders;
  createRunId?: () => string;
  /** Extra Pi args inserted before the prompt (tests: faux provider extension). */
  extraPiArgs?: readonly string[];
  /** Override default role-run timeout. */
  timeoutMs?: number;
};

/**
 * Production-owned provider failure when the selected public seat provider has
 * no configured credential. Cause/identity come from CredentialProviders, not
 * stderr wording. Runner-supplied knownFailure still wins over this annotation.
 */
export function knownFailureForMissingProviderCredential(
  model: SeatModelConfig | undefined,
  credentials: CredentialProviders | undefined,
): ExplicitInternalKnownFailure | undefined {
  if (model === undefined || credentials === undefined) return undefined;
  if (!missingPublicProviderCredential(model.provider, credentials)) {
    return undefined;
  }
  return {
    cause: "provider",
    identity: {
      name: "MissingProviderCredential",
      code: model.provider,
    },
  };
}

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

async function presentControlledFailure(
  admitted: AdmittedJudgeInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownCause?: ControlledFailureCause;
    knownIdentity?: {
      readonly name?: string;
      readonly code?: string | number;
    };
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedJudgeInvocation;
  terminal: TerminalResult;
}> {
  const session =
    failureInput.thrown === undefined &&
    !failureInput.timedOut &&
    failureInput.knownCause === undefined
      ? await inspectJudgeSession(admitted.sessionDirectory)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(failureInput.thrown === undefined ? {} : { thrown: failureInput.thrown }),
    ...(failureInput.knownCause === undefined
      ? {}
      : { knownCause: failureInput.knownCause }),
    ...(failureInput.knownIdentity === undefined
      ? {}
      : { knownIdentity: failureInput.knownIdentity }),
    ...(session === undefined ? {} : { session }),
  });
  const terminal = await settleJudgeFailureTerminalResult(admitted, failure);
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
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
): Promise<{
  exitCode: number;
  admitted?: AdmittedJudgeInvocation;
  terminal?: TerminalResult;
}> {
  // Structural parse/admit rejects before model dispatch via shared settlement presenter.
  let admitted: AdmittedJudgeInvocation;
  try {
    const parsed = parseJudgeArgv(argv);
    admitted = await admitJudgeInvocation({
      home: env.home,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

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

  let result: ExplicitInternalPiResult;
  try {
    result = await runExplicitInternalActivation({
      packageRoot: env.packageRoot,
      extraArgs,
      cwd: admitted.projectRoot,
      home: env.home,
      agentDir: env.agentDir,
      env: childEnv,
      ...(env.timeoutMs === undefined
        ? { timeoutMs: 600_000 }
        : { timeoutMs: env.timeoutMs }),
      ...(env.piRunner === undefined ? {} : { runner: env.piRunner }),
    });
  } catch (error) {
    // Post-admission exception — retain production-typed or actual diagnostic identity.
    return await presentControlledFailure(
      admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
      },
      io,
    );
  }

  await writeFile(
    join(admitted.runDirectory, "stderr.log"),
    result.stderr,
    "utf8",
  );

  // Prefer a lawful typed terminal result from the session even when the child
  // exit is nonzero — infrastructure noise must not wash a completed outcome.
  const lawful = await trySettleJudgeTerminalResult(admitted);
  if (lawful !== undefined && isLawfulTypedTerminalOutcome(lawful.roleOutcome)) {
    io.stdout(formatTerminalResult(lawful));
    return {
      exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
      admitted,
      terminal: lawful,
    };
  }

  // Production-owned typed cause channel — runner result first, else credential
  // absence for the selected public provider on a failed child. Never inferred
  // from stderr wording. Zero-exit missing-terminal stays session/output.
  const credentialFailure =
    result.timedOut || result.code !== 0
      ? knownFailureForMissingProviderCredential(env.model, env.credentials)
      : undefined;
  const knownFailure = result.knownFailure ?? credentialFailure;
  return await presentControlledFailure(
    admitted,
    {
      timedOut: result.timedOut,
      code: result.code,
      stderr: result.stderr,
      ...(knownFailure === undefined
        ? {}
        : {
            knownCause: knownFailure.cause,
            ...(knownFailure.identity === undefined
              ? {}
              : { knownIdentity: knownFailure.identity }),
          }),
    },
    io,
  );
}

