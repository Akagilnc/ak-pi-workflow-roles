/**
 * Unified post-admission Role lifecycle coordinator (stages ③–⑤; ADR 0018 / #505 / #517 / #526).
 * Owns writer lease → running → ③ dispatch → ④ tool loop / gates → ⑤ settle / fail →
 * terminal → release. The durable admitted mark (markRunAdmitted) is owned by the
 * initial role facades before entering; manual resume never re-admits.
 * Role runners supply only turn request projection and narrow settlement adapters.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  buildResumeContinuationPrompt,
  GATE_DOSSIER_POINTER_PREFIX,
  RESUME_TRANSPORT_ENVELOPE,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { RoleTurnRequestProjectionOptions } from "./turn-request.ts";
import {
  buildInstructionTransportPrompt,
  freezeAttachmentsIntoRun,
} from "./invocation.ts";
import { pathContainedIn } from "../activation-ledger-topology.ts";
import { pickEngineAxis } from "../package-resources/engine-material.ts";
import { resolveHostAwareSessionAvailability } from "../session-identity.ts";

import type {
  ControlledFailureCause,
  DurablePrincipal,
  DurablePrincipalAuthority,
  RoleTurnContinuation,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
  SessionCustomEntryAppender,
} from "../host-contracts.ts";
import { projectCaseDossierPointerSection } from "./case-dossier-delivery.ts";

/** Original error bytes, never relabeled — a secondary fact riding beside a classified cause. */
function describeCaughtError(error: unknown): { name?: string; message: string; code?: string | number } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { message: String(error) };
}

