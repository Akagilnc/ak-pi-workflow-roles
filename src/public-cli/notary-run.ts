/**
 * Public Notary Role run: admit source-run locator → explicit Internal activate
 * → settle Terminal result (#448). One-shot; zero caller prompt/attachment.
 * Failure settlement reuses the shared #107 owner.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyEngineChildEnv } from "../engine-detour.ts";
import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  type AdmittedNotaryInvocation,
  type ParseNotaryArgvResult,
} from "./invocation.ts";
import {
  buildSeatModelCliArgs,
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
  markRunAdmitted,
  markRunRunning,
  markRunTerminal,
  RunWriterLeaseHeldError,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  inspectJudgeSession,
  presentFailureTerminal,
  presentStructuralRejection,
  resolveAuditedRunnerKnownFailure,
  explicitInternalKnownFailureClassificationInput,
  settleFailureTerminalResult,
  trySettleNotaryTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult } from "./terminal.ts";

export type NotaryRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  engine?: string;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
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

async function presentControlledFailure(
  admitted: AdmittedNotaryInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: ExplicitInternalKnownFailure;
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedNotaryInvocation;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    failureInput.knownFailure === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...(session === undefined ? {} : { session }),
  });

  await markRunTerminal(admitted.runDirectory).catch(() => undefined);

  const terminal = await settleFailureTerminalResult(admitted, failure);
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

async function dispatchAdmittedNotary(input: {
  admitted: AdmittedNotaryInvocation;
  env: NotaryRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedNotaryInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease, effectiveEngine } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(admitted, missingCredential, io);
    }
    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory,
    };
    applyEngineChildEnv(childEnv, env.engine);
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
        timeoutMs: env.timeoutMs,
        ...(env.piRunner === undefined ? {} : { runner: env.piRunner }),
      });
    } catch (error) {
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

    try {
      await writeFile(
        join(admitted.runDirectory, "stderr.log"),
        result.stderr,
        "utf8",
      );
    } catch {
      // continue to lawful / controlled-failure settlement
    }

    let lawful: TerminalResult | undefined;
    try {
      lawful = await trySettleNotaryTerminalResult(admitted);
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: error,
        },
        io,
      );
    }
    // Accepted receipts and residual incomplete share one present path (collector seam).
    if (lawful !== undefined) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful,
      };
    }

    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result.knownFailure,
      sessionFile: admitted.sessionFile,
      credential: credentialFailure,
      runDirectory: admitted.runDirectory,
    });
    return await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...(knownFailure === undefined ? {} : { knownFailure }),
      },
      io,
    );
  } finally {
    await lease.release();
  }
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

  await markRunAdmitted(admitted);

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic) =>
      io.stderr(diagnostic),
    );
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
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

  return await dispatchAdmittedNotary({
    admitted,
    env,
    io,
    extraArgs,
    lease,
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
