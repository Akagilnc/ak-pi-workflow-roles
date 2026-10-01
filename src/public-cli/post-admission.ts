/**
 * Unified post-admission Role lifecycle coordinator (stages ③–⑤; ADR 0018 / #505 / #517 / #526).
 * Owns writer lease → running → ③ dispatch → ④ tool loop / gates → ⑤ settle / fail →
 * terminal → release. The durable admitted mark (markRunAdmitted) is owned by the
 * initial role facades before entering; manual resume never re-admits.
 * Role runners supply only turn request projection and narrow settlement adapters.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  buildAutoResumeContinuationPrompt,
  findRunDirectoryById,
  readRoleRunState,
  RESUME_TRANSPORT_ENVELOPE,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { RoleTurnRequestProjectionOptions } from "./turn-request.ts";
import {
  bindAdmittedTicketNumber,
  buildInstructionTransportPrompt,
  freezeAttachmentsIntoRun,
  relocateAdmittedRunToTicket,
} from "./invocation.ts";
import { readRecordedSubmissionRows } from "../submission-ledger.ts";
import { readDeclaredTicketNumber } from "../run-ticket-number.ts";
import { pathContainedIn } from "../activation-ledger-topology.ts";
import { pickEngineAxis } from "../package-resources/engine-material.ts";
import { readStoredHostSessionId } from "../session-identity.ts";
import { rewriteRunDirectoryPathValue } from "../role-run-relocation.ts";

import type {
  ControlledFailureCause,
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
  SessionCustomEntryAppender,
} from "../host-contracts.ts";
import { isOfficerReviewSeat } from "../packaged-role-registry.ts";
/** Original error bytes, never relabeled — a secondary fact riding beside a classified cause. */
function describeCaughtError(error: unknown): { name?: string; message: string; code?: string | number } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { message: String(error) };
}

/**
 * Nested gate summons (station child) on an officer seat: dialogue content is
 * peer words only (#879). Never RoleTurnRequest.materials; #1092 drops code-side
 * 起居录 path pointer freeze — roles locate records by ticket number.
 */
function isStationChildOfficerDialogue(
  role: string,
  env: { readonly stationChild?: boolean },
): boolean {
  return env.stationChild === true && isOfficerReviewSeat(role);
}
import {
  mintEngineDetourInvocationScope,
  withEngineDetourInvocationScope,
} from "../engine-detour-usage.ts";
import type { CredentialProviders, SeatModelConfig } from "./config.ts";
import {
  clearCurrentCourt,
  describeErrorIdentity,
  markRunRunning,
  readCurrentCourt,
  recordCurrentCourt,
  type CurrentCourtState,
  type RunWriterLease,
} from "./run-lifecycle.ts";
import {
  processCancelDiagnostic,
  processCancelSignalName,
  type CatchableProcessSignal,
} from "./process-cancel.ts";
import { recordRunStart } from "../host-session-record.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  explicitInternalKnownFailureClassificationInput,
  formatCliDiagnostic,
  formatErrorCauseDetail,
  formatTerminalResult,
  ledgerReadScope,
  isLawfulTypedTerminalOutcome,
  presentFailureTerminal,
  presentStructuralRejection,
  settleFailureTerminalResult,
  settleHostEndedNoReceipt,
  noteSettlementFault,
  attachRecordedSubmissions,
  retainPackageFault,
  type ControlledFailure,
  type PackageSideFact,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { AdmittedRoleInvocation, RunDirectoryRelocation } from "./invocation.ts";
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

function projectRelocatedTurnIdentity(
  request: RoleTurnRequest,
  result: { readonly terminal?: TerminalResult },
  admitted: AdmittedRoleInvocation,
  relocation: { readonly oldRunDirectory: string; readonly newRunDirectory: string },
): void {
  const rewrite = (value: unknown) => rewriteRunDirectoryPathValue(
    value,
    relocation.oldRunDirectory,
    relocation.newRunDirectory,
  );
  const mutableRequest = request as unknown as Record<string, unknown>;
  mutableRequest.runDirectory = admitted.runDirectory;
  mutableRequest.principal = admitted.principal;
  const activation = mutableRequest.activation;
  if (activation !== null && typeof activation === "object" && !Array.isArray(activation)) {
    for (const field of ["taskPath", "packetPath", "prerequisitesPath", "inputPath", "requestManifestPath"] as const) {
      const record = activation as Record<string, unknown>;
      if (field in record) record[field] = rewrite(record[field]);
    }
  }
  if (result.terminal !== undefined) {
    for (const artifact of result.terminal.artifacts) {
      artifact.path = rewrite(artifact.path) as string;
    }
  }
}

/** #855: process-cancel settlement never re-enters auto-resume. */
function withProcessCancelSkipAutoResume<T extends object>(
  result: T,
  signal: AbortSignal | undefined,
): T & { skipAutoResume?: true } {
  if (processCancelSignalName(signal) === undefined) {
    return result as T & { skipAutoResume?: true };
  }
  return { ...result, skipAutoResume: true as const };
}

/**
 * #855: turn already started, then a catchable process signal arrived before
 * lawful seal — settle as named cancel failure and skip auto-resume.
 */
