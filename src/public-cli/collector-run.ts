/**
 * Public Collector Role run: admit structured PR/legs → explicit Internal activate
 * → settle Terminal result (#112). One-shot; no resume path (Collector rejects
 * session resume/fork/reload). Failure settlement reuses the #107 shared owner.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  knownFailureFromProviderStop,
  runExplicitInternalActivation,
  type ExplicitInternalPiRunner,
  type ExplicitInternalPiResult,
} from "./explicit-internal.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCollectorInvocation,
  buildCollectorTransportPrompt,
  type AdmittedCollectorInvocation,
  type ParseCollectorArgvResult,
} from "./invocation.ts";
import {
  type CredentialProviders,
  type SeatModelConfig,
} from "./config.ts";
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
  readCollectorInfrastructureFailure,
  readSessionProviderStop,
  settleFailureTerminalResult,
  trySettleCollectorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";
import { knownFailureForMissingProviderCredential } from "./judge-run.ts";

export type CollectorRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
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
 * Build Internal activation extra-args for an admitted Collector run.
 * Always --no-skills (Collector forbids every Skill). Session under #78 book.
 */
export function buildCollectorActivationExtraArgs(
  admitted: AdmittedCollectorInvocation,
  options: {
    model?: SeatModelConfig;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildCollectorTransportPrompt(admitted);
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
    "collector",
    "--ak-collector-repo",
    admitted.repository.display,
    "--ak-collector-pr",
    String(admitted.prNumber),
    "--ak-collector-legs",
    admitted.legsPath,
    "--mode",
    "json",
    ...buildModelArgs(options.model),
    prompt,
  ];
}

async function presentControlledFailure(
  admitted: AdmittedCollectorInvocation,
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
    knownDiagnostic?: string;
  },
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: AdmittedCollectorInvocation;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    failureInput.knownCause === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...(failureInput.knownCause === undefined
      ? {}
      : { knownCause: failureInput.knownCause }),
    ...(failureInput.knownIdentity === undefined
      ? {}
      : { knownIdentity: failureInput.knownIdentity }),
    ...(failureInput.knownDiagnostic === undefined
      ? {}
      : { knownDiagnostic: failureInput.knownDiagnostic }),
    ...(session === undefined ? {} : { session }),
  });

  // Collector does not support resume/fork/reload — always terminal.
  await markRunTerminal(admitted.runDirectory).catch(() => undefined);

  const terminal = await settleFailureTerminalResult(admitted, failure);
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

async function dispatchAdmittedCollector(input: {
  admitted: AdmittedCollectorInvocation;
  env: CollectorRunEnv;
  io: CliIo;
  extraArgs: string[];
  lease: RunWriterLease;
}): Promise<{
  exitCode: number;
  admitted: AdmittedCollectorInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, extraArgs, lease } = input;
  try {
    await markRunRunning(admitted.runDirectory);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory,
    };
    if (env.correlationId !== undefined && env.correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = env.correlationId;
    }

    let result: ExplicitInternalPiResult;
    try {
      result = await runExplicitInternalActivation({
        runtime: admitted.runtime,
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
      lawful = await trySettleCollectorTerminalResult(admitted);
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
    if (lawful !== undefined) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      io.stdout(formatTerminalResult(lawful));
      return {
        exitCode: exitCodeForTerminalOutcome(lawful.roleOutcome),
        admitted,
        terminal: lawful,
      };
    }

    // Prefer Collector infrastructure tool failure already on the session principal
    // (e.g. observe HTTP 404) over a later secondary provider-stop after abort.
    const infrastructureFailure = await readCollectorInfrastructureFailure(
      admitted.sessionFile,
    );
    const sessionProviderStop = await readSessionProviderStop(
      admitted.sessionFile,
    );
    const sessionProviderFailure =
      sessionProviderStop === undefined
        ? undefined
        : knownFailureFromProviderStop(sessionProviderStop);
    const credentialFailure =
      result.timedOut || result.code !== 0
        ? knownFailureForMissingProviderCredential(env.model, env.credentials)
        : undefined;
    const knownFailure =
      result.knownFailure ??
      (infrastructureFailure === undefined
        ? undefined
        : {
            cause: infrastructureFailure.cause,
            diagnostic: infrastructureFailure.diagnostic,
            ...(infrastructureFailure.identity === undefined
              ? {}
              : { identity: infrastructureFailure.identity }),
          }) ??
      sessionProviderFailure ??
      credentialFailure;
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
              ...(knownFailure.diagnostic === undefined
                ? {}
                : { knownDiagnostic: knownFailure.diagnostic }),
            }),
      },
      io,
    );
  } finally {
    await lease.release();
  }
}

export async function runPublicCollector(
  argv: readonly string[],
  env: CollectorRunEnv,
  io: CliIo,
  parseCollectorArgv: (args: readonly string[]) => ParseCollectorArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCollectorInvocation;
  terminal?: TerminalResult;
}> {
  let admitted: AdmittedCollectorInvocation;
  try {
    const parsed = parseCollectorArgv(argv);
    admitted = await admitCollectorInvocation({
      home: env.home,
      cwd: env.cwd,
      prNumber: parsed.prNumber,
      legs: parsed.legs,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
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
    lease = await acquireRunWriterLease(admitted.runDirectory);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const extraArgs = buildCollectorActivationExtraArgs(admitted, {
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedCollector({
    admitted,
    env,
    io,
    extraArgs,
    lease,
  });
}
