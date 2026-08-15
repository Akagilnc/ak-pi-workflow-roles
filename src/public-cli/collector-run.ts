/**
 * Public Collector Role run: admit a structured PR target → explicit Internal activate
 * → settle Terminal result (#112). One-shot; no resume path (Collector rejects
 * session resume/fork/reload). Failure settlement reuses the #107 shared owner.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import {
  runExplicitInternalActivation,
  type ExplicitInternalKnownFailure,
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
  explicitInternalKnownFailureClassificationInput,
  readCollectorInfrastructureFailure,
  resolveAuditedRunnerKnownFailure,
  settleFailureTerminalResult,
  trySettleCollectorTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ControlledFailureCause,
  TerminalResult,
} from "./terminal.ts";

export type CollectorRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  piRunner?: ExplicitInternalPiRunner;
  model?: SeatModelConfig;
  /** Optional labor engine name (config→activation; session material only). */
  engine?: string;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
};


/**
 * Build Internal activation extra-args for an admitted Collector run.
 * Always --no-skills (Collector forbids every Skill). Session under #78 book.
 */
export function buildCollectorActivationExtraArgs(
  admitted: AdmittedCollectorInvocation,
  options: {
    model?: SeatModelConfig;
    engine?: string;
    packageRoot?: string;
    extraPiArgs?: readonly string[];
  } = {},
): string[] {
  const prompt = buildCollectorTransportPrompt(
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
    "collector",
    "--ak-collector-repo",
    admitted.repository.display,
    "--ak-collector-pr",
    String(admitted.prNumber),
    ...(admitted.requestManifestPath === undefined
      ? []
      : ["--ak-collector-request-manifest", admitted.requestManifestPath]),
    "--mode",
    "json",
    ...buildSeatModelCliArgs(options.model),
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
    knownFailure?: ExplicitInternalKnownFailure;
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
    failureInput.knownFailure === undefined &&
    failureInput.knownCause === undefined
      ? await inspectJudgeSession(admitted.sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
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
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        io,
      );
    }
    await markRunRunning(admitted.runDirectory, env.model);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: env.home,
      PI_CODING_AGENT_DIR: env.agentDir,
      AK_ROLE_RUN_DIR: admitted.runDirectory,
    };
    const correlationId = admitted.correlationId ?? env.correlationId;
    if (correlationId !== undefined && correlationId.trim() !== "") {
      childEnv.AK_CORRELATION_ID = correlationId;
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
    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner:
        result.knownFailure ??
        (infrastructureFailure === undefined
          ? undefined
          : {
              cause: infrastructureFailure.cause,
              diagnostic: infrastructureFailure.diagnostic,
              ...(infrastructureFailure.identity === undefined
                ? {}
                : { identity: infrastructureFailure.identity }),
            }),
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
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
      ...(parsed.requestManifestPath === undefined ? {} : { requestManifestPath: parsed.requestManifestPath }),
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
    packageRoot: env.packageRoot,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
  });

  return await dispatchAdmittedCollector({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    extraArgs,
    lease,
  });
}
