/**
 * Unified post-admission Role lifecycle coordinator (stages ③–⑤; ADR 0018 / #505 / #517 / #526).
 * Owns writer lease → running → ③ dispatch → ④ tool loop / gates → ⑤ settle / fail →
 * terminal → release. The durable admitted mark (markRunAdmitted) is owned by the
 * initial role facades before entering; manual resume never re-admits.
 * Role runners supply only turn request projection and narrow settlement adapters.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildResumeContinuationPrompt,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { RoleTurnRequestProjectionOptions } from "./turn-request.ts";

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
import {
  isTicketSeatMemoryBound,
  readTicketSeatMemoryLastHost,
  writeTicketSeatMemoryLastHost,
} from "../ticket-seat-memory.ts";
import type { CredentialProviders, SeatModelConfig } from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
import {
  acquireRunWriterLease,
  clearTypedProviderHttpObservation,
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
  sealedAcceptanceRedispatchDisposition,
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

  // #665 / #416: resume hint is seat-uniform — principal available && typed 429 → show.
  // Do not fork the public terminal face on per-seat hasLawful / isResumableRole (ADR 0040).
  let resumable = false;
  const typedHttp429 = resumeObservation.typedHttp429;
  if (admitted.principal !== undefined) {
    const sessionPrincipalAvailable = await authority.isAvailable(admitted.principal);
    resumable = sessionPrincipalAvailable && typedHttp429 !== undefined;
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
    // #636 ticket-seat memory: one last-host page owns both last host and Grok native-home run.
    // Open is not turn return/throw: production Grok notes the open fact at bind success;
    // last-host records when the host returned a result OR when native home actually opened.
    // Pre-open throws claim nothing; post-open throws retain the opened run.
    // Side effects are gated by explicit ticket+seat binding — never by directory-outside-run guessing.
    let previousHost: string | undefined;
    let previousRunDirectory: string | undefined;
    let nativeHomeRunDirectory: string | undefined;
    let openedNativeHomeRunDirectory: string | undefined;
    const liveHost = env.host;
    const principalCoordinates =
      admitted.principal === undefined
        ? undefined
        : env.principalAuthority.decode(admitted.principal);
    const ticketSeatMemoryBound = isTicketSeatMemoryBound({
      role: admitted.role,
      ...(admitted.ticketNumber === undefined ? {} : { ticketNumber: admitted.ticketNumber }),
    });
    let turnRequest: RoleTurnRequest;
    try {
      // Ticket-seat host authority lives on the nest last-host page only.
      // Per-run invocation.host must not override: old-run retry after a cross-host
      // intermediate would otherwise keep the stale run host and drop the transition.
      // Non-ticket-seat paths still read the per-run invocation mark (#617).
      if (ticketSeatMemoryBound && principalCoordinates !== undefined) {
        const lastHost = await readTicketSeatMemoryLastHost(
          principalCoordinates.sessionDirectory,
        );
        if (lastHost !== undefined) {
          previousHost = lastHost.host;
          // runDirectory on last-host is the established Grok native isolation run when present
          // (preserved across non-Grok hosts so return-to-Grok can reopen it).
          if (
            typeof lastHost.runDirectory === "string" &&
            lastHost.runDirectory.length > 0
          ) {
            previousRunDirectory = lastHost.runDirectory;
            if (
              liveHost === "grok-build" &&
              request.continuation.kind === "resume"
            ) {
              nativeHomeRunDirectory = lastHost.runDirectory;
            }
          }
        }
      } else {
        previousHost = await readInvocationHost(admitted.runDirectory);
      }
      const hostTransition =
        previousHost !== undefined && liveHost !== undefined && principalCoordinates !== undefined
          ? await projectHostTransitionPriorNative({
              previousHost,
              liveHost,
              runDirectory: admitted.runDirectory,
              piSessionFile: principalCoordinates.sessionFile,
              ...(previousRunDirectory === undefined ? {} : { previousRunDirectory }),
            })
          : undefined;
      turnRequest = request;
      if (hostTransition !== undefined) {
        turnRequest = { ...turnRequest, hostTransition };
      }
      if (nativeHomeRunDirectory !== undefined) {
        turnRequest = { ...turnRequest, nativeHomeRunDirectory };
      }
      // Capture the actual Grok open event from production isolation (bind success).
      if (ticketSeatMemoryBound) {
        turnRequest = {
          ...turnRequest,
          noteNativeHomeOpened: (runDirectory) => {
            openedNativeHomeRunDirectory = runDirectory;
          },
        };
      }
    } catch (error) {
      // last-host / prior-native IO is on the public one-shot path — controlled failure, not bare throw.
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

    // Turn outcome and open fact are separate events. Discriminate throw value undefined.
    let turnOutcome:
      | { readonly kind: "returned"; readonly result: RoleTurnResult }
      | { readonly kind: "thrown"; readonly error: unknown };
    try {
      turnOutcome = {
        kind: "returned",
        result: await env.roleTurnHost.executeTurn(turnRequest),
      };
    } catch (error) {
      turnOutcome = { kind: "thrown", error };
    }

    // last-host authority: host returned a turn result OR native home actually opened.
    // Grok open fact comes from production bind (noteNativeHomeOpened), not from return/throw.
    // Mock hosts that return without opening still record via the returned path.
    // Pre-open throws: neither → no claim. Post-open throws: open fact → retain.
    // Spans returned failure / same-run retry / return-to-Grok / post-open body+cleanup throws.
    const hostEngaged =
      turnOutcome.kind === "returned" || openedNativeHomeRunDirectory !== undefined;
    if (
      hostEngaged &&
      liveHost !== undefined &&
      principalCoordinates !== undefined &&
      ticketSeatMemoryBound
    ) {
      try {
        await writeTicketSeatMemoryLastHost(
          principalCoordinates.sessionDirectory,
          liveHost,
          liveHost === "grok-build"
            ? (openedNativeHomeRunDirectory ??
                nativeHomeRunDirectory ??
                admitted.runDirectory)
            : previousRunDirectory,
        );
      } catch (error) {
        return (await presentControlledFailure(
          admitted,
          {
            timedOut: false,
            code: turnOutcome.kind === "returned" ? turnOutcome.result.code : null,
            stderr: turnOutcome.kind === "returned" ? turnOutcome.result.stderr : "",
            thrown: error,
          },
          adapters,
          env.principalAuthority,
          io,
        )) as { exitCode: number; admitted: A; terminal: T };
      }
    }

    if (turnOutcome.kind === "thrown") {
      // Preserve original throw/cause (pre-open or post-open). last-host already
      // retained open fact above when bind had succeeded.
      return (await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: turnOutcome.error,
        },
        adapters,
        env.principalAuthority,
        io,
      )) as { exitCode: number; admitted: A; terminal: T };
    }

    const result = turnOutcome.result;

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
      // last-host recorded after host returned a turn result (shared failure/retry/return fact).
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
 * Shared resume continuation projection (#471 / #600 / #633): seat-table
 * model/engine/timeout axes, restored correlation, and the package resume
 * envelope (message optional). Seats add only their activation projection.
 */
