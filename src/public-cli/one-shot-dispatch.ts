import { resolveEnvRoleTurnHost, type LegacyPiRunner } from "./role-turn-env.ts";
/**
 * Shared one-shot public Role dispatch seam (Doctor-isomorphic path).
 * Post-admission lifecycle — mark admitted → writer lease → running → spawn →
 * settle/fail → terminal → release — lives here once. Role runners supply only
 * turn request projection and settlement adapters (ADR 0018 / #448 / #526).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";

import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "../host-contracts.ts";
import type { CredentialProviders, SeatModelConfig } from "./config.ts";
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
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import {
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import type { TerminalResult } from "./terminal.ts";

export type OneShotRunEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  roleTurnHost?: RoleTurnHost;
  /** @deprecated test-legacy; converted by resolveEnvRoleTurnHost */
  piRunner?: LegacyPiRunner;
  extraPiArgs?: readonly string[];
  model?: SeatModelConfig;
  engine?: string;
  credentials?: CredentialProviders;
  timeoutMs?: number;
  principalAuthority: DurablePrincipalAuthority;
};

/**
 * Role-specific settlement hooks. Lifecycle coordination stays in this module.
 * - Doctor: present only lawful typed outcomes; optional compliance-audit secondary.
 * - Notary: present any settled terminal (accepted or failure).
 */
export type OneShotSettlementAdapters<A extends AdmittedRoleInvocation> = {
  trySettle: (admitted: A) => Promise<TerminalResult | undefined>;
  /** Default true. Doctor sets false-filter via predicate. */
  shouldPresentSettled?: (terminal: TerminalResult) => boolean;
  trySettleSecondary?: (admitted: A) => Promise<TerminalResult | undefined>;
};

async function presentControlledFailure<A extends AdmittedRoleInvocation>(
  admitted: A,
  failureInput: {
    timedOut: boolean;
    code: number | null;
    stderr: string;
    thrown?: unknown;
    knownFailure?: RoleTurnKnownFailure;
  },
  authority: DurablePrincipalAuthority,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: A;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    failureInput.knownFailure === undefined
      ? await inspectJudgeSession(decodePiDurablePrincipal(authority, admitted.principal).sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(failureInput.knownFailure),
    ...(session === undefined ? {} : { session }),
  });

  // One-shot roles do not support resume — always terminal.
  await markRunTerminal(admitted.runDirectory).catch(() => undefined);

  const terminal = await settleFailureTerminalResult(admitted, failure, authority);
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

function presentSecondaryTerminal(terminal: TerminalResult, io: CliIo): void {
  if (terminal.roleOutcome.kind === "failure") {
    presentFailureTerminal(terminal, io);
  } else {
    io.stdout(formatTerminalResult(terminal));
  }
}

async function dispatchAdmittedOneShotRole<A extends AdmittedRoleInvocation>(input: {
  admitted: A;
  env: OneShotRunEnv;
  io: CliIo;
  request: RoleTurnRequest;
  lease: RunWriterLease;
  effectiveEngine?: string;
  adapters: OneShotSettlementAdapters<A>;
}): Promise<{
  exitCode: number;
  admitted: A;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, request, lease, effectiveEngine, adapters } = input;
  const shouldPresent =
    adapters.shouldPresentSettled ?? ((_terminal: TerminalResult) => true);
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
      result = await resolveEnvRoleTurnHost(env).executeTurn(request);
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

    let settled: TerminalResult | undefined;
    try {
      settled = await adapters.trySettle(admitted);
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
    if (settled !== undefined && shouldPresent(settled)) {
      await markRunTerminal(admitted.runDirectory).catch(() => undefined);
      io.stdout(formatTerminalResult(settled));
      return {
        exitCode: exitCodeForTerminalOutcome(settled.roleOutcome),
        admitted,
        terminal: settled,
      };
    }

    if (adapters.trySettleSecondary !== undefined) {
      const secondary = await adapters.trySettleSecondary(admitted);
      if (secondary !== undefined) {
        await markRunTerminal(admitted.runDirectory).catch(() => undefined);
        presentSecondaryTerminal(secondary, io);
        return {
          exitCode: exitCodeForTerminalOutcome(secondary.roleOutcome),
          admitted,
          terminal: secondary,
        };
      }
    }

    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const knownFailure = await resolveAuditedRunnerKnownFailure({
      runner: result.knownFailure,
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

/**
 * Shared post-admission one-shot path: durable admitted mark, writer lease,
 * then Doctor-isomorphic dispatch. Role runners call this after role-specific admit.
 */
export async function runAdmittedOneShotRole<A extends AdmittedRoleInvocation>(input: {
  admitted: A;
  env: OneShotRunEnv;
  io: CliIo;
  request: RoleTurnRequest;
  adapters: OneShotSettlementAdapters<A>;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: A;
  terminal?: TerminalResult;
}> {
  const { admitted, env, io, request, adapters, effectiveEngine } = input;
  await markRunAdmitted(admitted, env.principalAuthority);

  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic) =>
      io.stderr(diagnostic),
    );
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2, admitted };
    }
    throw error;
  }

  return await dispatchAdmittedOneShotRole({
    admitted,
    env,
    io,
    request,
    lease,
    adapters,
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
  });
}
