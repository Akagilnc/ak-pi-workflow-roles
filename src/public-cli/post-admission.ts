/**
 * Unified post-admission Role lifecycle coordinator (stages ③–⑤; ADR 0018 / #505 / #517 / #526).
 * Post-admission lifecycle — mark admitted → writer lease → running → ③ dispatch →
 * ④ tool loop / gates → ⑤ settle / fail → terminal → release — lives here as the sole owner.
 * Role runners supply only turn request projection and narrow settlement adapters.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePiDurablePrincipal } from "../pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../pi/role-turn-host.ts";

import type {
  ControlledFailureCause,
  DurablePrincipal,
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
  SessionCustomEntryAppender,
} from "../host-contracts.ts";
import type { CredentialProviders, SeatModelConfig } from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
  isV1ResumableFailure,
  markRunAdmitted,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  renderResumeCommand,
  RunWriterLeaseHeldError,
  type RunWriterLease,
  type TypedProviderHttpObservation,
} from "./run-lifecycle.ts";
import {
  classifyPostAdmissionFailure,
  controlledFailureInputFromResolution,
  exitCodeForTerminalOutcome,
  explicitInternalKnownFailureClassificationInput,
  formatCliDiagnostic,
  formatTerminalResult,
  inspectJudgeSession,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  resolveAuditedRunnerFailureResolution,
  resolveControlledFailureResumeObservation,
  settleFailureTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { AdmittedRoleInvocation } from "./invocation.ts";
import {
  type TerminalResult,
} from "./terminal.ts";
import { runWithAutoResumeLoop } from "./auto-resume.ts";

export type PostAdmissionEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  roleTurnHost: RoleTurnHost;
  model?: SeatModelConfig;
  engine?: string;
  credentials?: CredentialProviders;
  timeoutMs?: number;
  principalAuthority: DurablePrincipalAuthority;
  sessionAppender?: SessionCustomEntryAppender;
  autoResumeLimit?: number;
  createRunId?: () => string;
};

/**
 * Role-specific settlement hooks and failure resolvers.
 * Lifecycle coordination stays in this coordinator module.
 */
export type PostAdmissionAdapters<
  A extends AdmittedRoleInvocation = AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
> = {
  trySettle: (admitted: A, authority: DurablePrincipalAuthority) => Promise<T | undefined>;
  /** Default: isLawfulTypedTerminalOutcome(terminal.roleOutcome). */
  shouldPresentSettled?: (terminal: T) => boolean;
  trySettleSecondary?: (admitted: A, authority: DurablePrincipalAuthority) => Promise<TerminalResult | undefined>;
  resolveRunnerKnownFailure?: (input: {
    result: RoleTurnResult;
    sessionFile: string;
  }) => Promise<RoleTurnKnownFailure | undefined>;
  hasLawfulTerminalResult?: (admitted: A, authority: DurablePrincipalAuthority) => Promise<boolean>;
  isResumableRole?: boolean;
  beforeDispatch?: (admitted: A) => Promise<void> | void;
};

export type ControlledFailureInput = {
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
  typedHttpObservationSettled?: true;
  typedHttpObservation?: TypedProviderHttpObservation;
};

