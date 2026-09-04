/**
 * Unified post-admission Role lifecycle coordinator (stages ③–⑤; ADR 0018 / #505 / #517 / #526).
 * Owns writer lease → running → ③ dispatch → ④ tool loop / gates → ⑤ settle / fail →
 * terminal → release. The durable admitted mark (markRunAdmitted) is owned by the
 * initial role facades before entering; manual resume never re-admits.
 * Role runners supply only turn request projection and narrow settlement adapters.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
import { projectHostTransitionPriorNative } from "../host-transition-prior-native.ts";
import type { CredentialProviders, SeatModelConfig } from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
  isV1ResumableFailure,
  markRunResumable,
  markRunRunning,
  markRunTerminal,
  renderResumeCommand,
  RunWriterLeaseHeldError,
  type RunWriterLease,
  type TypedProviderHttpObservation,
  type WriterLeaseDiagnosticKind,
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

/** Previous main-session host recorded on invocation.json, if any. */
async function readInvocationHost(runDirectory: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(runDirectory, "invocation.json"), "utf8")) as {
      host?: unknown;
    };
    return typeof raw.host === "string" && raw.host.trim() !== "" ? raw.host : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export type PostAdmissionEnv = {
  home: string;
  agentDir: string;
  packageRoot: string;
  cwd: string;
  correlationId?: string;
  roleTurnHost: RoleTurnHost;
  model?: SeatModelConfig;
  engine?: string;
  /** Effective main-session host for this run (#595 admission / #617 resume seat). */
  host?: string;
  credentials?: CredentialProviders;
  timeoutMs?: number;
  principalAuthority: DurablePrincipalAuthority;
  sessionAppender: SessionCustomEntryAppender;
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
      ? await inspectJudgeSession(authority.decode(admitted.principal).sessionFile)
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
    await markRunTerminal(admitted.runDirectory);
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
    // #617 DK-4: capture previous invocation host before markRunRunning overwrites it.
    // Single authority projectHostTransitionPriorNative owns known-host prior native paths.
    const previousHost = await readInvocationHost(admitted.runDirectory);
    const liveHost = env.host;
    const hostTransition =
      previousHost !== undefined && liveHost !== undefined && admitted.principal !== undefined
        ? await projectHostTransitionPriorNative({
            previousHost,
            liveHost,
            runDirectory: admitted.runDirectory,
            piSessionFile: env.principalAuthority.decode(admitted.principal).sessionFile,
          })
        : undefined;
    const turnRequest: RoleTurnRequest =
      hostTransition === undefined ? request : { ...request, hostTransition };

    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine, env.host);
    await clearTypedProviderHttpObservation(admitted.runDirectory);
    // beforeDispatch (e.g. countersign diarist station) runs after running is
    // marked — its failures must settle the run, not leave it permanently running.
    if (adapters.beforeDispatch !== undefined) {
      try {
        await adapters.beforeDispatch(admitted);
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
    }

    let result: RoleTurnResult;
    try {
      result = await env.roleTurnHost.executeTurn(turnRequest);
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
      await markRunTerminal(admitted.runDirectory);
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
        await markRunTerminal(admitted.runDirectory);
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
        ? env.principalAuthority.decode(admitted.principal).sessionFile
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
 * Shared post-admission one-shot path: writer lease, then turn dispatch.
 * Initial facades own the durable admitted mark (markRunAdmitted) before
 * entering; manual resume never re-admits.
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
 * Initial facades own the durable admitted mark before entering.
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

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    io,
    sessionAppender: env.sessionAppender,
    autoResumeLimit: env.autoResumeLimit,
    buildInitialPayload: buildInitialRequest,
    buildResumePayload: buildResumeRequest,
    shouldStopAutoResume: async () => {
      if (adapters.hasLawfulTerminalResult === undefined) return false;
      return adapters.hasLawfulTerminalResult(admitted, env.principalAuthority);
    },
    dispatch: (request, lease, _isFirst, attemptIo) =>
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
        // #600: every attempt (initial + auto-resume) writes seat engine when present.
        ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
      }),
  });
}

/**
 * Shared post-admission manual resume path: acquire writer lease and dispatch turn.
 * When the submission ledger is already sealed, project that accepted terminal
 * idempotently — do not dispatch a doomed turn that would append
 * post-seal-anomaly and erase the sealed read (#599; keep #416 open load).
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
  /** Seat-table engine axis on resume (#600); written onto invocation.json when present. */
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted?: A;
  terminal?: T;
  staleWriterLeaseReclaimed?: true;
}> {
  const { admitted, env, io, request, adapters, effectiveEngine } = input;
  // #617 DK-3: manual resume writes the live seat/env model (same as new legs).
  const effectiveModel = env.model;
  const shouldPresent =
    adapters.shouldPresentSettled ??
    ((terminal: T) => isLawfulTypedTerminalOutcome(terminal.roleOutcome));

  // Sealed accepted receipt only — audit_escalation / residual failure must not
  // short-circuit; those still need a real continuation turn.
  try {
    const existing = await adapters.trySettle(admitted, env.principalAuthority);
    if (
      existing !== undefined &&
      existing.roleOutcome.kind === "accepted" &&
      shouldPresent(existing)
    ) {
      (existing as { autoResumeCount?: number }).autoResumeCount = 0;
      io.stdout(formatTerminalResult(existing));
      return {
        exitCode: exitCodeForTerminalOutcome(existing.roleOutcome),
        admitted,
        terminal: existing,
      };
    }
  } catch (error) {
    // Sealed accepted + publication/settle throw must fail closed without redispatch
    // (#648 / #599): do not treat "sealed + publish threw" as "not sealed".
    const hasLawful =
      adapters.hasLawfulTerminalResult !== undefined &&
      (await adapters.hasLawfulTerminalResult(admitted, env.principalAuthority));
    if (hasLawful) {
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
    // Pre-dispatch settle failure without a sealed accepted projection is not
    // proof of seal; fall through to dispatch so the attempt path can settle
    // or fail honestly.
  }

  let lease: RunWriterLease;
  let staleWriterLeaseReclaimed: true | undefined;
  try {
    lease = await acquireRunWriterLease(admitted.runDirectory, (diagnostic, kind?: WriterLeaseDiagnosticKind) => {
      // Record the typed fact before the fallible sink: if io.stderr throws
      // (acquire deliberately swallows diagnostic-sink failures), the reclaim
      // still happened and must stay observable.
      if (kind === "stale-reclaimed") staleWriterLeaseReclaimed = true;
      io.stderr(diagnostic);
    });
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      io.stderr(formatCliDiagnostic(error.message));
      // A held rejection after our own reclaim must still carry the fact that
      // this caller reclaimed the stale lock — e.g. another resumer re-locked
      // before our retry create (#629).
      return {
        exitCode: 1,
        ...(staleWriterLeaseReclaimed === true
          ? { staleWriterLeaseReclaimed: true as const }
          : {}),
      };
    }
    throw error;
  }

  const result = await dispatchPostAdmissionTurn({
    admitted,
    env: {
      ...env,
      ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    io,
    request,
    lease,
    adapters,
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
  });
  if (result.terminal !== undefined) {
    (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  }
  return {
    ...result,
    ...(staleWriterLeaseReclaimed === true ? { staleWriterLeaseReclaimed: true as const } : {}),
  };
}