/** Append one system section to a continuation prompt, keeping its kind. */
function appendContinuationSection(
  continuation: RoleTurnContinuation,
  section: string,
): RoleTurnContinuation {
  const prompt = `${continuation.prompt}\n\n${section}`;
  return continuation.kind === "initial"
    ? { kind: "initial", prompt }
    : { kind: "resume", prompt };
}
import { projectHostTransitionPriorNative } from "../host-transition-prior-native.ts";
import type { CredentialProviders, SeatModelConfig } from "./config.ts";
import {
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "./public-run-credentials.ts";
import {
  acquireRunWriterLease,
  clearCurrentCourt,
  clearTypedProviderHttpObservation,
  describeErrorIdentity,
  markRunRunning,
  readCurrentCourt,
  recordCurrentCourt,
  renderResumeCommand,
  RunWriterLeaseHeldError,
  type CurrentCourtState,
  type RunWriterLease,
  type TypedProviderHttpObservation,
  type WriterLeaseDiagnosticKind,
} from "./run-lifecycle.ts";
import { homeFromRunDirectory } from "../activation-ledger-topology.ts";
import { clearReviewerDispatchRejection } from "./reviewer-dispatch-rejection.ts";
import {
  attemptProducedFreshSubmission,
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
  settleHostEndedNoReceipt,
  attachRecordedSubmissions,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { AdmittedRoleInvocation } from "./invocation.ts";
import type { NamedRoleTurnHostAdapter } from "./role-turn-host-resolution.ts";
import {
  type TerminalResult,
} from "./terminal.ts";
import {
  ensureRealArtifactsDirectory,
  persistReturnedRunState,
  runWithAutoResumeLoop,
  TurnDispatchedFailure,
} from "./auto-resume.ts";

/**
 * Nested station-child role already finished its own call-local loop.
 * Parent records that failure once and must not auto-resume into a re-summon
 * (#840 父子不层叠). Other beforeDispatch failures keep the shared #416 budget.
 */
export class StationChildExhaustedError extends Error {
  override readonly name = "StationChildExhaustedError";
}

function withOnceSuccessfulBeforeDispatch<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(adapters: PostAdmissionAdapters<A, T>): PostAdmissionAdapters<A, T> {
  const hook = adapters.beforeDispatch;
  if (hook === undefined) return adapters;
  let succeeded = false;
  return {
    ...adapters,
    beforeDispatch: async (admitted) => {
      if (succeeded) return;
      await hook(admitted);
      succeeded = true;
    },
  };
}

/**
 * Session custom-entry type for a best-effort post-dispatch cleanup
 * diagnostic (#840 r9 判词 class 1). Every auto-resume attempt dispatches
 * with dummyIo (src/public-cli/auto-resume.ts), so an io.stderr-only
 * diagnostic never reaches a real caller — the dossier is the durable
 * channel that does (失败诚实宪法 真因必须落痕).
 */
export const POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE =
  "ak_post_admission_cleanup_diagnostic" as const;

/**
 * Best-effort post-dispatch diagnostic that must still leave a real trace
 * even though the attempt's own io may be dummyIo (#840 r9 判词 class 1).
 * Single authoritative durable channel — a dossier custom entry via
 * sessionAppender — not a standing duplicate. Only when that one write
 * itself fails does this fall back to a plain run-artifacts file (reusing
 * auto-resume.ts's existing dispatch-error retention helper — no new
 * mechanism), so an unhealthy session never leaves this diagnostic with
 * zero durable trace (#840 bounce class 2); a healthy session never gets a
 * redundant second copy (#840 bounce class 1: 同一业务规则只保留一个权威实现).
 */
async function recordBestEffortPostDispatchDiagnostic<A extends AdmittedRoleInvocation>(
  admitted: A,
  env: PostAdmissionEnv,
  diagnostic: string,
  io: CliIo,
): Promise<void> {
  io.stderr(formatCliDiagnostic(diagnostic));
  const payload = { diagnostic, recordedAt: new Date().toISOString() };
  try {
    await env.sessionAppender(
      env.principalAuthority,
      admitted.principal,
      POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE,
      payload,
    );
    return;
  } catch (appendError) {
    try {
      const artifactsDir = await ensureRealArtifactsDirectory(admitted.runDirectory);
      await writeFile(
        join(artifactsDir, `post-admission-diagnostic-${randomUUID()}.json`),
        `${JSON.stringify({ version: 1, ...payload }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (artifactError) {
      io.stderr(
        formatCliDiagnostic(
          `post-dispatch diagnostic durable retention failed on both channels (best-effort continue): dossier=${describeErrorIdentity(appendError)}; artifact=${describeErrorIdentity(artifactError)}`,
        ),
      );
    }
  }
}

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
  /**
   * Composition-root adapter table. Nested summons select by the child seat
   * from this table — they must not inherit the already-selected parent host.
   */
  hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  model?: SeatModelConfig;
  engine?: string;
  /** Labor-engine model id from the live seat table (#883). */
  engineModel?: string;
  /** Effective main-session host for this run (#595 admission / #617 resume seat). */
  host?: string;
  credentials?: CredentialProviders;
  timeoutMs?: number;
  principalAuthority: DurablePrincipalAuthority;
  sessionAppender: SessionCustomEntryAppender;
  autoResumeLimit?: number;
  createRunId?: () => string;
  /**
   * Parent cancellation for a nested public summon (#675). Every dispatched turn
   * carries it so an aborted parent terminates the nested activation; a CLI
   * process has no parent and leaves it absent.
   */
  signal?: AbortSignal;
  /**
   * #724 explicit fresh summons (`ak-role new <role>`): skip same-ticket auto-resume
   * and mint a new run. Absent on ordinary role commands and on `ak-role resume`.
   */
  freshSummons?: true;
  /** Station child role run (#840): omit automatic navigator attendance. */
  stationChild?: boolean;
};

/**
 * Role-specific settlement hooks and failure resolvers.
 * Lifecycle coordination stays in this coordinator module.
 */
export type PostAdmissionAdapters<
  A extends AdmittedRoleInvocation = AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
> = {
  trySettle: (
    admitted: A,
    authority: DurablePrincipalAuthority,
    /** Current court turn scope (#637); omit for run-scoped sealed reads. */
    scope?: { readonly courtAttemptId?: string },
  ) => Promise<T | undefined>;
  /** Default: isLawfulTypedTerminalOutcome(terminal.roleOutcome). */
  shouldPresentSettled?: (terminal: T) => boolean;
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
  /** Secondary evidence already owned by the typed production failure channel. */
  knownDetails?: Readonly<Record<string, unknown>>;
  typedHttpObservationSettled?: true;
  typedHttpObservation?: TypedProviderHttpObservation;
  /**
   * #836: set when the caller already attempted markRunTerminal/markRunResumable
   * and it is what threw `thrown` — presentControlledFailure must not retry
   * the same known-failing run-state write a second time; the caught error is
   * already the reported cause.
   */
  skipRunStateWrite?: boolean;
};

/** Result of seat prep after the single pre-lease admitted load. */
export type AfterAdmittedLoadResult<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
> =
  | { kind: "continue"; adapters: PostAdmissionAdapters<A, T> }
  | {
      kind: "terminal";
      exitCode: number;
      admitted: A;
      terminal: TerminalResult;
    };

/**
 * Factory-seat resume method-material face (#833): one authority for
 * load → adapters / controlled-failure short-circuit. Seats only declare
 * irreducible differences (loader, adapter factories, optional gate, knownCause).
 */
export async function resolveResumeMethodMaterialAdapters<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
  M = unknown,
>(input: {
  admitted: A;
  authority: DurablePrincipalAuthority;
  io: CliIo;
  /** When false, skip material and continue with emptyAdapters (coder plan). */
  shouldLoad?: boolean;
  loadMaterial: () => Promise<M>;
  adaptersWith: (material: M) => PostAdmissionAdapters<A, T>;
  emptyAdapters: PostAdmissionAdapters<A, T>;
  knownCause?: ControlledFailureCause;
}): Promise<AfterAdmittedLoadResult<A, T>> {
  if (input.shouldLoad === false) {
    return { kind: "continue", adapters: input.emptyAdapters };
  }
  try {
    const material = await input.loadMaterial();
    return { kind: "continue", adapters: input.adaptersWith(material) };
  } catch (error) {
    const terminal = await presentControlledFailure(
      input.admitted,
      {
        timedOut: false,
        code: null,
        stderr: "",
        thrown: error,
        ...(input.knownCause === undefined ? {} : { knownCause: input.knownCause }),
      },
      input.emptyAdapters,
      input.authority,
      input.io,
    );
    return { kind: "terminal", ...terminal };
  }
}

export async function presentControlledFailure<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(
  admitted: A,
  failureInput: ControlledFailureInput,
  adapters: PostAdmissionAdapters<A, T>,
  authority: DurablePrincipalAuthority,
  io: CliIo,
  persistRunState = true,
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
  // knownFailure channel owns details when present; otherwise caller knownDetails.
  const fromKnownFailure =
    explicitInternalKnownFailureClassificationInput(knownFailure);
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    ...(failureInput.knownDetails === undefined
      ? {}
      : { knownDetails: failureInput.knownDetails }),
    ...fromKnownFailure,
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

  if (persistRunState && !failureInput.skipRunStateWrite) {
    await persistReturnedRunState(admitted, authority);
  }

  const terminal = await attachRecordedSubmissions(
    admitted,
    await settleFailureTerminalResult(
      admitted,
      failure,
      authority,
      resumable
        ? { resume: { command: renderResumeCommand(admitted.runId) } }
        : {},
    ),
  );
  presentFailureTerminal(terminal, io);
  return {
    exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome),
    admitted,
    terminal,
  };
}

/**
 * presentControlledFailure, called only where the host turn has already
 * genuinely started (#840 r9 判词 class 1 boundary). If presentControlledFailure
 * itself fails, this never fabricates a replacement terminal (ADR 0080
 * single-settlement-disposition — presentControlledFailure /
 * settleFailureTerminalResult stays the one authority); it re-throws a
 * TurnDispatchedFailure so runWithAutoResumeLoop still learns the turn
 * started and selects a resume payload on the next attempt, while settling
 * the true cause through its own existing dispatch-exception machinery once
 * the retry budget is exhausted.
 */
async function settleAfterTurnStarted<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(
  admitted: A,
  failureInput: ControlledFailureInput,
  adapters: PostAdmissionAdapters<A, T>,
  authority: DurablePrincipalAuthority,
  io: CliIo,
  persistRunState: boolean,
): Promise<{ exitCode: number; admitted: A; terminal: T }> {
  try {
    return (await presentControlledFailure(
      admitted,
      failureInput,
      adapters,
      authority,
      io,
      persistRunState,
    )) as { exitCode: number; admitted: A; terminal: T };
  } catch (error) {
    throw new TurnDispatchedFailure(error);
  }
}

/**
 * Persist run-state for a result dispatchPostAdmissionTurn deferred
 * (needsPersist — station-child / resumable auto-resume loop, #416/#840):
 * that write must land outside the loop's own retried-dispatch try, but its
 * failure still settles through the single existing controlled-failure
 * authority (settleAfterTurnStarted / presentControlledFailure, ADR 0080
 * single-settlement-disposition) — never a second hand-rolled
 * classify/artifact/Terminal (#836 r12 class 3), and never lawful/non-lawful
 * settling differently (#836 r13 class 2: a caller's io here may be a no-op,
 * so a stderr-only trace is never seen and the failure is otherwise
 * swallowed — 失败诚实宪法 真因必须落痕). Both cases settle through
 * settleAfterTurnStarted, which attaches the run's already-recorded ledger
 * submissions to the new failure terminal and returns skipAutoResume so the
 * caller presents it once and stops — never re-entering auto-resume.
 */
async function settleDeferredPersist<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult,
>(
  admitted: A,
  authority: DurablePrincipalAuthority,
  adapters: PostAdmissionAdapters<A, T>,
  io: CliIo,
  result: {
    exitCode: number;
    admitted: A;
    terminal?: T;
    skipAutoResume?: true;
    turnDispatched?: true;
    needsPersist?: true;
  },
): Promise<typeof result> {
  if (result.needsPersist !== true || result.terminal === undefined) return result;
  const { needsPersist: _needsPersist, ...settledResult } = result;
  const lawful = isLawfulTypedTerminalOutcome(result.terminal.roleOutcome);
  try {
    await persistReturnedRunState(admitted, authority, lawful ? { lawful: true } : undefined);
    return settledResult;
  } catch (error) {
    const failed = await settleAfterTurnStarted(
      admitted,
      { timedOut: false, code: null, stderr: "", thrown: error, skipRunStateWrite: true },
      adapters,
      authority,
      io,
      true,
    );
    return { ...failed, turnDispatched: true as const, skipAutoResume: true as const };
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
  persistRunState?: boolean;
}): Promise<{
  exitCode: number;
  admitted: A;
  terminal?: T;
  skipAutoResume?: true;
  turnDispatched?: true;
  needsPersist?: true;
}> {
  const { admitted, env, io, request, lease, adapters, effectiveEngine } = input;
  const persistRunState = input.persistRunState !== false;
  const deferredPersist = persistRunState ? {} : { needsPersist: true as const };
  const shouldPresent =
    adapters.shouldPresentSettled ?? ((terminal: T) => isLawfulTypedTerminalOutcome(terminal.roleOutcome));
  try {
    const missingCredential = missingCredentialPreDispatchFailure(
      env.model,
      env.credentials,
    );
    if (missingCredential !== undefined) {
      return {
        ...(await presentControlledFailure(
          admitted,
          missingCredential,
          adapters,
          env.principalAuthority,
          io,
          persistRunState,
        )) as { exitCode: number; admitted: A; terminal: T },
        ...deferredPersist,
      };
    }
    // #617 DK-4: capture previous invocation host before markRunRunning overwrites it.
    // Single authority projectHostTransitionPriorNative classifies the prior native volume.
    // Same-run resume (#637) keeps host identity on the run's invocation page.
    let previousHost: string | undefined;
    const liveHost = env.host;
    const principalCoordinates =
      admitted.principal === undefined
        ? undefined
        : env.principalAuthority.decode(admitted.principal);
    let hostTransition: RoleTurnRequest["hostTransition"];
    try {
      previousHost = await readInvocationHost(admitted.runDirectory);
      hostTransition =
        previousHost !== undefined && liveHost !== undefined && principalCoordinates !== undefined
          ? await projectHostTransitionPriorNative({
              previousHost,
              liveHost,
              piSessionFile: principalCoordinates.sessionFile,
            })
          : undefined;
    } catch (error) {
      // prior-native IO is on the public one-shot path — controlled failure, not bare throw.
      return {
        ...(await presentControlledFailure(
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
          persistRunState,
        )) as { exitCode: number; admitted: A; terminal: T },
        ...deferredPersist,
      };
    }

    await clearTypedProviderHttpObservation(admitted.runDirectory);
    // Per-attempt hygiene: stale Reviewer rejection pages must not ride into
    // auto-resume. ENOENT-safe for every seat.
    await clearReviewerDispatchRejection(admitted.runDirectory);
    // The authoritative host write (markRunRunning) is delayed to just before
    // executeTurn — not merely past beforeDispatch (#840 r9 判词 class 2). Any
    // pre-turn retry (beforeDispatch, dossier projection, continuation
    // assembly) must still see the prior invocation host on its next attempt;
    // committing env.host earlier would make readInvocationHost read back the
    // new host on the retry and silently drop hostTransition.
    // Failures settle the run (presentControlledFailure); they must not leave it
    // permanently running. Call-local auto-resume retries this hook until it
    // succeeds; only an exhausted nested station child skips the parent loop
    // (#840 父子不层叠).
    if (adapters.beforeDispatch !== undefined) {
      try {
        await adapters.beforeDispatch(admitted);
      } catch (error) {
        const settled = (await presentControlledFailure(
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
          persistRunState,
        )) as { exitCode: number; admitted: A; terminal: T };
        if (error instanceof StationChildExhaustedError) {
          return { ...settled, skipAutoResume: true as const, ...deferredPersist };
        }
        return { ...settled, ...deferredPersist };
      }
    }

    // Turn request is assembled after beforeDispatch so this turn sees whatever it
    // settled — the seat's ticket bind re-projection and any court diarist station
    // writes (#742). Case dossier delivery (ADR 0081 / #709) rides here once for
    // every public entry: first call, same-ticket re-summons and manual resume
    // alike. System refs append their own neutral section; caller frozen
    // attachments and the seat's own prompt bytes are never rewritten.
    let turnRequest: RoleTurnRequest =
      env.signal === undefined ? request : { ...request, signal: env.signal };
    if (env.stationChild !== undefined) {
      turnRequest = { ...turnRequest, stationChild: env.stationChild };
    }
    if (hostTransition !== undefined) {
      turnRequest = { ...turnRequest, hostTransition };
    }
    const dossierSection = await projectCaseDossierPointerSection({
      ticketNumber: admitted.ticketNumber,
      projectRoot: admitted.projectRoot,
      home: env.home,
    });
    if (dossierSection !== undefined) {
      turnRequest = {
        ...turnRequest,
        continuation: appendContinuationSection(
          turnRequest.continuation,
          dossierSection,
        ),
      };
    }

    // Authoritative host write happens here, at the real dispatch boundary —
    // immediately before the turn actually starts, after every retryable
    // pre-turn step above has succeeded on this attempt (#840 r9 判词 class 2).
    await markRunRunning(
      admitted.runDirectory,
      env.model,
      effectiveEngine,
      env.host,
      env.engineModel,
    );

    let result: RoleTurnResult;
    try {
      result = await env.roleTurnHost.executeTurn(turnRequest);
    } catch (error) {
      const settled = await settleAfterTurnStarted(
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
        persistRunState,
      );
      return { ...settled, turnDispatched: true as const, ...deferredPersist };
    }

    // `result.stderr` stays live in memory for the real classification below
    // regardless of whether this durable mirror write succeeds. A write
    // failure here (unwritable run directory, stderr.log occupied as a
    // directory, ...) is a real infrastructure problem and must never be
    // dropped silently (catch-and-continue with no trace is a defect) — but
    // it also must never become THE controlling failure and wash out a
    // primary child signal that already arrived on `result`, or an
    // already-sealed accepted payload (#836: a secondary failure must not
    // overwrite an already-known cause or an already-recorded leg). It rides
    // beside whatever the real classification below determines, and only
    // becomes the reported failure itself when nothing else is wrong.
    //
    // Everything below runs after the host turn genuinely started (#840 r9
    // 判词 class 1 boundary — 覆盖 executeTurn 已启动后至返回带 turnDispatched
    // 结果前的全部异常). Each fallible step routes any failure through the
    // single existing settlement authority (presentControlledFailure /
    // settleFailureTerminalResult) rather than a second one (ADR 0080
    // single-settlement-disposition) — never by fabricating a terminal here.
    // A cleanup step that runs only after a real settlement (clearCurrentCourt)
    // is protected by logging and keeping that already-obtained result, never
    // by discarding it (#840 已交劳动只整理终局不重做). A failure inside the
    // settlement authority itself (presentControlledFailure's own reads) goes
    // through settleAfterTurnStarted: still no fabricated terminal, but the
    // re-thrown TurnDispatchedFailure still tells runWithAutoResumeLoop the
    // turn genuinely started, so the next retry sends a resume payload — the
    // true cause settles through the loop's own existing dispatch-exception
    // machinery once the retry budget is exhausted.
    let stderrLogWriteFailure: unknown;
    try {
      await writeFile(
        join(admitted.runDirectory, "stderr.log"),
        result.stderr,
        "utf8",
      );
    } catch (error) {
      stderrLogWriteFailure = error;
      // Best-effort: the turn's own stderr capture is secondary to lawful /
      // controlled-failure settlement below, but the failure itself must
      // still leave a real trace (失败诚实宪法 真因必须落痕) — durably, since
      // every auto-resume attempt's io is dummyIo (#840 r9 判词 class 1). It
      // still rides beside the classification below and, if nothing else is
      // wrong, becomes the reported failure itself (#836).
      await recordBestEffortPostDispatchDiagnostic(
        admitted,
        env,
        `stderr.log write failed (best-effort continue): ${describeErrorIdentity(error)}`,
        io,
      );
    }

    const courtScope =
      request.courtAttemptId === undefined || request.courtAttemptId.length === 0
        ? undefined
        : { courtAttemptId: request.courtAttemptId };

    // Single complete boundary (#840 r9 判词 class 1): resolving the
    // host/runner failure facts, trySettle, its shouldPresent gate, and the
    // accepted-settlement cleanup all settle through this one catch — a
    // throw from any of them (including the session-file decode itself)
    // still routes through settleAfterTurnStarted's TurnDispatchedFailure
    // instead of losing turnDispatched to an uncaught throw. The facts are
    // resolved before trySettle (#836) so an already-accepted settlement is
    // never presented over a real current host/runner failure signal or a
    // real stderr.log durable-write failure — both stay a real failure with
    // the recorded payload riding beside it, not replacing it.
    let settled: T | undefined;
    let settledOutcome:
      | { exitCode: number; admitted: A; terminal: T; turnDispatched: true }
      | undefined;
    let hostSignalFailed = false;
    let resolution: Awaited<ReturnType<typeof resolveAuditedRunnerFailureResolution>> | undefined;
    try {
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
      resolution = await resolveAuditedRunnerFailureResolution({
        runner: runnerKnownFailure,
        sessionFile,
        credential: credentialFailure,
        runDirectory: admitted.runDirectory,
      });
      // A direct, current signal from the host/runner itself (timeout / host
      // knownFailure / runner knownFailure / missing credential) is a real
      // problem regardless of what else already settled — a settled accepted
      // outcome must not paper over it (it rides beside the recorded payload
      // via `submissions`, never replacing the payload). The audited
      // resolution's own typed session read (malformed JSONL, provider-stop,
      // an illegal/unsealed accepted status, a stale/superseded typed-HTTP
      // observation, ...) makes a run with no sealed acceptance a true
      // failure too — it must not be discarded into a lawful no_receipt just
      // because the raw runner signal alone looked clean. But it must not
      // retroactively invalidate an acceptance that already sealed this turn
      // — a resolved 429 observed earlier in the same session is exactly
      // that.
      const directHostFailureSignal =
        result.timedOut
        || result.knownFailure !== undefined
        || runnerKnownFailure !== undefined
        || credentialFailure !== undefined;
      hostSignalFailed =
        directHostFailureSignal
        || (result.code !== null && result.code !== 0)
        || resolution.knownFailure !== undefined;

      settled = await adapters.trySettle(admitted, env.principalAuthority, courtScope);
      if (settled !== undefined) {
        settled = await attachRecordedSubmissions(admitted, settled, courtScope) as T;
      }
      // #836 r12 class 2: an accepted/audit_escalation settlement can be
      // entirely a prior attempt's stale payload (courtAttempt is a
      // recording tag, not a visibility gate — attachRecordedSubmissions
      // above still surfaces that historical payload honestly either way).
      // Consume the ledger's own subject.attemptId (submission-ledger.ts)
      // only to learn whether *this* attempt itself produced a fresh seal —
      // never to filter what presents.
      const settledIsFreshThisAttempt =
        settled === undefined
        || (settled.roleOutcome.kind !== "accepted" && settled.roleOutcome.kind !== "audit_escalation")
          ? true
          : await attemptProducedFreshSubmission(admitted, courtScope);
      // A lawful settled outcome already reached this turn takes precedence
      // over a later bare exit-code / session-inspection signal (trailing
      // nonzero exit, late stderr noise, a stale already-superseded
      // typed-HTTP observation, ...) — but never over a direct current
      // host/runner failure signal, nor over a real stderr.log durable-write
      // failure (confirmed infrastructure trouble, not weak/bare evidence),
      // both of which stay a real failure with the recorded payload riding
      // beside it, not replacing it (#836: never kill an already-recorded
      // leg, but never wash a real failure away either). Note: the narrower
      // directHostFailureSignal gates acceptance here; the broader
      // hostSignalFailed (adds bare exit code / resolution.knownFailure)
      // only gates the no-settlement fallback below — except when the
      // settlement itself is entirely stale (no fresh seal this attempt),
      // where a bare nonzero exit / resolution failure must not be outranked
      // by someone else's earlier success (#836 r12 class 2).
      const staleAcceptanceOutranksRealFailure = !settledIsFreshThisAttempt && hostSignalFailed;
      if (
        settled !== undefined
        && shouldPresent(settled)
        && !directHostFailureSignal
        && !staleAcceptanceOutranksRealFailure
        && stderrLogWriteFailure === undefined
      ) {
        // This court sealed — drop open-court pointer (bare resume no longer continues it).
        if (
          settled.roleOutcome.kind === "accepted" &&
          request.courtAttemptId !== undefined &&
          request.courtAttemptId.length > 0
        ) {
          try {
            await clearCurrentCourt(admitted.runDirectory, request.courtAttemptId);
          } catch (error) {
            // Settlement already sealed accepted — a cleanup failure here must
            // not erase that fact or make the caller replay this court's
            // summons over already-delivered work (#840 已交劳动只整理终局不重做).
            // A later bare resume self-heals: buildRequestAfterLease finds the
            // open court already sealed and clears it then (documented
            // continue-under-failure contract, not a swallow — 失败诚实宪法 真因
            // 必须落痕) — durably, since every auto-resume attempt's io here is
            // dummyIo (#840 r9 判词 class 1).
            await recordBestEffortPostDispatchDiagnostic(
              admitted,
              env,
              `current-court cleanup failed after accepted settlement (best-effort continue, self-heals on next resume): ${describeErrorIdentity(error)}`,
              io,
            );
          }
        }
        settledOutcome = {
          exitCode: exitCodeForTerminalOutcome(settled.roleOutcome),
          admitted,
          terminal: settled,
          turnDispatched: true as const,
        };
      }
    } catch (error) {
      // Settle (or its shouldPresent gate, or the failure-fact resolution
      // above) throw is a real failure fact — never swallow into undefined.
      const settledFailure = await settleAfterTurnStarted(
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
        persistRunState,
      );
      return { ...settledFailure, turnDispatched: true as const, ...deferredPersist };
    }
    if (settledOutcome !== undefined) {
      if (persistRunState) {
        try {
          await persistReturnedRunState(admitted, env.principalAuthority, { lawful: true });
        } catch (error) {
          // #836: `settledOutcome.terminal` already carries recorded
          // submissions (attachRecordedSubmissions above). A real run-state
          // persistence failure here must surface loudly through the same
          // controlled-failure seam every other dispatch-time failure in
          // this function uses (ADR 0080: one settlement disposition owner)
          // — not escape uncaught to auto-resume's dispatch-retry path,
          // whose exhausted-budget terminal carries no recorded submissions
          // at all. skipRunStateWrite: the write that just threw is the same
          // write presentControlledFailure would otherwise retry — don't
          // call a known-failing operation twice.
          const failed = await settleAfterTurnStarted(
            admitted,
            {
              timedOut: false,
              code: null,
              stderr: "",
              thrown: error,
              skipRunStateWrite: true,
            },
            adapters,
            env.principalAuthority,
            io,
            persistRunState,
          );
          return { ...failed, turnDispatched: true as const, ...deferredPersist };
        }
      }
      // Lawful persist + present is the caller's stop seam (auto-resume loop /
      // manual resume), not this retried host-turn function.
      return { ...settledOutcome, ...deferredPersist };
    }

    // Host/runner true failure coexists with already-recorded payloads — never wash as accepted.
    if (hostSignalFailed) {
      const resolutionInput = controlledFailureInputFromResolution(resolution!);
      const stderrLogWriteDetails =
        stderrLogWriteFailure === undefined
          ? undefined
          : { stderrLogWriteFailure: describeCaughtError(stderrLogWriteFailure) };
      const failed = await settleAfterTurnStarted(
        admitted,
        {
          timedOut: result.timedOut,
          code: result.code,
          stderr: result.stderr,
          ...resolutionInput,
          // Secondary fact only — never the cause. Rides on whichever channel
          // classification actually reads (knownFailure.details owns it when
          // a knownFailure exists; the top-level knownDetails otherwise).
          ...(stderrLogWriteDetails === undefined
            ? {}
            : resolutionInput.knownFailure !== undefined
              ? {
                knownFailure: {
                  ...resolutionInput.knownFailure,
                  details: { ...(resolutionInput.knownFailure.details ?? {}), ...stderrLogWriteDetails },
                },
              }
              : { knownDetails: stderrLogWriteDetails }),
        },
        adapters,
        env.principalAuthority,
        io,
        persistRunState,
      );
      return { ...failed, turnDispatched: true as const, ...deferredPersist };
    }

    // Nothing else was wrong, but the durable stderr mirror itself failed to
    // write — that is the real (infrastructure) problem in this case, not a
    // lawful absence of a receipt. Honest and loud, not silently no_receipt.
    if (stderrLogWriteFailure !== undefined) {
      const failed = await settleAfterTurnStarted(
        admitted,
        {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: stderrLogWriteFailure,
        },
        adapters,
        env.principalAuthority,
        io,
        persistRunState,
      );
      return { ...failed, turnDispatched: true as const, ...deferredPersist };
    }

    const noReceipt = await attachRecordedSubmissions(
      admitted,
      await settleHostEndedNoReceipt(admitted, env.principalAuthority) as T,
      courtScope,
    );
    if (persistRunState) {
      try {
        await persistReturnedRunState(admitted, env.principalAuthority, { lawful: true });
      } catch (error) {
        // #836: same run-state persistence hazard as the settled/accepted
        // branch above — route through the shared controlled-failure seam so
        // the real failure surfaces loudly instead of escaping uncaught to
        // auto-resume's dispatch-retry path with no recorded submissions.
        // skipRunStateWrite: don't retry the write that just threw.
        const failed = await settleAfterTurnStarted(
          admitted,
          {
            timedOut: false,
            code: null,
            stderr: "",
            thrown: error,
            skipRunStateWrite: true,
          },
          adapters,
          env.principalAuthority,
          io,
          persistRunState,
        );
        return { ...failed, turnDispatched: true as const, ...deferredPersist };
      }
    }
    return {
      exitCode: exitCodeForTerminalOutcome(noReceipt.roleOutcome),
      admitted,
      terminal: noReceipt,
      turnDispatched: true as const,
      ...deferredPersist,
    };
  } finally {
    try {
      await lease.release();
    } catch (error) {
      // lease.release() is documented best-effort and never rejects in the
      // production acquireRunWriterLease implementation (createWriterLease
      // reports cleanup failures via callback, never throws) — this guard is
      // structural only: an uncaught throw from a finally block silently
      // replaces whatever the try already returned, including a properly
      // tagged turnDispatched:true result (#840 r9 判词 class 1 boundary).
      io.stderr(
        formatCliDiagnostic(
          `writer lease release failed unexpectedly (best-effort continue): ${describeErrorIdentity(error)}`,
        ),
      );
    }
  }
}

/**
 * Shared resume continuation projection (#471 / #600 / #633 / #637 / #755):
 * seat-table model/engine/timeout axes, restored correlation, and either
 * - manual resume (no same-ticket summons): package envelope / optional caller
 *   message, with engine-axis handbook via buildResumeContinuationPrompt, or
 * - same-ticket summons (审核循环续话): caller/peer words + optional frozen
 *   attachment paths only — no「重新读」、no engine handbook packaging
 *   (#750/#755), whether or not attachments are present.
 * Caller message wins as prompt base when supplied (bytes unchanged, including
 * blank/whitespace); else summons instruction. Attachment projection must not
 * re-interpret the caller message as instructionEmpty.
 * Seats add only their activation projection. Call prepareSummonsResumeMaterials
 * first when request.summons carries instruction or attachment paths.
 */
export function resumeTurnRequestProjectionOptions(
  admitted: AdmittedRoleInvocation,
  request: PublicResumeRequest,
  env: PostAdmissionEnv,
  summonsPrepared?: {
    readonly instruction: string;
    readonly instructionEmpty: boolean;
    readonly attachments: readonly { frozenPath: string }[];
  },
): RoleTurnRequestProjectionOptions {
  const officerSourcePath = request.summons?.sourceRunPath;
  const withReread = (body: string): string => {
    if (
      officerSourcePath === undefined
      || (admitted.role !== "notary"
        && admitted.role !== "inspector"
        && admitted.role !== "auditor")
    ) {
      return body;
    }
    if (body.startsWith("请重读")) return body;
    return `请重读\n${body}`;
  };
  let prompt: string;
  if (request.message !== undefined) {
    if (summonsPrepared !== undefined) {
      // #755: same-ticket review / open-court — caller words + optional paths.
      // Attachments are not a gate: message-only summons must stay plain too.
      prompt = withReread(buildInstructionTransportPrompt({
        instruction: request.message,
        instructionEmpty: false,
        attachments: summonsPrepared.attachments,
      }));
    } else if (request.summons !== undefined) {
      // #755: same-ticket summons without prepared materials — caller words only.
      prompt = withReread(request.message);
    } else {
      // Bare manual resume — outsourcing engine axis keeps handbook (#600/#736).
      prompt = buildResumeContinuationPrompt({
        packageRoot: env.packageRoot,
        ...pickEngineAxis(env),
        message: request.message,
      });
    }
  } else if (summonsPrepared !== undefined) {
    // #755: same-ticket review summons — instruction/attachments only.
    prompt = withReread(buildInstructionTransportPrompt(summonsPrepared));
  } else if (request.summons !== undefined) {
    // #755: same-ticket summons with no instruction/attachments (e.g. notary
    // source-run pointer). #836: officer resume opening adds「请重读」+ path pointer.
    const path = request.summons.sourceRunPath;
    if (
      path !== undefined &&
      (admitted.role === "notary" ||
        admitted.role === "inspector" ||
        admitted.role === "auditor")
    ) {
      prompt = `请重读\n${GATE_DOSSIER_POINTER_PREFIX}${path}`;
    } else if (
      admitted.role === "notary" ||
      admitted.role === "inspector" ||
      admitted.role === "auditor"
    ) {
      prompt = "请重读";
    } else {
      prompt = "";
    }
  } else {
    // Bare manual resume — outsourcing engine axis keeps handbook (#600/#736).
    prompt = buildResumeContinuationPrompt({
      packageRoot: env.packageRoot,
      ...pickEngineAxis(env),
    });
  }
  return {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...pickEngineAxis(env),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(admitted.correlationId === undefined && env.correlationId === undefined
      ? {}
      : { correlationId: admitted.correlationId ?? env.correlationId }),
    continuation: {
      kind: "resume",
      prompt,
    },
    ...(request.message === undefined ? {} : { courtAttemptId: randomUUID() }),
    ...(env.stationChild === undefined ? {} : { stationChild: env.stationChild }),
  };
}

/**
 * Hold the writer lease through after-lease build, then hand off to dispatch.
 * Builder (or any throw before dispatch) must release here — dispatch's finally
 * only runs after this handoff (manual resume and station-child auto-resume).
 */
async function dispatchAfterWriterLease<T>(input: {
  lease: RunWriterLease;
  build: () => Promise<RoleTurnRequest>;
  dispatch: (request: RoleTurnRequest) => Promise<T>;
}): Promise<T> {
  let handedOffToDispatch = false;
  try {
    const request = await input.build();
    handedOffToDispatch = true;
    return await input.dispatch(request);
  } finally {
    if (!handedOffToDispatch) {
      await input.lease.release();
    }
  }
}

function isAlreadyFrozenSummonsAttachment(
  runDirectory: string,
  attachmentPath: string,
): boolean {
  const absolute = isAbsolute(attachmentPath)
    ? attachmentPath
    : resolve(attachmentPath);
  return pathContainedIn(join(runDirectory, "attachments"), absolute);
}

/**
 * Freeze same-ticket summons attachments into the retained run directory (#637).
 * No-op materials (no paths / instruction-only) skip the freeze.
 * Paths already under this run's attachments/ are the accepted freeze identity —
 * reuse them; do not re-freeze from external originals on bare resume.
 * Manual resume never calls this — old attachment semantics stay intact.
 */
export async function prepareSummonsResumeMaterials(
  runDirectory: string,
  summons: SameTicketSummonsMaterials | undefined,
): Promise<
  | {
      readonly instruction: string;
      readonly instructionEmpty: boolean;
      readonly attachments: readonly { frozenPath: string }[];
    }
  | undefined
> {
  if (summons === undefined) return undefined;
  if (summons.instruction === undefined && (summons.attachmentPaths?.length ?? 0) === 0) {
    return undefined;
  }
  const instruction = summons.instruction ?? "";
  const instructionEmpty =
    summons.instructionEmpty ?? instruction.trim() === "";
  let attachments: readonly { frozenPath: string }[] = [];
  if (summons.attachmentPaths !== undefined && summons.attachmentPaths.length > 0) {
    const alreadyFrozen = summons.attachmentPaths.every((path) =>
      isAlreadyFrozenSummonsAttachment(runDirectory, path),
    );
    attachments = alreadyFrozen
      ? summons.attachmentPaths.map((frozenPath) => ({ frozenPath }))
      : await freezeAttachmentsIntoRun(summons.attachmentPaths, runDirectory);
  }
  return { instruction, instructionEmpty, attachments };
}

/**
 * Shared manual-resume orchestration for seats whose continuation is the
 * package resume envelope (#599 / #633): load once → structural rejection →
 * optional seat afterAdmittedLoad (method material / controlled failure) →
 * seat turn projection → station-child auto-resume or public manual resume.
 * Seat-owned loader
 * validation, turn builder, and adapters stay on the seat.
 *
 * Court open/recovery transaction (#637): under the existing writer lease,
 * read currentCourt, judge seal, clear (bound to the judged court id), freeze,
 * and record. No pre-lease clear or stale court-snapshot consumption.
 */
export async function runPostAdmissionSeatResume<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  request: PublicResumeRequest;
  env: PostAdmissionEnv;
  io: CliIo;
  /** Load admitted state; receives the effective resume request (may carry rehydrated summons). */
  load: (request: PublicResumeRequest) => Promise<{ admitted: A }>;
  /** Build turn from admitted + effective request (summons ride existing projection). */
  buildTurnRequest: (
    admitted: A,
    request: PublicResumeRequest,
  ) => RoleTurnRequest | Promise<RoleTurnRequest>;
  adapters: PostAdmissionAdapters<A, T>;
  /**
   * After the single pre-lease load. Factory seats resolve method-material
   * adapters here via resolveResumeMethodMaterialAdapters (or short-circuit
   * with the same controlled-failure face as initial). Must not re-load the
   * same admitted; under-lease summons rehydrate remains the only second load,
   * and only when materials change.
   */
  afterAdmittedLoad?: (
    admitted: A,
  ) => Promise<AfterAdmittedLoadResult<A, T>>;
  effectiveEngine?: string;
}): Promise<{ exitCode: number; admitted?: A; terminal?: T }> {
  let request = input.request;

  // Load once for runDirectory / structural rejection / afterAdmittedLoad;
  // court identity is judged only after the writer lease is held (below).
  let loaded;
  try {
    loaded = await input.load(request);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, input.io);
      return { exitCode: 2 };
    }
    throw error;
  }

  let adapters = input.adapters;
  if (input.afterAdmittedLoad !== undefined) {
    const prepared = await input.afterAdmittedLoad(loaded.admitted);
    if (prepared.kind === "terminal") {
      return {
        exitCode: prepared.exitCode,
        admitted: prepared.admitted,
        terminal: prepared.terminal as T,
      };
    }
    adapters = prepared.adapters;
  }

  const buildRequestAfterLease = async (): Promise<RoleTurnRequest> => {
        let openCourtAttemptId: string | undefined;
        // Build uses the admitted judged under this lease (rehydrated when open
        // court materials ride). Settlement identity stays on the outer admitted.
        let admittedForBuild = loaded.admitted;

        // Bare resume: open-court pointer is the continue signal (not ledger seal).
        if (request.summons === undefined) {
          const openCourt = await readCurrentCourt(admittedForBuild.runDirectory);
          if (openCourt !== undefined) {
            openCourtAttemptId = openCourt.courtAttemptId;
            request = {
              runId: request.runId,
              ...(request.message === undefined
                ? {}
                : { message: request.message }),
              ...(openCourt.summons === undefined
                ? {}
                : { summons: openCourt.summons }),
            };
            if (openCourt.summons !== undefined) {
              const reloaded = await input.load(request);
              admittedForBuild = reloaded.admitted;
            }
          }
        }

        // Freeze external paths once; rewrite summons to the frozen identity so
        // currentCourt + later bare resume reuse the accepted snapshot.
        if (request.summons !== undefined) {
          const prepared = await prepareSummonsResumeMaterials(
            admittedForBuild.runDirectory,
            request.summons,
          );
          if (
            prepared !== undefined &&
            (request.summons.attachmentPaths?.length ?? 0) > 0
          ) {
            request = {
              ...request,
              summons: {
                ...request.summons,
                attachmentPaths: prepared.attachments.map(
                  (attachment) => attachment.frozenPath,
                ),
              },
            };
          }
        }

        let turnRequest = await input.buildTurnRequest(admittedForBuild, request);

        // Open court continue, or new court for summons / message re-review
        // (clause 0 新庭可再交卷; #833). Bare resume without open court omits id.
        if (
          openCourtAttemptId !== undefined ||
          request.summons !== undefined ||
          request.message !== undefined
        ) {
          const courtAttemptId =
            openCourtAttemptId ??
            (turnRequest.courtAttemptId !== undefined &&
            turnRequest.courtAttemptId.length > 0
              ? turnRequest.courtAttemptId
              : randomUUID());
          turnRequest = { ...turnRequest, courtAttemptId };
          if (openCourtAttemptId === undefined) {
            const court: CurrentCourtState = {
              courtAttemptId,
              ...(request.summons === undefined
                ? {}
                : { summons: request.summons }),
            };
            await recordCurrentCourt(admittedForBuild.runDirectory, court);
          }
        }
    return turnRequest;
  };

  // Court recovery / open under lease, then dispatch.
  // Station-child same-ticket/same-parent resume is call-local auto-resume
  // (#840 / #416). Public `ak-role resume` stays one-shot (ADR 0080).
  try {
    if (input.env.stationChild === true) {
      let firstTurn: RoleTurnRequest | undefined;
      const stationAdapters = withOnceSuccessfulBeforeDispatch(adapters);
      type StationChildAttempt = { readonly resumeTurn: boolean };
      return await runWithAutoResumeLoop({
        admitted: loaded.admitted,
        principalAuthority: input.env.principalAuthority,
        isPrincipalAvailable: resolveHostAwareSessionAvailability(
          input.env.host,
          input.env.principalAuthority,
        ),
        io: input.io,
        sessionAppender: input.env.sessionAppender,
        autoResumeLimit: input.env.autoResumeLimit,
        buildInitialPayload: (): StationChildAttempt => ({ resumeTurn: false }),
        buildResumePayload: (): StationChildAttempt => ({ resumeTurn: true }),
        // Same as public manual resume: prior-court sealed acceptance is not a
        // redispatch brake (#833). New-court station-child turns still auto-resume.
        dispatch: async (payload, lease, _isFirst, attemptIo) =>
          dispatchAfterWriterLease({
            lease,
            build: async () => {
              // #840 r8 判词 class 2: this call-local retry must keep this
              // court's frozen summons / 交卷 body / attachments verbatim
              // (same object as firstTurn) and project only the minimal
              // host-needed resume trigger — never the manual-resume engine
              // handbook (buildResumeContinuationPrompt), which would replace
              // a 审核循环 same-ticket continuation with a bare outsourcing
              // 「重新读」 envelope (#755 contract, resumeTurnRequestProjectionOptions
              // above). RESUME_TRANSPORT_ENVELOPE is the same package-owned,
              // non-semantic trigger that projection already uses for a
              // same-ticket summons carrying no instruction/attachments.
              if (payload.resumeTurn && firstTurn !== undefined) {
                return {
                  ...firstTurn,
                  continuation: {
                    kind: "resume",
                    prompt: RESUME_TRANSPORT_ENVELOPE,
                  },
                };
              }
              const turnRequest = await buildRequestAfterLease();
              firstTurn = turnRequest;
              return turnRequest;
            },
            dispatch: async (turnRequest) => {
              const result = await dispatchPostAdmissionTurn({
                admitted: loaded.admitted,
                env: {
                  ...input.env,
                  ...(loaded.admitted.correlationId === undefined
                    ? {}
                    : { correlationId: loaded.admitted.correlationId }),
                },
                io: attemptIo,
                request: turnRequest,
                lease,
                adapters: stationAdapters,
                persistRunState: false,
                ...(input.effectiveEngine === undefined
                  ? {}
                  : { effectiveEngine: input.effectiveEngine }),
              });
              return settleDeferredPersist(
                loaded.admitted,
                input.env.principalAuthority,
                stationAdapters,
                attemptIo,
                result,
              );
            },
          }),
      });
    }
    return await runPostAdmissionManualResume({
      admitted: loaded.admitted,
      env: input.env,
      io: input.io,
      adapters,
      ...(input.effectiveEngine === undefined
        ? {}
        : { effectiveEngine: input.effectiveEngine }),
      buildRequestAfterLease,
    });
  } catch (error) {
    // Open-court rehydrate load under lease may still surface seat structural
    // rejection (e.g. notary rejects caller message) — same exit face as pre-lease.
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, input.io);
      return { exitCode: 2 };
    }
    throw error;
  }
}

/**
 * Shared post-admission one-shot path: folds into runPostAdmissionResumable (#840 / #416).
 * All callable roles share the single auto-resume loop.
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
  return await runPostAdmissionResumable({
    admitted: input.admitted,
    env: input.env,
    io: input.io,
    buildInitialRequest: () => input.request,
    buildResumeRequest: () => ({
      ...input.request,
      continuation: {
        kind: "resume",
        prompt: buildResumeContinuationPrompt({
          packageRoot: input.env.packageRoot,
          ...pickEngineAxis({
            engine: input.effectiveEngine ?? input.env.engine,
            engineModel: input.env.engineModel,
          }),
        }),
      },
    }),
    adapters: input.adapters,
    ...(input.effectiveEngine === undefined ? {} : { effectiveEngine: input.effectiveEngine }),
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
  const { admitted, env, io, buildInitialRequest, buildResumeRequest, effectiveEngine } = input;
  const adapters = withOnceSuccessfulBeforeDispatch(input.adapters);

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    isPrincipalAvailable: resolveHostAwareSessionAvailability(env.host, env.principalAuthority),
    io,
    sessionAppender: env.sessionAppender,
    autoResumeLimit: env.autoResumeLimit,
    buildInitialPayload: buildInitialRequest,
    buildResumePayload: buildResumeRequest,
    dispatch: async (request, lease, _isFirst, attemptIo) => {
      const result = await dispatchPostAdmissionTurn({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        request,
        lease,
        adapters,
        persistRunState: false,
        // #600: every attempt (initial + auto-resume) writes seat engine when present.
        ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
      });
      return settleDeferredPersist(admitted, env.principalAuthority, adapters, attemptIo, result);
    },
  });
}

/**
 * Manual resume: lease + dispatch. Pass-through to the host — no sealed-accepted
 * short-circuit (#833 / #416). Court open (summons / message / open court) is
 * built under lease when using buildRequestAfterLease; sole-final stays per-attempt.
 * After-lease build shares dispatchAfterWriterLease with station-child auto-resume.
 */
export async function runPostAdmissionManualResume<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  /** Eager turn request (non-court path / seats that build before lease). */
  request?: RoleTurnRequest;
  /** After-lease builder (#637). Mutually exclusive with a prebuilt request. */
  buildRequestAfterLease?: () => Promise<RoleTurnRequest>;
  adapters: PostAdmissionAdapters<A, T>;
  /** Seat-table engine axis on resume (#600). */
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted?: A;
  terminal?: T;
  staleWriterLeaseReclaimed?: true;
}> {
  const {
    admitted,
    env,
    io,
    adapters,
    effectiveEngine,
    buildRequestAfterLease,
  } = input;
  let request = input.request;
  // #617 DK-3: manual resume writes the live seat/env model (same as new legs).
  const effectiveModel = env.model;

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

  const result = await dispatchAfterWriterLease({
    lease,
    build: async () => {
      if (request === undefined) {
        if (buildRequestAfterLease === undefined) {
          throw new Error(
            "runPostAdmissionManualResume requires request or buildRequestAfterLease",
          );
        }
        request = await buildRequestAfterLease();
      }
      return request;
    },
    dispatch: (turnRequest) =>
      dispatchPostAdmissionTurn({
        admitted,
        env: {
          ...env,
          ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
          ...(admitted.correlationId === undefined
            ? {}
            : { correlationId: admitted.correlationId }),
        },
        io,
        request: turnRequest,
        lease,
        adapters,
        ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
      }),
  });
  if (
    result.terminal !== undefined &&
    isLawfulTypedTerminalOutcome(result.terminal.roleOutcome)
  ) {
    // dispatchPostAdmissionTurn already persisted this lawful outcome inline
    // (persistRunState defaults true here — no station-child/loop deferral)
    // through its own settleAfterTurnStarted-backed branches; a lawful result
    // only ever reaches this point once that persist has already succeeded
    // (#836 r12 class 3 dedup — one persist owner, not a second here).
    io.stdout(formatTerminalResult(result.terminal));
  }
  if (result.terminal !== undefined) {
    (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  }
  return {
    ...result,
    ...(staleWriterLeaseReclaimed === true
      ? { staleWriterLeaseReclaimed: true as const }
      : {}),
  };
}