async function settleProcessCancelAfterTurn<A extends AdmittedRoleInvocation, T extends TerminalResult>(input: {
  admitted: A;
  cancelName: CatchableProcessSignal;
  result: RoleTurnResult;
  adapters: PostAdmissionAdapters<A, T>;
  env: PostAdmissionEnv;
  io: CliIo;
  persistRunState: boolean;
  deferredPersist: { needsPersist?: true } | Record<string, never>;
  invocationScopeId: string | undefined;
  notePackageFault?: (diagnostic: string) => void | Promise<void>;
}): Promise<{
  exitCode: number;
  admitted: A;
  terminal?: T;
  skipAutoResume?: true;
  turnDispatched?: true;
  needsPersist?: true;
}> {
  const failed = await settleAfterTurnStarted(
    input.admitted,
    withEngineDetourInvocationScope(
      {
        timedOut: input.result.timedOut,
        code: input.result.code,
        stderr: input.result.stderr,
        ...(input.result.signal === undefined ? {} : { signal: input.result.signal }),
        knownDiagnostic: processCancelDiagnostic(input.cancelName),
        cancelName: input.cancelName,
      },
      input.invocationScopeId,
    ),
    input.adapters,
    input.env.principalAuthority,
    input.io,
    input.persistRunState,
    input.notePackageFault,
  );
  return {
    ...failed,
    turnDispatched: true as const,
    skipAutoResume: true as const,
    ...input.deferredPersist,
  };
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
    beforeDispatch: async (admitted, lease) => {
      if (succeeded) return;
      const result = await hook(admitted, lease);
      succeeded = true;
      return result;
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
async function recordBestEffortPostDispatchDiagnostic(
  admitted: Pick<AdmittedRoleInvocation, "runDirectory" | "principal">,
  env: Pick<PostAdmissionEnv, "sessionAppender" | "principalAuthority">,
  diagnostic: string,
  io: Pick<CliIo, "stderr">,
): Promise<void> {
  await retainPackageFault({
    runDirectory: admitted.runDirectory,
    diagnostic,
    appendSession: (payload) => env.sessionAppender(
      env.principalAuthority,
      admitted.principal,
      POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE,
      payload,
    ),
    stderr: (text) => io.stderr(text),
  });
}

/** The one package-fault receiver, bound to this admitted run's session and io. */
export function packageFaultNoteFor(
  admitted: Pick<AdmittedRoleInvocation, "runDirectory" | "principal">,
  env: Pick<PostAdmissionEnv, "sessionAppender" | "principalAuthority">,
  io: Pick<CliIo, "stderr">,
): (diagnostic: string) => Promise<void> {
  return (diagnostic) => recordBestEffortPostDispatchDiagnostic(admitted, env, diagnostic, io);
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
  /**
   * Typed ticket already carried into this summons (parent board / 起居录).
   * Admission places the run under it. Not a public CLI flag.
   */
  boundTicketNumber?: number;
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
  /** A present Terminal already carries run history from settlement. */
  trySettle: (
    admitted: A,
    authority: DurablePrincipalAuthority,
    /** Current host attempt; only this invocation records history (#419). */
    scope?: { readonly courtAttemptId?: string; readonly recordAttemptHistory?: true; readonly previewOnly?: true },
  ) => Promise<T | undefined>;
  /** Default: isLawfulTypedTerminalOutcome(terminal.roleOutcome). */
  shouldPresentSettled?: (terminal: T) => boolean;
  /** A child office may pause this run with its unchanged terminal before a host turn starts. */
  beforeDispatch?: (admitted: A, lease?: RunWriterLease) => Promise<T | void> | T | void;
  /**
   * After the host turn settles and before any held writer lease is released.
   * Post-turn bind/relocate (e.g. Diarist first assert) must run here so a
   * held lease (when present) follows the run directory and failures stay
   * controlled. Public manual resume (#987) may omit the lease.
   */
  afterDispatch?: (
    admitted: A,
    lease?: RunWriterLease,
  ) => Promise<RunDirectoryRelocation | undefined>
    | RunDirectoryRelocation
    | void;
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
  /**
   * A real failure this package hit while handling the call (e.g. the
   * stderr.log durable write). Recorded beside the host's report; never a
   * cause, and never written into the host's open `details`.
   */
  packageFact?: PackageSideFact;
  /** The signal that killed the host child, when one did. */
  signal?: string;
  /**
   * A catchable process-signal cancellation. Supplies fallback wording only —
   * a host that reported a diagnostic of its own keeps it.
   */
  readonly cancelName?: CatchableProcessSignal;
  /**
   * Set when the caller already attempted markRunTerminal and it is what threw
   * `thrown` — presentControlledFailure must not retry that write.
   */
  skipRunStateWrite?: boolean;
  /** Public-invocation scope from the shared Host envelope (#537). */
  invocationScopeId?: string;
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
      { ...input.io, omitFailureStderrDiagnostic: true },
      true,
      (diagnostic) => retainPackageFault({
        runDirectory: input.admitted.runDirectory,
        diagnostic,
        stderr: (text) => input.io.stderr(text),
      }),
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
  notePackageFault?: (diagnostic: string) => void | Promise<void>,
): Promise<{
  exitCode: number;
  admitted: A;
  terminal: TerminalResult;
}> {
  const hasThrown = Object.hasOwn(failureInput, "thrown");
  const knownFailure = failureInput.knownFailure;
  // knownFailure channel owns details when present; otherwise caller knownDetails.
  const fromKnownFailure =
    explicitInternalKnownFailureClassificationInput(knownFailure);
  // Merge the two detail sources so a key carried by either survives; a later
  // spread would otherwise drop the earlier one's keys entirely.
  const callerDetails =
    failureInput.knownDetails === undefined && fromKnownFailure.knownDetails === undefined
      ? undefined
      : { ...(failureInput.knownDetails ?? {}), ...(fromKnownFailure.knownDetails ?? {}) };
  const failure = classifyPostAdmissionFailure({
    timedOut: failureInput.timedOut,
    code: failureInput.code,
    stderr: failureInput.stderr,
    ...(hasThrown ? { thrown: failureInput.thrown } : {}),
    // Both detail sources are real; merging keeps each one's keys instead of
    // letting the later spread drop the earlier one.
    ...(callerDetails === undefined ? {} : { knownDetails: callerDetails }),
    // The knownFailure channel's own cause/identity/diagnostic ride with it.
    ...(fromKnownFailure.knownCause === undefined
      ? {}
      : { knownCause: fromKnownFailure.knownCause }),
    ...(fromKnownFailure.knownIdentity === undefined
      ? {}
      : { knownIdentity: fromKnownFailure.knownIdentity }),
    ...(fromKnownFailure.knownDiagnostic === undefined
      ? {}
      : { knownDiagnostic: fromKnownFailure.knownDiagnostic }),
    ...(failureInput.knownCause === undefined
      ? {}
      : { knownCause: failureInput.knownCause }),
    ...(failureInput.knownIdentity === undefined
      ? {}
      : { knownIdentity: failureInput.knownIdentity }),
    ...(failureInput.knownDiagnostic === undefined
      ? {}
      : { knownDiagnostic: failureInput.knownDiagnostic }),
    ...(failureInput.signal === undefined ? {} : { signal: failureInput.signal }),
    ...(failureInput.cancelName === undefined ? {} : { cancelName: failureInput.cancelName }),
    ...(failureInput.packageFact === undefined
      ? {}
      : { packageFact: failureInput.packageFact }),
  });

  if (persistRunState && !failureInput.skipRunStateWrite) {
    try {
      await persistReturnedRunState(admitted);
    } catch (error) {
      // The host failure is already classified. A run-state write stays beside it.
      await noteSettlementFault(
        admitted.runDirectory,
        notePackageFault === undefined ? undefined : { notePackageFault },
        `run-state persistence failed beside host terminal: ${describeErrorIdentity(error)}`,
      );
    }
  }

  let publishedErrorPath: string | undefined;
  let terminal: TerminalResult;
  try {
    const settled = await settleFailureTerminalResult(admitted, failure, authority, {
      recordAttemptHistory: true,
      ...(notePackageFault === undefined ? {} : { notePackageFault }),
      ...(failureInput.invocationScopeId === undefined ||
        failureInput.invocationScopeId.length === 0
        ? {}
        : { invocationScopeId: failureInput.invocationScopeId }),
      onErrorPublished: (path) => { publishedErrorPath = path; },
    });
    terminal = await attachRecordedSubmissions(admitted, settled);
  } catch (error) {
    if (io.omitFailureStderrDiagnostic && publishedErrorPath !== undefined) {
      writeResumeFailurePointer(io, publishedErrorPath);
    }
    throw error;
  }
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
 * itself fails, this never fabricates a replacement terminal (ADR 0080:
 * one settlement disposition owner — presentControlledFailure /
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
  notePackageFault?: (diagnostic: string) => void | Promise<void>,
): Promise<{ exitCode: number; admitted: A; terminal: T }> {
  try {
    return (await presentControlledFailure(
      admitted,
      failureInput,
      adapters,
      authority,
      io,
      persistRunState,
      notePackageFault,
    )) as { exitCode: number; admitted: A; terminal: T };
  } catch (error) {
    throw new TurnDispatchedFailure(error);
  }
}

/**
 * Persist run-state for a result dispatchPostAdmissionTurn deferred
 * (needsPersist — station-child / resumable auto-resume loop, #416/#840):
 * that write must land outside the loop's own retried-dispatch try, but its
 * failure is a package note beside the terminal already settled. It does
 * not replace that terminal or open another attempt. The note is durable
 * because the caller's io may be a no-op.
 */
async function settleDeferredPersist<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult,
>(
  admitted: A,
  env: PostAdmissionEnv,
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
  try {
    await persistReturnedRunState(admitted);
    return settledResult;
  } catch (error) {
    await recordBestEffortPostDispatchDiagnostic(
      admitted,
      env,
      `run-state persistence failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`,
      io,
    );
    return settledResult;
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
  /** Absent on public manual resume (#987): no package lease gate before host CLI resume. */
  lease?: RunWriterLease;
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
  type DispatchOutcome = {
    exitCode: number;
    admitted: A;
    terminal?: T;
    skipAutoResume?: true;
    turnDispatched?: true;
    needsPersist?: true;
  };
  /**
   * Once-only post-host-turn hook (Diarist bind/relocate, etc.) under the still-held
   * writer lease. Every exit after the host turn has started must pass here before
   * lease release — success and failure alike. When a primary failure terminal already
   * exists, keep that cause and leave relocate failure on the shared diagnostic channel.
   */
  const courtScope = {
    ...(request.courtAttemptId === undefined || request.courtAttemptId.length === 0
      ? {} : { courtAttemptId: request.courtAttemptId }),
    ...(request.invocationScopeId === undefined || request.invocationScopeId.length === 0
      ? {} : { invocationScopeId: request.invocationScopeId }),
    notePackageFault: (diagnostic: string) => recordBestEffortPostDispatchDiagnostic(
      admitted,
      env,
      diagnostic,
      io,
    ),
  };
  let pendingSettlement: "sealed" | "no_receipt" | undefined;
  /**
   * The terminal this pending publication belongs to. A later real failure
   * (e.g. a cancel re-read) replaces `result.terminal` with its own settled
   * failure; that failure is already durable, so the superseded preview must
   * not publish over it (失败诚实宪法：接住可以，洗白不行).
   */
  let pendingTerminal: T | undefined;

  let afterDispatchApplied = false;
  const finishAfterTurn = async (result: DispatchOutcome): Promise<DispatchOutcome> => {
    if (afterDispatchApplied) return result;
    afterDispatchApplied = true;
    // #855: re-read cancel before committing the terminal and afterDispatch.
    // A signal after the history-first commit cannot retroactively erase it.
    // skipRunStateWrite: run-state
    // may already be terminal from a prior lawful persist; do not reopen as resumable.
    const cancelBeforeFinish = processCancelSignalName(env.signal);
    if (
      cancelBeforeFinish !== undefined &&
      result.terminal !== undefined &&
      isLawfulTypedTerminalOutcome(result.terminal.roleOutcome)
    ) {
      result = {
        ...(await settleAfterTurnStarted(
          admitted,
          withEngineDetourInvocationScope(
            {
              timedOut: false,
              code: null,
              stderr: "",
              knownDiagnostic: processCancelDiagnostic(cancelBeforeFinish),
              cancelName: cancelBeforeFinish,
              skipRunStateWrite: true,
            },
            request.invocationScopeId,
          ),
          adapters,
          env.principalAuthority,
          io,
          persistRunState,
          courtScope.notePackageFault,
        )),
        turnDispatched: true as const,
        skipAutoResume: true as const,
        ...deferredPersist,
      };
    }
    // The last cancellation check precedes the one durable settlement. A preview
    // never publishes pointers or history; a superseding failure owns this turn —
    // `result.terminal === pendingTerminal` is what makes the publication this
    // turn's own rather than a superseded one.
    if (
      pendingSettlement !== undefined &&
      pendingTerminal !== undefined &&
      result.terminal === pendingTerminal
    ) {
      try {
        const terminal = pendingSettlement === "sealed"
          ? await adapters.trySettle(admitted, env.principalAuthority,
              { ...courtScope, recordAttemptHistory: true })
          : await attachRecordedSubmissions(admitted,
              await settleHostEndedNoReceipt(admitted, env.principalAuthority,
                { ...courtScope, recordAttemptHistory: true }) as T,
              courtScope);
        if (terminal === undefined) throw new Error("settled host attempt vanished before publication");
        result = { ...result, terminal, exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome) };
        if (pendingSettlement === "sealed" && terminal.roleOutcome.kind === "accepted"
          && request.courtAttemptId !== undefined && request.courtAttemptId.length > 0) {
          try {
            await clearCurrentCourt(admitted.runDirectory, request.courtAttemptId);
          } catch (error) {
            // The accepted attempt is already durable; cleanup is diagnostic only.
            await recordBestEffortPostDispatchDiagnostic(admitted, env,
              `current-court cleanup failed after accepted settlement (best-effort continue): ${describeErrorIdentity(error)}`, io);
          }
        }
      } catch (error) {
        await recordBestEffortPostDispatchDiagnostic(
          admitted,
          env,
          `terminal publication failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`,
          io,
        );
      }
    }
    try {
      // #858 / #1071: the first identifiable ticketNumber field declaration
      // files an unbound run (integer, digit string, or leading #N token).
      // Terminal rows match settlement (#881): accepted and audit-escalation —
      // an escalated submission still carries the original role params.
      // Later receipts remain untouched; prose note/report is never consulted;
      // this seam does not adjudicate a ticket change.
      if (admitted.ticketNumber === undefined) {
        const rows = await readRecordedSubmissionRows(
          admitted.projectRoot,
          admitted.runId,
          ledgerReadScope(admitted),
        );
        let ticketNumber: number | undefined;
        for (const row of rows) {
          if (
            row.role !== admitted.role
            || (row.kind !== "accepted" && row.kind !== "audit-escalation")
          ) {
            continue;
          }
          const payload = row.accepted;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
          ticketNumber = readDeclaredTicketNumber(
            (payload as { ticketNumber?: unknown }).ticketNumber,
          );
          if (ticketNumber !== undefined) break;
        }
        if (ticketNumber !== undefined) await bindAdmittedTicketNumber(admitted, ticketNumber);
      }
      // #863: shared post-admission bind must relocate unbound→ticket in-home
      // before lease release (work-seat self-report and any prior board bind).
      const relocation = await relocateAdmittedRunToTicket(admitted, env.principalAuthority, lease);
      if (relocation !== undefined) {
        projectRelocatedTurnIdentity(request, result, admitted, relocation);
      }
      const afterDispatchRelocation = adapters.afterDispatch === undefined
        ? undefined
        : await adapters.afterDispatch(admitted, lease);
      if (afterDispatchRelocation !== undefined) {
        projectRelocatedTurnIdentity(request, result, admitted, afterDispatchRelocation);
      }
      return result;
    } catch (error) {
      if (result.terminal !== undefined) {
        await recordBestEffortPostDispatchDiagnostic(
          admitted,
          env,
          `afterDispatch failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`,
          io,
        );
        return result;
      }
      return {
        ...(await presentControlledFailure(
          admitted,
          withEngineDetourInvocationScope({
            timedOut: false,
            code: null,
            stderr: "",
            thrown: error,
          }, request.invocationScopeId),
          adapters,
          env.principalAuthority,
          io,
          persistRunState,
          courtScope.notePackageFault,
        )) as { exitCode: number; admitted: A; terminal: T },
        ...(result.turnDispatched === true ? { turnDispatched: true as const } : {}),
        ...(result.skipAutoResume === true ? { skipAutoResume: true as const } : {}),
        ...deferredPersist,
      };
    }
  };
  try {
    // #987: do not pre-block or classify host dispatch from AK credential
    // catalog facts. Per-invocation runner/host evidence owns provider identity.
    // The authoritative host write (markRunRunning) is delayed to just before
    // executeTurn — not merely past beforeDispatch (#840 r9 判词 class 2). Any
    // pre-turn retry (beforeDispatch, continuation assembly) must not commit a host
    // identity until the turn is ready.
    // Failures settle the run (presentControlledFailure); they must not leave it
    // permanently running. Call-local auto-resume retries this hook until it
    // succeeds; only an exhausted nested station child skips the parent loop
    // (#840 父子不层叠).
    if (adapters.beforeDispatch !== undefined) {
      try {
        const paused = await adapters.beforeDispatch(admitted, lease);
        if (paused !== undefined) {
          return { exitCode: 0, admitted, terminal: paused, skipAutoResume: true as const };
        }
      } catch (error) {
        const settled = (await presentControlledFailure(
          admitted,
          withEngineDetourInvocationScope({
            timedOut: false,
            code: null,
            stderr: "",
            thrown: error,
          }, request.invocationScopeId),
          adapters,
          env.principalAuthority,
          io,
          persistRunState,
          courtScope.notePackageFault,
        )) as { exitCode: number; admitted: A; terminal: T };
        return { ...settled, ...deferredPersist };
      }
    }

    // Turn request is assembled after beforeDispatch so this turn sees any
    // seat-specific admission changes. Dialogue continuation stays caller/peer opaque. #1092: no
    // code-side 起居录 path freeze or readingMaterial inject — roles read by ticket.
    // No package-resume parallel face or typed resume identity.
    // #990: one-shot / auto-resume may freeze principal+runDirectory before
    // relocate; always take durable identity from the live admitted object.
    let turnRequest: RoleTurnRequest = {
      ...(env.signal === undefined ? request : { ...request, signal: env.signal }),
      principal: admitted.principal,
      runDirectory: admitted.runDirectory,
    };
    if (env.stationChild !== undefined) {
      turnRequest = { ...turnRequest, stationChild: env.stationChild };
    }
    // Selected host axis rides the shared Host envelope for in-turn tools
    // (detour usage ledger) — never a pre-spawn invocation.json reread.
    if (typeof env.host === "string" && env.host.trim() !== "") {
      turnRequest = { ...turnRequest, host: env.host.trim() };
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

    // #537 invocation scope is bound once at the public-entry boundary
    // (runPostAdmissionResumable / ManualResume / station-child), not here:
    // auto-resume re-enters this dispatch and must reuse the same scope.

    let result: RoleTurnResult;
    try {
      // A bare `ak-role resume` only forwards the caller's instruction to the
      // host CLI's native resume. Nothing here may gate, redirect or reshape
      // that dispatch on prior conclusions, row counts or report presence;
      // the authoritative post-turn settlement reads whatever really happened.
      recordRunStart(admitted.runDirectory);
      result = await env.roleTurnHost.executeTurn(turnRequest);
    } catch (error) {
      const processCancelName = processCancelSignalName(env.signal);
      const settled = await settleAfterTurnStarted(
          admitted,
          withEngineDetourInvocationScope({
          timedOut: false,
          code: null,
          stderr: "",
          ...(processCancelName === undefined ? {} : { cancelName: processCancelName }),
          thrown:
            processCancelName === undefined
              ? error
              : new Error(processCancelDiagnostic(processCancelName), { cause: error }),
        }, request.invocationScopeId),
        adapters,
        env.principalAuthority,
        io,
        persistRunState,
        courtScope.notePackageFault,
      );
      return await finishAfterTurn(
        withProcessCancelSkipAutoResume(
          { ...settled, turnDispatched: true as const, ...deferredPersist },
          env.signal,
        ),
      );
    }

    // `result.stderr` stays live in memory for host-failure settlement
    // whether or not this mirror write succeeds. A write failure is noted.
    // It does not replace the host terminal or an already-sealed acceptance.
    //
    // Everything below runs after the host turn genuinely started (#840 r9
    // 判词 class 1 boundary — 覆盖 executeTurn 已启动后至返回带 turnDispatched
    // 结果前的全部异常). Each fallible step routes any failure through the
    // single existing settlement authority (presentControlledFailure /
    // settleFailureTerminalResult) rather than a second one (ADR 0080:
    // one settlement disposition owner) — never by fabricating a terminal here.
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
      // Best-effort: stderr.log is secondary to the host terminal. A write
      // failure leaves a durable note and, on a host failure, rides in
      // packageFact. It does not become the cause.
      await recordBestEffortPostDispatchDiagnostic(
        admitted,
        env,
        `stderr.log write failed (best-effort continue): ${describeErrorIdentity(error)}`,
        io,
      );
    }

    // Host facts are resolved before trySettle. A host failure skips trySettle
    // so a later read cannot replace that report. A clean host whose settlement
    // read throws is noted above and is not turned into a failure terminal.
    // stderr.log and run-state writes are notes beside the host terminal.
    let settled: T | undefined;
    let settledOutcome:
      | { exitCode: number; admitted: A; terminal: T; turnDispatched: true }
      | undefined;
    // The host CLI's own report: timeout, declared failure, cancel, or exit.
    // A null code is a signal death (Node close). No session or history read
    // takes part (owner ea321c6d / 4743ade7).
    const processCancelName = processCancelSignalName(env.signal);
    const hostSignalFailed =
      result.timedOut
      || result.knownFailure !== undefined
      || processCancelName !== undefined
      || result.code === null
      || result.code !== 0;
    const hostReportedFailure = result.knownFailure;
    try {
      if (!hostSignalFailed) {
        settled = await adapters.trySettle(admitted, env.principalAuthority, { ...courtScope, previewOnly: true });
        const cancelAfterSettle = processCancelSignalName(env.signal);
        if (
          settled !== undefined
          && shouldPresent(settled)
          && cancelAfterSettle === undefined
        ) {
          settledOutcome = {
            exitCode: exitCodeForTerminalOutcome(settled.roleOutcome),
            admitted,
            terminal: settled,
            turnDispatched: true as const,
          };
        }
      }
    } catch (error) {
      // The host did not fail. A settlement read here is a package fault and
      // must not become the terminal.
      await recordBestEffortPostDispatchDiagnostic(
        admitted,
        env,
        `settlement read failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`,
        io,
      );
    }
    if (settledOutcome !== undefined) {
      // #855: final cancel re-read before lawful seal — settlement window may
      // have received SIGTERM/SIGINT/SIGHUP after the earlier snapshot.
      const lateCancel = processCancelSignalName(env.signal);
      if (lateCancel !== undefined) {
        return await finishAfterTurn(
          await settleProcessCancelAfterTurn({
            admitted,
            cancelName: lateCancel,
            result,
            adapters,
            env,
            io,
            persistRunState,
            deferredPersist,
            invocationScopeId: request.invocationScopeId,
            notePackageFault: courtScope.notePackageFault,
          }),
        );
      }
      if (persistRunState) {
        try {
          await persistReturnedRunState(admitted);
        } catch (error) {
          await recordBestEffortPostDispatchDiagnostic(
            admitted,
            env,
            `run-state persistence failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`,
            io,
          );
        }
      }
      // Persist + present is the caller's stop seam (auto-resume loop /
      // manual resume), not this retried host-turn function.
      // #855 cancel re-read lives in finishAfterTurn (before afterDispatch).
      pendingSettlement = "sealed";
      pendingTerminal = settledOutcome.terminal;
      return await finishAfterTurn({ ...settledOutcome, ...deferredPersist });
    }

    // Host/runner true failure coexists with already-recorded payloads — never wash as accepted.
    if (hostSignalFailed) {
      const stderrLogWriteFact =
        stderrLogWriteFailure === undefined
          ? undefined
          : { stderrLogWriteFailure: describeCaughtError(stderrLogWriteFailure) };
      const failed = await settleAfterTurnStarted(
          admitted,
          withEngineDetourInvocationScope({
          timedOut: result.timedOut,
          code: result.code,
          stderr: result.stderr,
          // A signal-killed child is a fact of its own. The synthetic line is
          // only a fallback for when the host declared no failure of its own —
          // it must never displace words the host actually reported.
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          ...(hostReportedFailure === undefined ? {} : { knownFailure: hostReportedFailure }),
          // The cancellation is the host's own report of why this call ended;
          // it supplies the wording only when the host declared nothing else.
          ...(processCancelName === undefined ? {} : { cancelName: processCancelName }),
          // Secondary fact only — never the cause, and never merged into the
          // host's own details.
          ...(stderrLogWriteFact === undefined ? {} : { packageFact: stderrLogWriteFact }),
        }, request.invocationScopeId),
        adapters,
        env.principalAuthority,
        io,
        persistRunState,
        courtScope.notePackageFault,
      );
      return await finishAfterTurn(
        withProcessCancelSkipAutoResume(
          { ...failed, turnDispatched: true as const, ...deferredPersist },
          env.signal,
        ),
      );
    }

    const noReceipt = await attachRecordedSubmissions(
      admitted,
      await settleHostEndedNoReceipt(admitted, env.principalAuthority, { ...courtScope, previewOnly: true }) as T,
      courtScope,
    );
    // #855: cancel during no_receipt settlement window is not lawful success.
    const noReceiptCancel = processCancelSignalName(env.signal);
    if (noReceiptCancel !== undefined) {
      return await finishAfterTurn(
        await settleProcessCancelAfterTurn({
          admitted,
          cancelName: noReceiptCancel,
          result,
          adapters,
          env,
          io,
          persistRunState,
          deferredPersist,
          invocationScopeId: request.invocationScopeId,
          notePackageFault: courtScope.notePackageFault,
        }),
      );
    }
    if (persistRunState) {
      try {
        await persistReturnedRunState(admitted);
      } catch (error) {
        await recordBestEffortPostDispatchDiagnostic(
          admitted,
          env,
          `run-state persistence failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`,
          io,
        );
      }
    }
    // #855 cancel re-read lives in finishAfterTurn (before afterDispatch).
    pendingSettlement = "no_receipt";
    pendingTerminal = noReceipt;
    return await finishAfterTurn({
      exitCode: exitCodeForTerminalOutcome(noReceipt.roleOutcome),
      admitted,
      terminal: noReceipt,
      turnDispatched: true as const,
      ...deferredPersist,
    });
  } finally {
    // Public manual resume (#987) holds no package writer lease.
    if (lease !== undefined) {
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
}

/**
 * Shared resume continuation projection (#471 / #600 / #633 / #637 / #755 / #879):
 * seat-table model/engine/timeout axes, restored correlation, and either
 * - manual resume (no same-ticket summons): caller message bytes, or
 * - same-ticket summons (审核循环续话): caller/peer words + optional frozen
 *   attachment paths only — no「请重读」、no code-authored content substitute,
 *   no engine handbook packaging (#750/#755/#879).
 * Caller message wins as prompt base when supplied (bytes unchanged, including
 * blank/whitespace); else summons instruction (parent payload or reask).
 * Binding pointer stays on summons.sourceRunPath / activation — not dialogue content.
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
  // #879: officer dialogue content is caller/peer words only — no「请重读」,
  // no code-authored constant substitute, no attachment-list wrap of peer body.
  // Binding pointer stays on summons sourceRunPath / activation / attachments.
  const officerDialogue = isStationChildOfficerDialogue(admitted.role, env);
  let prompt: string;
  if (request.message !== undefined) {
    if (summonsPrepared !== undefined) {
      // #755: same-ticket review / open-court — caller words.
      // #879 station-child officer: words only (attachments are independent freeze).
      prompt = officerDialogue
        ? request.message
        : buildInstructionTransportPrompt({
            instruction: request.message,
            instructionEmpty: false,
            attachments: summonsPrepared.attachments,
          });
    } else if (request.summons !== undefined) {
      // #755: same-ticket summons without prepared materials — caller words only.
      prompt = request.message;
    } else {
      prompt = request.message;
    }
  } else if (summonsPrepared !== undefined) {
    // #879 station-child officer: instruction bytes === peer body/reask (no wrap).
    // Other seats keep #755 instruction + optional attachment path listing.
    prompt = officerDialogue
      ? (summonsPrepared.instructionEmpty ? "" : summonsPrepared.instruction)
      : buildInstructionTransportPrompt(summonsPrepared);
  } else if (request.summons !== undefined) {
    // #879: same-ticket summons with no instruction (e.g. notary source-run binding
    // only). Pointer is activation/sourceRun material — not dialogue content.
    prompt = "";
  } else {
    prompt = "";
  }
  return {
    packageRoot: env.packageRoot,
    home: env.home,
    ...(env.host === undefined ? {} : { host: env.host }),
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...pickEngineAxis(env),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(env.correlationId === undefined && admitted.correlationId === undefined
      ? {}
      : { correlationId: env.correlationId ?? admitted.correlationId }),
    continuation: {
      kind: "resume",
      prompt,
    },
    ...(env.stationChild === undefined ? {} : { stationChild: env.stationChild }),
  };
}

/** Shared new-turn and in-call auto-resume projection. Seat code supplies prompt and activation. */
export function roleTurnOptions(
  env: PostAdmissionEnv,
  admitted: { readonly correlationId?: string },
  continuation: RoleTurnRequest["continuation"],
): RoleTurnRequestProjectionOptions {
  const correlationId = env.correlationId ?? admitted.correlationId;
  return {
    packageRoot: env.packageRoot,
    home: env.home,
    ...(env.host === undefined ? {} : { host: env.host }),
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...pickEngineAxis(env),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(correlationId === undefined || correlationId.trim() === ""
      ? {}
      : { correlationId }),
    continuation,
    ...(env.stationChild === undefined ? {} : { stationChild: env.stationChild }),
  };
}

/**
 * Build the turn request, then hand off to dispatch. When a writer lease is
 * held, release it if build throws before handoff — dispatch's finally only
 * runs after this handoff (manual resume and station-child auto-resume).
 * #987: lease is optional; auto-resume no longer pre-acquires before host CLI.
 */
async function dispatchAfterWriterLease<T>(input: {
  lease?: RunWriterLease;
  build: () => Promise<RoleTurnRequest>;
  dispatch: (request: RoleTurnRequest) => Promise<T>;
}): Promise<T> {
  let handedOffToDispatch = false;
  try {
    const request = await input.build();
    handedOffToDispatch = true;
    return await input.dispatch(request);
  } finally {
    if (!handedOffToDispatch && input.lease !== undefined) {
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
 * reuse them for the same internal re-summons flow.
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
 * Shared manual-resume orchestration for seats (#599 / #633):
 * load once → structural rejection →
 * optional seat afterAdmittedLoad (method material / controlled failure) →
 * seat turn projection → station-child auto-resume or public manual resume.
 * Seat-owned loader
 * validation, turn builder, and adapters stay on the seat.
 *
 * Court handling (#637): public manual resume reads only the open court's
 * settlement identity; internal re-summons may freeze and record its materials.
 */
export async function runPostAdmissionSeatResume<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  request: PublicResumeRequest;
  env: PostAdmissionEnv;
  io: CliIo;
  /** Load admitted state from the caller's resume request. */
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
   * same admitted.
   */
  afterAdmittedLoad?: (
    admitted: A,
  ) => Promise<AfterAdmittedLoadResult<A, T>>;
  effectiveEngine?: string;
}): Promise<{ exitCode: number; admitted?: A; terminal?: T }> {
  let request = input.request;

  // Load once for runDirectory / structural rejection / afterAdmittedLoad.
  // Court identity for public manual resume is judged in the turn builder
  // (#987: no package writer-lease gate before host CLI resume). Station-child
  // auto-resume shares that rule via runWithAutoResumeLoop (no pre-acquire).
  let loaded;
  try {
    loaded = await input.load(request);
  } catch (error) {
    const usageError = error instanceof CliUsageError;
    // Unknown usage failures retain the structural fallback. Other load
    // failures keep the CLI's outer handling unless an existing run is found.
    const recorded = await pointExistingRunFailure(
      input.env.home,
      request.runId,
      input.env.principalAuthority,
      input.io,
      error,
    );
    if (!recorded) {
      if (usageError) {
        presentStructuralRejection(error, input.io);
        return { exitCode: 2 };
      }
      throw error;
    }
    return { exitCode: usageError ? 2 : 1 };
  }

  let adapters = input.adapters;
  if (input.afterAdmittedLoad !== undefined) {
    const prepared = await input.afterAdmittedLoad(loaded.admitted);
    if (prepared.kind === "terminal") {
      showResumeErrorPointer(input.io, prepared.exitCode, prepared.terminal);
      return {
        exitCode: prepared.exitCode,
        admitted: prepared.admitted,
        terminal: prepared.terminal as T,
      };
    }
    adapters = prepared.adapters;
  }

  const env = input.env;

  const buildRequestAfterLease = async (): Promise<RoleTurnRequest> => {
        let openCourtAttemptId: string | undefined;
        // Settlement identity stays on the outer admitted.
        const admittedForBuild = loaded.admitted;

        // Bare resume keeps the open court's settlement identity, but public resume
        // never re-delivers the prior summons or its attachments (#987).
        if (request.summons === undefined) {
          const openCourt = await readCurrentCourt(admittedForBuild.runDirectory);
          if (openCourt !== undefined) {
            openCourtAttemptId = openCourt.courtAttemptId;
          }
        }

        // Internal re-summons freezes external paths once and records that identity.
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
        if (
          turnRequest.continuation.kind === "resume"
          && turnRequest.continuation.hostSessionId === undefined
        ) {
          const hostSessionId = await readStoredHostSessionId(
            env.host,
            env.principalAuthority,
            admittedForBuild.principal,
          );
          if (hostSessionId !== undefined) {
            turnRequest = {
              ...turnRequest,
              continuation: { ...turnRequest.continuation, hostSessionId },
            };
          }
        }

        // Open court continue, or a new court for a real re-summons
        // (clause 0 新庭可再交卷; #833). Bare resume — with or without caller
        // words — carries no summons and no open court, so it mints none:
        // the package must not turn ordinary continuation bytes into an audit
        // court whose attempt scope would reshape settlement (#1032 修订票：
        // 此要求不延伸到没有该传召庭次的裸 resume).
        if (openCourtAttemptId !== undefined || request.summons !== undefined) {
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

  // Court recovery / open, then dispatch. Public manual resume and station-child
  // auto-resume both pass through to the host CLI without a package writer-lease
  // pre-gate (#987 / ADR 0080). Station-child same-ticket/same-parent resume is
  // still call-local auto-resume (#840 / #416).
  try {
    if (env.stationChild === true) {
      let firstTurn: RoleTurnRequest | undefined;
      const stationAdapters = withOnceSuccessfulBeforeDispatch(adapters);
      type StationChildAttempt = { readonly resumeTurn: boolean };
      // One public call → one detour scope across in-place auto-resume dispatches.
      const invocationScopeId = mintEngineDetourInvocationScope({
        ...(input.effectiveEngine === undefined
          ? {}
          : { effectiveEngine: input.effectiveEngine }),
      });
      return await runWithAutoResumeLoop({
        admitted: loaded.admitted,
        principalAuthority: env.principalAuthority,
        io: input.io,
        sessionAppender: env.sessionAppender,
        autoResumeLimit: env.autoResumeLimit,
        ...(env.signal === undefined ? {} : { signal: env.signal }),
        buildInitialPayload: (): StationChildAttempt => ({ resumeTurn: false }),
        buildResumePayload: (): StationChildAttempt => ({ resumeTurn: true }),
        // Same as public manual resume: prior-court sealed acceptance is not a
        // redispatch brake (#833). New-court station-child turns still auto-resume.
        dispatch: async (payload, lease, _isFirst, attemptIo) =>
          dispatchAfterWriterLease({
            ...(lease === undefined ? {} : { lease }),
            build: async () => {
              // #840 r8 判词 class 2: this call-local retry must keep this
              // court's frozen summons / 交卷 body / attachments verbatim
              // (same object as firstTurn) and project only the minimal
              // host-needed resume trigger — never engine handbook material,
              // which would replace a 审核循环 same-ticket continuation with a bare outsourcing
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
              const turnRequest = withEngineDetourInvocationScope(
                await buildRequestAfterLease(),
                invocationScopeId,
              );
              firstTurn = turnRequest;
              return turnRequest;
            },
            dispatch: async (turnRequest) => {
              const result = await dispatchPostAdmissionTurn({
                admitted: loaded.admitted,
                env,
                io: attemptIo,
                request: turnRequest,
                ...(lease === undefined ? {} : { lease }),
                adapters: stationAdapters,
                persistRunState: false,
                ...(input.effectiveEngine === undefined
                  ? {}
                  : { effectiveEngine: input.effectiveEngine }),
              });
              return settleDeferredPersist(
                loaded.admitted,
                env,
                attemptIo,
                result,
              );
            },
          }),
      });
    }
    const resumed = await runPostAdmissionManualResume({
      admitted: loaded.admitted,
      env,
      io: { ...input.io, omitFailureStderrDiagnostic: true },
      adapters,
      ...(input.effectiveEngine === undefined
        ? {}
        : { effectiveEngine: input.effectiveEngine }),
      buildRequestAfterLease,
    });
    showResumeErrorPointer(input.io, resumed.exitCode, resumed.terminal);
    return resumed;
  } catch (error) {
    if (error instanceof TurnDispatchedFailure) throw error;
    await presentResumeFailurePointer(
      input.io,
      error,
      (failure) => writeResumeDiagnosticFile(
        loaded.admitted.runDirectory,
        loaded.admitted.runId,
        failure,
        loaded.admitted.role,
      ),
    );
    return { exitCode: error instanceof CliUsageError ? 2 : 1 };
  }
}

async function pointExistingRunFailure(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
  io: CliIo,
  thrown: unknown,
): Promise<boolean> {
  let foundRunDirectory: string | undefined;
  try {
    foundRunDirectory = await findRunDirectoryById(home, runId);
  } catch {
    return false;
  }
  if (foundRunDirectory === undefined) return false;
  const runDirectory = foundRunDirectory;

  let record: Awaited<ReturnType<typeof readRoleRunState>>;
  try {
    record = await readRoleRunState(runDirectory, authority);
  } catch {
    await presentResumeFailurePointer(io, thrown, (failure) =>
      writeResumeDiagnosticFile(runDirectory, runId, failure),
    );
    return true;
  }
  if (record === undefined) return false;
  await presentResumeFailurePointer(io, thrown, (failure) =>
    writeResumeDiagnosticFile(runDirectory, runId, failure, record.role),
  );
  return true;
}

export async function presentLocatedResumeFailure(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
  io: CliIo,
  thrown: unknown,
): Promise<boolean> {
  return await pointExistingRunFailure(home, runId, authority, io, thrown);
}

function writeResumeFailurePointer(io: CliIo, errorPath: string): void {
  io.stderr(formatCliDiagnostic(`续跑失败，当次错误记录：${errorPath}`));
}

export function showResumeErrorPointer(
  io: CliIo,
  exitCode: number,
  terminal: TerminalResult | undefined,
): void {
  if (exitCode === 0 || terminal === undefined) return;
  const publishedError = terminal.artifacts.find((artifact) => artifact.kind === "error")?.path;
  if (publishedError !== undefined) writeResumeFailurePointer(io, publishedError);
}

async function presentResumeFailurePointer(
  io: CliIo,
  thrown: unknown,
  publish: (failure: ControlledFailure) => Promise<string>,
): Promise<void> {
  const failure = classifyPostAdmissionFailure({
    timedOut: false,
    code: null,
    stderr: "",
    thrown,
  });
  try {
    writeResumeFailurePointer(io, await publish(failure));
  } catch (publishError) {
    const cause: { thrownCause?: string; publishError: string } = {
      publishError: formatErrorCauseDetail(publishError),
    };
    if (thrown instanceof Error && thrown.cause !== undefined) {
      cause.thrownCause = formatErrorCauseDetail(thrown.cause);
    }
    presentStructuralRejection({
      message: thrown instanceof Error ? thrown.message : String(thrown),
      cause,
    }, io);
  }
}

async function writeResumeDiagnosticFile(
  runDirectory: string,
  runId: string,
  failure: ControlledFailure,
  role?: AdmittedRoleInvocation["role"],
): Promise<string> {
  const dir = await ensureRealArtifactsDirectory(runDirectory);
  const path = join(dir, `resume-diagnostic-${randomUUID()}.json`);
  await writeFile(
    path,
    `${JSON.stringify({
      runId,
      ...(role === undefined ? {} : { role }),
      diagnostic: failure.diagnostic,
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      ...(failure.identity === undefined ? {} : { identity: failure.identity }),
      ...(failure.details === undefined ? {} : { details: failure.details }),
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return path;
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
        prompt: buildAutoResumeContinuationPrompt({
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

  // One public call → one detour scope across in-place auto-resume dispatches.
  const invocationScopeId = mintEngineDetourInvocationScope({
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
  });
  const buildScopedInitial = (): RoleTurnRequest =>
    withEngineDetourInvocationScope(buildInitialRequest(), invocationScopeId);
  const buildScopedResume = (): RoleTurnRequest =>
    withEngineDetourInvocationScope(buildResumeRequest(), invocationScopeId);

  return runWithAutoResumeLoop({
    admitted,
    principalAuthority: env.principalAuthority,
    io,
    sessionAppender: env.sessionAppender,
    autoResumeLimit: env.autoResumeLimit,
    ...(env.signal === undefined ? {} : { signal: env.signal }),
    buildInitialPayload: buildScopedInitial,
    buildResumePayload: buildScopedResume,
    dispatch: async (request, lease, _isFirst, attemptIo) => {
      const result = await dispatchPostAdmissionTurn({
        admitted,
        env: {
          ...env,
          ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
        },
        io: attemptIo,
        request,
        ...(lease === undefined ? {} : { lease }),
        adapters,
        persistRunState: false,
        // #600: every attempt (initial + auto-resume) writes seat engine when present.
        ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
      });
      return settleDeferredPersist(admitted, env, attemptIo, result);
    },
  });
}

/**
 * Manual resume: pass-through to the host CLI resume — no package writer-lease
 * pre-gate (#987), no sealed-accepted short-circuit (#833 / #416). Court open
 * (summons / message / open court) is built when using buildRequestAfterLease;
 * sole-final stays per-attempt. Station-child auto-resume shares the same
 * no-pre-gate rule via runWithAutoResumeLoop + dispatchAfterWriterLease.
 */
export async function runPostAdmissionManualResume<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  /** Eager turn request (non-court path / seats that build before dispatch). */
  request?: RoleTurnRequest;
  /** Turn builder (#637). Mutually exclusive with a prebuilt request. */
  buildRequestAfterLease?: () => Promise<RoleTurnRequest>;
  adapters: PostAdmissionAdapters<A, T>;
  /** Seat-table engine axis on resume (#600). */
  effectiveEngine?: string;
}): Promise<{
  exitCode: number;
  admitted?: A;
  terminal?: T;
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

  // Explicit public resume is a new counting unit — mint once for this call.
  const invocationScopeId = mintEngineDetourInvocationScope({
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
  });

  if (request === undefined) {
    if (buildRequestAfterLease === undefined) {
      throw new Error(
        "runPostAdmissionManualResume requires request or buildRequestAfterLease",
      );
    }
    request = await buildRequestAfterLease();
  }
  request = withEngineDetourInvocationScope(request, invocationScopeId);

  const result = await dispatchPostAdmissionTurn({
    admitted,
    env: {
      ...env,
      ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
      ...(admitted.correlationId === undefined
        ? {}
        : { correlationId: admitted.correlationId }),
    },
    io,
    request,
    adapters,
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
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
  return result;
}