export function resumeTurnRequestProjectionOptions(
  admitted: AdmittedRoleInvocation,
  request: PublicResumeRequest,
  env: PostAdmissionEnv,
): RoleTurnRequestProjectionOptions {
  return {
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
      kind: "resume",
      prompt: buildResumeContinuationPrompt({
        packageRoot: env.packageRoot,
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        ...(request.message === undefined ? {} : { message: request.message }),
      }),
    },
  };
}

/**
 * Shared manual-resume orchestration for seats whose continuation is the
 * package resume envelope (#599 / #633): load → structural rejection → seat
 * turn projection → runPostAdmissionManualResume. Seat-owned loader validation,
 * turn builder, and adapters stay on the seat.
 */
export async function runPostAdmissionSeatResume<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  request: PublicResumeRequest;
  env: PostAdmissionEnv;
  io: CliIo;
  load: () => Promise<{ admitted: A }>;
  buildTurnRequest: (admitted: A) => RoleTurnRequest;
  adapters: PostAdmissionAdapters<A, T>;
  effectiveEngine?: string;
}): Promise<{ exitCode: number; admitted?: A; terminal?: T }> {
  let loaded;
  try {
    loaded = await input.load();
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, input.io);
      return { exitCode: 2 };
    }
    throw error;
  }
  return await runPostAdmissionManualResume({
    admitted: loaded.admitted,
    env: input.env,
    io: input.io,
    request: input.buildTurnRequest(loaded.admitted),
    adapters: input.adapters,
    ...(input.effectiveEngine === undefined ? {} : { effectiveEngine: input.effectiveEngine }),
  });
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
    sealedAcceptanceDisposition: () =>
      sealedAcceptanceRedispatchDisposition(admitted),
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
    // Settlement-owned sealed disposition (#648 / #599 / #672): sealed accepted +
    // publication/settle throw fail closed without redispatch; authority failure
    // preserves true cause. Manual resume only presents — does not rebuild the gate.
    const disposition = await sealedAcceptanceRedispatchDisposition(admitted);
    if (disposition.kind === "block") {
      return (await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown:
            disposition.reason === "authority-failed"
              ? disposition.cause
              : error,
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