export async function presentControlledFailure<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(
  admitted: A,
  failureInput: ControlledFailureInput,
  adapters: PostAdmissionAdapters<A, T>,
  authority: DurablePrincipalAuthority,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted: A;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const resumeObservation = await resolveControlledFailureResumeObservation({
    runDirectory: admitted.runDirectory,
    ...(failureInput.typedHttpObservationSettled === true
      ? {
        typedHttpObservationSettled: true as const,
        ...(failureInput.typedHttpObservation === undefined
          ? {}
          : { typedHttpObservation: failureInput.typedHttpObservation }),
      }
      : {}),
  });
  const knownFailure =
    failureInput.knownFailure ?? resumeObservation.observationReadFailure;
  const session =
    !hasThrown &&
    !failureInput.timedOut &&
    knownFailure === undefined &&
    failureInput.knownCause === undefined &&
    admitted.principal !== undefined
      ? await inspectJudgeSession(decodePiDurablePrincipal(authority, admitted.principal).sessionFile)
      : undefined;
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...explicitInternalKnownFailureClassificationInput(knownFailure),
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

  let resumable = false;
  const typedHttp429 = resumeObservation.typedHttp429;
  if (adapters.isResumableRole === true && admitted.principal !== undefined) {
    const sessionPrincipalAvailable = await authority.isAvailable(admitted.principal);
    const hasLawful = adapters.hasLawfulTerminalResult !== undefined
      ? await adapters.hasLawfulTerminalResult(admitted, authority)
      : false;
    resumable =
      sessionPrincipalAvailable &&
      isV1ResumableFailure({
        hasLawfulTerminalResult: hasLawful,
        ...(typedHttp429 === undefined ? {} : { typedHttp429 }),
      });
  }

  if (resumable && typedHttp429 !== undefined) {
    await markRunResumable(admitted.runDirectory, typedHttp429);
  } else {
    await markRunTerminal(admitted.runDirectory).catch(() => undefined);
  }

  const terminal = await settleFailureTerminalResult(
    admitted,
    failure,
    authority,
    resumable
      ? { resume: { command: renderResumeCommand(admitted.runId) } }
      : {},
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

function presentSecondaryTerminal(terminal: TerminalResult, io: CliIo): void {
  if (terminal.roleOutcome.kind === "failure" || terminal.roleOutcome.kind === "no_receipt") {
    presentFailureTerminal(terminal, io);
  } else {
    io.stdout(formatTerminalResult(terminal));
  }
}

export async function dispatchPostAdmissionTurn<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  request: RoleTurnRequest;
  lease: RunWriterLease;
  adapters: PostAdmissionAdapters<A, T>;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted: A;
  terminal?: T;
}> {
  const { admitted, env, io, request, lease, adapters, effectiveEngine } = input;
  const shouldPresent =
    adapters.shouldPresentSettled ?? ((terminal: T) => isLawfulTypedTerminalOutcome(terminal.roleOutcome));
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return (await presentControlledFailure(
        admitted,
        missingCredential,
        adapters,
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: A; terminal: T };
    }
    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    if (adapters.beforeDispatch !== undefined) {
      await adapters.beforeDispatch(admitted);
    }

    let result: RoleTurnResult;
    try {
      result = await env.roleTurnHost.executeTurn(request);
    } catch (error) {
      return (await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: error,
        },
        adapters,
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: A; terminal: T };
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

    let settled: T | undefined;
    try {
      settled = await adapters.trySettle(admitted, env.principalAuthority);
    } catch (error) {
      return (await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: error,
        },
        adapters,
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: A; terminal: T };
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
      const secondary = await adapters.trySettleSecondary(admitted, env.principalAuthority);
      if (secondary !== undefined) {
        await markRunTerminal(admitted.runDirectory).catch(() => undefined);
        presentSecondaryTerminal(secondary, io);
        return {
          exitCode: exitCodeForTerminalOutcome(secondary.roleOutcome),
          admitted,
          terminal: secondary as unknown as T,
        };
      }
    }

    const sessionFile =
      admitted.principal !== undefined
        ? decodePiDurablePrincipal(env.principalAuthority, admitted.principal).sessionFile
        : "";
    const runnerKnownFailure =
      adapters.resolveRunnerKnownFailure !== undefined && sessionFile !== ""
        ? await adapters.resolveRunnerKnownFailure({ result, sessionFile })
        : result.knownFailure;
    const credentialFailure = postRunMissingCredentialFailure(
      result,
      env.model,
      env.credentials,
    );
    const resolution = await resolveAuditedRunnerFailureResolution({
      runner: runnerKnownFailure,
      sessionFile,
      credential: credentialFailure,
      runDirectory: admitted.runDirectory,
    });
    return (await presentControlledFailure(
      admitted,
      {
        timedOut: result.timedOut,
        code: result.code,
        stderr: result.stderr,
        ...controlledFailureInputFromResolution(resolution),
      },
      adapters,
      env.principalAuthority,
      io,
    )) as { exitCode: number; admitted: A; terminal: T };
  } finally {
    await lease.release();
  }
}

/**
 * Shared post-admission one-shot path: durable admitted mark, writer lease,
 * then turn dispatch. Role runners call this after role-specific admit.
 */
export async function runPostAdmissionOneShot<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  request: RoleTurnRequest;
  adapters: PostAdmissionAdapters<A, T>;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted?: A;
  terminal?: T;
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

  return await dispatchPostAdmissionTurn({
    admitted,
    env,
    io,
    request,
    lease,
    adapters,
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
  });
}

/**
 * Shared post-admission resumable path with auto-resume retry loop.
 */
export async function runPostAdmissionResumable<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  buildInitialRequest: () => RoleTurnRequest;
  buildResumeRequest: () => RoleTurnRequest;
  adapters: PostAdmissionAdapters<A, T>;
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted?: A;
  terminal?: T;
}> {
  const { admitted, env, io, buildInitialRequest, buildResumeRequest, adapters, effectiveEngine } = input;
  await markRunAdmitted(admitted, env.principalAuthority);

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    io,
    sessionAppender: env.sessionAppender ?? appendPiSessionCustomEntry,
    autoResumeLimit: env.autoResumeLimit,
    buildInitialPayload: buildInitialRequest,
    buildResumePayload: buildResumeRequest,
    dispatch: (request, lease, isFirst, attemptIo) =>
      dispatchPostAdmissionTurn({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        request,
        lease,
        adapters,
        ...(isFirst && effectiveEngine !== undefined ? { effectiveEngine } : {}),
      }),
  });
}

/**
 * Shared post-admission manual resume path: acquire writer lease and dispatch turn.
 */
export async function runPostAdmissionManualResume<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  request: RoleTurnRequest;
  adapters: PostAdmissionAdapters<A, T>;
}): Promise<{
  exitCode: number;
  admitted?: A;
  terminal?: T;
}> {
  const { admitted, env, io, request, adapters } = input;
  let lease: RunWriterLease;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic) => io.stderr(diagnostic));
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      return { exitCode: 1 };
    }
    throw error;
  }

  const result = await dispatchPostAdmissionTurn({
    admitted,
    env: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    request,
    lease,
    adapters,
  });
  if (result.terminal !== undefined) {
    (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  }
  return result;
}
