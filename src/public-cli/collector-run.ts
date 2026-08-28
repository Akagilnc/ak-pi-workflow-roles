/**
 * Public Collector Role run: admit a structured PR target → explicit Internal activate
 * → settle Terminal result (#112). One-shot; no resume path (Collector rejects
 * session resume/fork/reload). Failure settlement reuses the #107 shared owner.
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { engineSessionMaterialFromOptions } from "../package-resources/engine-material.ts";
import type {
  MethodBinding,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "../host-contracts.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  admitCollectorInvocation,
  buildCollectorTransportPrompt,
  type AdmittedCollectorInvocation,
  type ParseCollectorArgvResult
} from "./invocation.ts";
import {
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
  principalAuthority: DurablePrincipalAuthority;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  roleTurnHost: RoleTurnHost;
  model?: SeatModelConfig;
  /** Optional labor engine name (config→activation; session material + env signal). */
  engine?: string;
  credentials?: CredentialProviders;
  createRunId?: () => string;
  timeoutMs?: number;
};

import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

/** Project admitted invocation onto the host-neutral turn request. */
export function buildCollectorTurnRequest(
  admitted: AdmittedCollectorInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "collector" as const,
        repo: admitted.repository.display,
        pr: String(admitted.prNumber),
        ...(admitted.requestManifestPath === undefined ? {} : { requestManifestPath: admitted.requestManifestPath }),
      },
    },
    options,
  );
}

async function presentControlledFailure(
  admitted: AdmittedCollectorInvocation,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: RoleTurnKnownFailure;
    knownCause?: ControlledFailureCause;
    knownIdentity?: {
      readonly name?: string;
      readonly code?: string | number;
    };
    knownDiagnostic?: string;
  },
  authority: import("../host-contracts.ts").DurablePrincipalAuthority,
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
      ? await inspectJudgeSession(decodePiDurablePrincipal(authority, admitted.principal).sessionFile)
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

  const terminal = await settleFailureTerminalResult(admitted, failure, authority);
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
  request: RoleTurnRequest;
  lease: RunWriterLease;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: AdmittedCollectorInvocation;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, request, lease, effectiveEngine } = input;
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return await presentControlledFailure(
        admitted,
        missingCredential,
        env.principalAuthority,
        io,
      );
    }
    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine);
    await clearTypedProviderHttpObservation(admitted.runDirectory);

    let result: RoleTurnResult;
    try {
      result = await env.roleTurnHost.executeTurn(request);
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
        },
        env.principalAuthority,
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
      lawful = await trySettleCollectorTerminalResult(admitted, env.principalAuthority);
    } catch (error) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: error,
        },
        env.principalAuthority,
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
      decodePiDurablePrincipal(env.principalAuthority, admitted.principal).sessionFile,
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
      sessionFile: decodePiDurablePrincipal(env.principalAuthority, admitted.principal).sessionFile,
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
      env.principalAuthority,
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
      principalAuthority: env.principalAuthority,
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

  await markRunAdmitted(admitted, env.principalAuthority);

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic) => io.stderr(diagnostic));
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  const turnRequest = buildCollectorTurnRequest(admitted, {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...(env.engine === undefined ? {} : { engine: env.engine }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(admitted.correlationId === undefined && env.correlationId === undefined
      ? {}
      : { correlationId: admitted.correlationId ?? env.correlationId }),
    continuation: {
      kind: "initial",
      prompt: buildCollectorTransportPrompt(admitted, engineSessionMaterialFromOptions({ ...(env.engine === undefined ? {} : { engine: env.engine }), packageRoot: env.packageRoot })),
    },
  });

  return await dispatchAdmittedCollector({
    admitted,
    env,
    io,
    request: turnRequest,
    lease,
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
