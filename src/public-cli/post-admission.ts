/**
 * Unified post-admission Role lifecycle coordinator (stages ③–⑤; ADR 0018 / #505 / #517 / #526).
 * Owns writer lease → running → ③ dispatch → ④ tool loop / gates → ⑤ settle / fail →
 * terminal → release. The durable admitted mark (markRunAdmitted) is owned by the
 * initial role facades before entering; manual resume never re-admits.
 * Role runners supply only turn request projection and narrow settlement adapters.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  findRunDirectoryById,
  resolveLiveRunDirectoryPath,
  readRoleRunState,
  type PublicResumeRequest,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { CliUsageError } from "./cli-errors.ts";
import { projectPublicTurnAxes, type RoleTurnRequestProjectionOptions } from "./turn-request.ts";
import {
  appendCallerFileFlagPaths,
  bindAdmittedTicketNumber,
  relocateAdmittedRunToTicket,
} from "./invocation.ts";
import { readRecordedSubmissionRows } from "../submission-ledger.ts";
import { parseTicketNumber, readBoardTicketNumber, readDeclaredTicketNumber } from "../run-ticket-number.ts";
import { homeFromRunDirectory } from "../activation-ledger-topology.ts";
import { readStoredHostSessionId } from "../session-identity.ts";
import { reportRunRecord } from "../sitian-facade.ts";
import {
  createReceiptDeliveryPolicy,
  deliveryLimitFromConfig,
} from "../receipt-delivery-policy.ts";
import { rewritePrincipalSessionPaths, rewriteRunDirectoryPathValue, rewriteAdmittedRoleRunPage } from "../role-run-relocation.ts";

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
import { DEFAULT_ROLE_TURN_HOST } from "../host-descriptions.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  explicitInternalKnownFailureClassificationInput,
  formatCliDiagnostic,
  formatErrorCauseDetail,
  ledgerReadScope,
  isLawfulTypedTerminalOutcome,
  presentStructuralRejection,
  settleFailureTerminalResult,
  settleHostEndedNoReceipt,
  noteSettlementFault,
  attachRecordedSubmissions,
  retainPackageFault,
  type ControlledFailure,
  type PackageSideFact,
  type SettlementCourtScope,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { AdmittedRoleInvocation, RunDirectoryRelocation } from "./invocation.ts";
import type { NamedRoleTurnHostAdapter } from "./role-turn-host-resolution.ts";
import {
  type TerminalResult,
} from "./terminal.ts";
import {
  persistReturnedRunState,
  presentTerminal,
  runWithAutoResumeLoop,
  TurnDispatchedFailure,
} from "./auto-resume.ts";

import { isRecord, errorText } from "../unknown-value.ts";

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
  if (isRecord(activation)) {
    for (const field of ["inputPath"] as const) {
      const record = activation as Record<string, unknown>;
      if (field in record) record[field] = rewrite(record[field]);
    }
    // #1165/#1168: caller file-flag paths are not activation fields to rewrite.
  }
  if (result.terminal !== undefined) {
    for (const artifact of result.terminal.artifacts) {
      artifact.path = rewrite(artifact.path) as string;
    }
  }
}

/**
 * #1171: after the host returns, follow the leg's placement (report-ticket may
 * have moved it mid-turn in the tool process). Settlement and render use the
 * live path; lease cleanup follows when the held path changed.
 * Failure is not best-effort: a missing former path with no replacement must not
 * settle or write back under the vanished unbound leaf (失败诚实宪法).
 */
export async function refreshAdmittedPlacementAfterHostTurn(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  heldLease?: { relocate(runDirectory: string): void },
): Promise<RunDirectoryRelocation | undefined> {
  const home = homeFromRunDirectory(admitted.runDirectory);
  const found = await resolveLiveRunDirectoryPath(admitted.runDirectory, home);
  if (found === undefined) {
    throw new Error(
      `admitted run ${admitted.runId} missing after host turn; not found under ${home}`,
    );
  }
  // Live identity first: later board-ticket read must not leave settlement on the
  // pre-relocate path when facts are damaged (#1171 F4-R1).
  let relocation: RunDirectoryRelocation | undefined;
  if (found !== admitted.runDirectory) {
    const oldRunDirectory = admitted.runDirectory;
    const coords = { ...authority.decode(admitted.principal) };
    rewritePrincipalSessionPaths(
      coords as Record<string, unknown>,
      oldRunDirectory,
      found,
    );
    const principal = authority.seal(coords);
    rewriteAdmittedRoleRunPage(
      admitted as unknown as Record<string, unknown>,
      [{ oldRunDirectory, newRunDirectory: found }],
    );
    (admitted as { principal: typeof principal }).principal = principal;
    heldLease?.relocate(found);
    relocation = { oldRunDirectory, newRunDirectory: found };
  }
  // Board re-read discovers a ticket written mid-turn while still unbound
  // (report-ticket board page). Already-bound identity needs no discovery —
  // placement refresh already followed the retained path. This is not damage
  // recovery: when unbound, readBoardTicketNumber damage/non-ENOENT IO still
  // propagates (失败诚实; notary: no damaged-control-plane → no-ticket wash).
  if (admitted.ticketNumber === undefined) {
    const boardTicket = await readBoardTicketNumber(found);
    if (boardTicket !== undefined) {
      (admitted as { ticketNumber?: number }).ticketNumber = boardTicket;
    }
  }
  return relocation;
}

/** Apply a successful post-host placement refresh onto the live turn request. */
function applyRefreshedPlacementToTurn(
  request: RoleTurnRequest,
  turnRequest: RoleTurnRequest,
  admitted: AdmittedRoleInvocation,
  refreshed: RunDirectoryRelocation,
): RoleTurnRequest {
  projectRelocatedTurnIdentity(request, {}, admitted, refreshed);
  return {
    ...turnRequest,
    runDirectory: admitted.runDirectory,
    principal: admitted.principal,
  };
}

/**
 * #1171: host throw after a started turn — one live placement refresh, then the
 * one settlement authority (ADR 0080). Shared by first turn and 催交; never
 * settle under a vanished unbound leaf.
 */
async function settleHostThrowAfterLivePlacementRefresh<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult = TerminalResult,
>(input: {
  admitted: A;
  hostError: unknown;
  /** False only when executeTurn itself threw; post-success refresh share this catch. */
  hostTurnCompleted: boolean;
  request: RoleTurnRequest;
  turnRequest: RoleTurnRequest;
  lease: RunWriterLease | undefined;
  adapters: PostAdmissionAdapters<A, T>;
  env: PostAdmissionEnv;
  io: CliIo;
  persistRunState: boolean;
  notePackageFault?: (diagnostic: string) => void | Promise<void>;
  courtAttemptId?: string;
}): Promise<{
  settled: { exitCode: number; admitted: A; terminal: T };
  turnRequest: RoleTurnRequest;
}> {
  let refreshError: unknown;
  let turnRequest = input.turnRequest;
  try {
    const refreshed = await refreshAdmittedPlacementAfterHostTurn(
      input.admitted,
      input.env.principalAuthority,
      input.lease,
    );
    if (refreshed !== undefined) {
      turnRequest = applyRefreshedPlacementToTurn(
        input.request,
        turnRequest,
        input.admitted,
        refreshed,
      );
    }
  } catch (err) {
    refreshError = err;
  }
  const processCancelName = processCancelSignalName(input.env.signal);
  // Secondary hostThrow only when the host actually threw and refresh also failed.
  // Package-side refresh failure must not borrow that label (#1171 F10).
  const hostThrowSecondary =
    refreshError !== undefined && input.hostTurnCompleted === false
      ? { knownDetails: { hostThrow: describeCaughtError(input.hostError) } }
      : {};
  const settled = await settleAfterTurnStarted(
    input.admitted,
    withEngineDetourInvocationScope({
      timedOut: false,
      code: null,
      stderr: "",
      // Prefer the refresh failure when the live path is gone; otherwise the
      // host throw remains the cause (失败诚实：不在旧 unbound 上结算写回).
      ...(processCancelName === undefined ? {} : { cancelName: processCancelName }),
      thrown: refreshError ?? input.hostError,
      ...hostThrowSecondary,
    }, input.request.invocationScopeId),
    input.adapters,
    input.env.principalAuthority,
    input.io,
    input.persistRunState,
    input.notePackageFault,
    input.courtAttemptId,
  );
  return { settled, turnRequest };
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
  courtAttemptId?: string;
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
        // A host report already on this result stays the report. The cancel
        // name is wording only when the host gave none.
        ...(input.result.knownFailure === undefined
          ? { knownDiagnostic: processCancelDiagnostic(input.cancelName) }
          : { knownFailure: input.result.knownFailure }),
        cancelName: input.cancelName,
      },
      input.invocationScopeId,
    ),
    input.adapters,
    input.env.principalAuthority,
    input.io,
    input.persistRunState,
    input.notePackageFault,
    input.courtAttemptId,
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
  /**
   * Unreadable-status reasks already issued on this chain (#1132). Each reask
   * keeps this env's autoResumeLimit; the counter is the only thing that moves.
   */
  unreadableReasksSpent?: number;
  /**
   * #1171: missing-ticket soft reasks already issued on this chain. Hard ceiling
   * is one — still no ticket after that stays unbound with the sealed receipt.
   * Budget only across rounds; not the current turn's settlement identity.
   */
  ticketReasksSpent?: number;
  /**
   * #1171 F2-R5: this turn is the one soft reask. Keep the sealed terminal face
   * when it ends without a substitute seal. Not carried into audit continue.
   */
  softTicketReaskTurn?: true;
  /**
   * #1171 F2-R7: live ownership cell for this soft-reask nested chain.
   * Created at soft-reask dispatch; settlement of that turn sets sealedSubstitute.
   * Shared ref survives env spreads — not a second ledger.
   */
  softTicketReaskOwnership?: { sealedSubstitute: boolean };
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
  /** #1160 attendance auto byStatus prepare (nested navigator only). */
  navigatorByStatusPrepare?: boolean;
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
   * stderr log-line write). Recorded beside the host's report; never a
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
  /** Open-court identity already on the turn request / currentCourt (#1161). */
  courtAttemptId?: string,
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
  const classified = classifyPostAdmissionFailure({
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
  const failure = failureInput.stderr.length === 0 || failureInput.stderr === classified.diagnostic
    ? classified
    : { ...classified, stderr: failureInput.stderr };

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
      ...(courtAttemptId === undefined || courtAttemptId.length === 0
        ? {}
        : { courtAttemptId }),
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
  await presentTerminal(terminal, io, admitted.runDirectory);
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
  courtAttemptId?: string,
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
      courtAttemptId,
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
  result: DispatchOutcomeFor<A, T>,
): Promise<DispatchOutcomeFor<A, T>> {
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

/**
 * Court/invocation scope for settlement reads. The one construction of this
 * shape for every turn (#1132 — the first turn and each 催交 turn share it).
 */
function settlementScopeForTurn(request: RoleTurnRequest): SettlementCourtScope | undefined {
  const hasCourt = request.courtAttemptId !== undefined && request.courtAttemptId.length > 0;
  const hasScope = request.invocationScopeId !== undefined && request.invocationScopeId.length > 0;
  if (!hasCourt && !hasScope) return undefined;
  return {
    ...(hasCourt ? { courtAttemptId: request.courtAttemptId as string } : {}),
    ...(hasScope ? { invocationScopeId: request.invocationScopeId as string } : {}),
  };
}

/**
 * #1132: one 没交卷催交 turn, dispatched through the SAME settlement path as the
 * first turn.
 *
 * There is deliberately no second settlement implementation here. A delivery
 * turn is an ordinary host turn on this same run/session: this builds the
 * host-neutral resume request (the adapter's stored native session id, ADR 0082;
 * pi's existing delivery-state content reused verbatim — no new prompt wording,
 * no new host capability). The caller settles it through the same
 * `settleCompletedHostTurn` the first turn uses (ADR 0080): the runner/host
 * failure re-read, the shouldPresent gate, the fresh-seal check, open-court
 * cleanup, cancel re-reads, run-state persist, and the stderr mirror.
 *
 * The caller owns the live delivery policy; the request projects its next send.
 */
/** Bare in-call催交 resume: hostSessionId absent; adapter is the sole load authority. */
function buildReceiptDeliveryRequest(input: {
  request: RoleTurnRequest;
  receiptDelivery: ReturnType<typeof createReceiptDeliveryPolicy>;
}): RoleTurnRequest {
  const { request, receiptDelivery } = input;
  return {
    ...request,
    continuation: {
      kind: "resume",
      prompt: JSON.stringify({
        ...receiptDelivery.deliveryState(),
        deliveryTurns: receiptDelivery.issuedDeliveryRequests() + 1,
      }),
    },
    deliveryRequestLimit: receiptDelivery.limit,
  };
}

/** The one dispatch-result shape. */
type DispatchOutcomeFor<A extends AdmittedRoleInvocation, T extends TerminalResult> = {
  exitCode: number;
  admitted: A;
  terminal?: T;
  skipAutoResume?: true;
  turnDispatched?: true;
  needsPersist?: true;
};

/**
 * #1132: settle ONE completed host turn — the single post-turn settlement
 * authority shared by the first turn and by every 没交卷催交 turn (ADR 0080).
 *
 * Extracted deliberately instead of re-entering `dispatchPostAdmissionTurn`.
 * The turn-BEFORE concerns (beforeDispatch / markRunRunning / relocate /
 * afterDispatch / writer-lease release) belong to the outermost dispatch and
 * run exactly once per run; everything from the stderr mirror onward is
 * per-turn. A 催交 turn is a real host turn on this same run/session, so it
 * settles through THIS function — not a reduced copy — and it re-runs neither
 * the admission hooks nor the run-state terminal write.
 *
 * Returns `still-missing` when the turn simply produced no receipt: the caller
 * (first turn or the 催交 loop) then decides between issuing another delivery
 * request and settling no_receipt.
 */
async function settleCompletedHostTurn<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  adapters: PostAdmissionAdapters<A, T>;
  shouldPresent: (terminal: T) => boolean;
  request: RoleTurnRequest;
  result: RoleTurnResult;
  persistRunState: boolean;
  deferredPersist: { needsPersist?: true } | Record<string, never>;
  finishAfterTurn: (result: DispatchOutcomeFor<A, T>) => Promise<DispatchOutcomeFor<A, T>>;
  courtScope: SettlementCourtScope & { notePackageFault: (diagnostic: string) => Promise<void> };
  markPending: (terminal: T) => void;
}): Promise<{ kind: "settled"; outcome: DispatchOutcomeFor<A, T> } | { kind: "still-missing" }> {
  const { admitted, env, io, adapters, shouldPresent, request, result, persistRunState, deferredPersist } = input;
  const finishAfterTurn = input.finishAfterTurn;

  const courtScope = input.courtScope;
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
    reportRunRecord(admitted.runDirectory, "stderr", { text: result.stderr }, "post-admission");
  } catch (error) {
    stderrLogWriteFailure = error;
    // Best-effort: the stderr log line is secondary to the host terminal. A write
    // failure leaves a durable note and, on a host failure, rides in
    // packageFact. It does not become the cause.
    await recordBestEffortPostDispatchDiagnostic(
      admitted,
      env,
      `stderr log write failed (best-effort continue): ${describeErrorIdentity(error)}`,
      io,
    );
  }

  // Host facts are resolved before trySettle. A host failure skips trySettle
  // so a later read cannot replace that report. A clean host whose settlement
  // read throws is noted above and is not turned into a failure terminal.
  // the stderr log line and run-state writes are notes beside the host terminal.
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
      return { kind: "settled", outcome: await finishAfterTurn(
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
          ...(courtScope.courtAttemptId === undefined
            ? {}
            : { courtAttemptId: courtScope.courtAttemptId }),
        }),
      ) };
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
    input.markPending(settledOutcome.terminal);
    return { kind: "settled", outcome: await finishAfterTurn({ ...settledOutcome, ...deferredPersist }) };
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
      courtScope.courtAttemptId,
    );
    return { kind: "settled", outcome: await finishAfterTurn(
      withProcessCancelSkipAutoResume(
        { ...failed, turnDispatched: true as const, ...deferredPersist },
        env.signal,
      ),
    ) };
  }

  return { kind: "still-missing" };
}

/**
 * #858 / #1071: the first identifiable ticketNumber field declaration among the
 * run's sealed rows files an unbound run (integer, digit string, or leading #N
 * token). Terminal rows match settlement (#881): accepted and audit-escalation —
 * an escalated submission still carries the original role params. Later
 * receipts remain untouched; prose note/report is never consulted; this seam
 * does not adjudicate a ticket change. Runs in the public call's own process
 * (no role leg writes the run's current.json).
 */
export async function bindSealedTicketNumber(admitted: AdmittedRoleInvocation): Promise<void> {
  if (admitted.ticketNumber !== undefined) return;
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
    if (!isRecord(payload)) continue;
    ticketNumber = readDeclaredTicketNumber(
      (payload as { ticketNumber?: unknown }).ticketNumber,
    );
    if (ticketNumber !== undefined) break;
  }
  if (ticketNumber !== undefined) await bindAdmittedTicketNumber(admitted, ticketNumber);
}

/**
 * The ticket a diarist asserted on a completed submission, whether or not the
 * rest of that submission was later accepted (a bounds reask does not unsay the
 * ticket). Before this ran in the leg's accept hook; the leg now only appends its
 * ledger rows and the public call's own process binds the ticket from them.
 */
export async function bindDiaristAssertedTicketNumber(admitted: AdmittedRoleInvocation): Promise<void> {
  if (admitted.ticketNumber !== undefined) return;
  const rows = await readRecordedSubmissionRows(
    admitted.projectRoot,
    admitted.runId,
    ledgerReadScope(admitted),
  );
  for (const row of rows) {
    if (row.role !== admitted.role || !isRecord(row.accepted)) continue;
    if (row.accepted.status !== "completed" || !("ticketNumber" in row.accepted)) continue;
    const ticketNumber = parseTicketNumber(row.accepted.ticketNumber);
    if (ticketNumber !== undefined) {
      await bindAdmittedTicketNumber(admitted, ticketNumber);
      return;
    }
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
  /** Call-owned delivery policy survives every failure-recovery dispatch. */
  receiptDelivery?: ReturnType<typeof createReceiptDeliveryPolicy>;
}): Promise<DispatchOutcomeFor<A, T>> {
  const { admitted, env, io, request, lease, adapters, effectiveEngine } = input;
  const persistRunState = input.persistRunState !== false;
  const deferredPersist = persistRunState ? {} : { needsPersist: true as const };
  const shouldPresent =
    adapters.shouldPresentSettled ?? ((terminal: T) => isLawfulTypedTerminalOutcome(terminal.roleOutcome));
  /**
   * Once-only post-host-turn hook (Diarist bind/relocate, etc.) under the still-held
   * writer lease. Every exit after the host turn has started must pass here before
   * lease release — success and failure alike. When a primary failure terminal already
   * exists, keep that cause and leave relocate failure on the shared diagnostic channel.
   */
  const courtScope = {
    ...settlementScopeForTurn(request),
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
  const receiptDelivery = input.receiptDelivery ?? createReceiptDeliveryPolicy(env.autoResumeLimit);
  let turnDispatched = false;
  // #1132: the AK-side 催交 covers hosts that do not deliver to themselves.
  // Pi runs the package role runtime in-process, and that runtime already issues
  // its own delivery requests at `agent_end` and records the real count — asking
  // again here would double-deliver on one run. External hosts (ACP / headless
  // CLI) have no such in-child loop, so the AK execution seam owns it for them.
  const akSeamDeliversReceipt =
    env.host !== undefined && env.host !== "" && env.host !== DEFAULT_ROLE_TURN_HOST;
  const finishAfterTurn = async (result: DispatchOutcomeFor<A, T>): Promise<DispatchOutcomeFor<A, T>> => {
    if (afterDispatchApplied) return result;
    afterDispatchApplied = true;
    // #1171: placement refresh runs once after each host return (below), before
    // settlement — not again here. finishAfterTurn only binds/relocates sealed tickets.
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
          courtScope.courtAttemptId,
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
        // #1171 F2-R2 / F2-R3 (#419) / F2-R5: only the soft-reask turn itself
        // preserves the sealed terminal face. ticketReasksSpent is budget across
        // rounds — after audit continue, ordinary no-volume turns publish
        // no_receipt honestly. previewOnly skips the terminal pointer;
        // recordAttemptHistory still appends.
        const softTicketReaskNoSeal =
          pendingSettlement !== "sealed" && env.softTicketReaskTurn === true;
        const noSealScope = softTicketReaskNoSeal
          ? {
              ...courtScope,
              previewOnly: true as const,
              recordAttemptHistory: true as const,
            }
          : { ...courtScope, recordAttemptHistory: true as const };
        const terminal = pendingSettlement === "sealed"
          ? await adapters.trySettle(admitted, env.principalAuthority,
              { ...courtScope, recordAttemptHistory: true })
          : await attachRecordedSubmissions(admitted,
              await settleHostEndedNoReceipt(admitted, env.principalAuthority,
                noSealScope, receiptDelivery.issuedDeliveryRequests()) as T,
              noSealScope);
        if (terminal === undefined) throw new Error("settled host attempt vanished before publication");
        result = { ...result, terminal, exitCode: exitCodeForTerminalOutcome(terminal.roleOutcome) };
        // #1171 F2-R7: ownership evidence at this soft-reask turn's seal —
        // mutate the live ownership cell carried on env (survives spreads).
        if (pendingSettlement === "sealed" && env.softTicketReaskTurn === true
          && env.softTicketReaskOwnership !== undefined) {
          env.softTicketReaskOwnership.sealedSubstitute = true;
        }
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
      await bindSealedTicketNumber(admitted);
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
          courtScope.courtAttemptId,
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
          courtScope.courtAttemptId,
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
    if (env.navigatorByStatusPrepare === true) {
      turnRequest = { ...turnRequest, navigatorByStatusPrepare: true };
    }
    // Selected host axis rides the shared Host envelope for in-turn tools
    // (detour usage ledger) — never a pre-spawn current.json reread.
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
    let hostTurnCompleted = false;
    try {
      // A bare `ak-role resume` only forwards the caller's instruction to the
      // host CLI's native resume. Nothing here may gate, redirect or reshape
      // that dispatch on prior conclusions, row counts or report presence;
      // the authoritative post-turn settlement reads whatever really happened.
      turnDispatched = true;
      result = await env.roleTurnHost.executeTurn(turnRequest);
      hostTurnCompleted = true;
      // #1171: one placement refresh before settlement, same try as executeTurn.
      // Failure shares the catch below (refresh-then-settle + #855 cancel wrap).
      const refreshed = await refreshAdmittedPlacementAfterHostTurn(
        admitted,
        env.principalAuthority,
        lease,
      );
      if (refreshed !== undefined) {
        turnRequest = applyRefreshedPlacementToTurn(request, turnRequest, admitted, refreshed);
      }
    } catch (error) {
      // #1171: one placement refresh before settlement — failure is a real cause,
      // never catch-and-continue onto a vanished unbound leaf.
      // Host throw and post-success refresh throw share this catch (#1171 F9).
      const thrown = await settleHostThrowAfterLivePlacementRefresh({
        admitted,
        hostError: error,
        hostTurnCompleted,
        request,
        turnRequest,
        lease,
        adapters,
        env,
        io,
        persistRunState,
        notePackageFault: courtScope.notePackageFault,
        ...(courtScope.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: courtScope.courtAttemptId }),
      });
      turnRequest = thrown.turnRequest;
      return await finishAfterTurn(
        withProcessCancelSkipAutoResume(
          { ...thrown.settled, turnDispatched: true as const, ...deferredPersist },
          env.signal,
        ),
      );
    }

    // #1132: settle this turn through the ONE post-turn settlement authority,
    // then — if it simply produced no receipt — 催交 before settling no_receipt.
    const settledTurn = await settleCompletedHostTurn({
      admitted,
      env,
      io,
      adapters,
      shouldPresent,
      request,
      result,
      persistRunState,
      deferredPersist,
      finishAfterTurn,
      courtScope,
      markPending: (terminal) => { pendingSettlement = "sealed"; pendingTerminal = terminal; },
    });
    if (settledTurn.kind === "settled") return settledTurn.outcome;

    // #1132: 没交卷先回本人催交，不直接结为 no_receipt. The AK execution seam
    // owns the 催交 and its real count. Each request is a real host turn on this
    // same run/session, dispatched and settled through the same two seams as the
    // first turn — never a reduced copy. 催交 never substitutes for host failure
    // recovery: a delivery turn that fails keeps its true cause below.
    // The delivery budget is spent HERE, at the outermost level; only when it is
    // exhausted with still no receipt does the settlement seam record no_receipt.
    while (akSeamDeliversReceipt && receiptDelivery.nextAction() === "request-delivery") {
      // Assembly sits in the same post-start catch as the host call. A throw
      // here is a started turn: resume the session, and do not count a request
      // that never reached the host.
      let deliveryResult: RoleTurnResult;
      let deliveryTurnRequest: RoleTurnRequest;
      let deliveryHostTurnCompleted = false;
      try {
        // Host and the other axes already selected on this turn ride the
        // shared projection. The pre-projection request does not have them.
        const deliveryRequest = buildReceiptDeliveryRequest({
          request: turnRequest,
          receiptDelivery,
        });
        // The same native-resume projection the first turn uses (host adapter owns
        // the resume; AK only hands it the request — ADR 0082).
        deliveryTurnRequest = {
          ...deliveryRequest,
          principal: admitted.principal,
          runDirectory: admitted.runDirectory,
          ...(env.signal === undefined ? {} : { signal: env.signal }),
        };
        receiptDelivery.recordDeliveryRequest();
        deliveryResult = await env.roleTurnHost.executeTurn(deliveryTurnRequest);
        deliveryHostTurnCompleted = true;
        // Same single refresh-before-settle rule as the first turn (#1171):
        // stay inside this try so cancel wrap is not dropped (#1171 F9 / #855).
        const refreshed = await refreshAdmittedPlacementAfterHostTurn(
          admitted,
          env.principalAuthority,
          lease,
        );
        if (refreshed !== undefined) {
          turnRequest = applyRefreshedPlacementToTurn(request, turnRequest, admitted, refreshed);
          deliveryTurnRequest = {
            ...deliveryTurnRequest,
            runDirectory: admitted.runDirectory,
            principal: admitted.principal,
          };
        }
      } catch (error) {
        // 催交 cannot substitute for host failure recovery: a real failure with
        // its true cause, through the one settlement authority (ADR 0080).
        // Same refresh-before-settle seam as the first turn (#1171 F4-R1).
        // Host throw and post-success refresh throw share this catch (#1171 F9).
        const thrown = await settleHostThrowAfterLivePlacementRefresh({
          admitted,
          hostError: error,
          hostTurnCompleted: deliveryHostTurnCompleted,
          request,
          turnRequest,
          lease,
          adapters,
          env,
          io,
          persistRunState,
          notePackageFault: courtScope.notePackageFault,
          ...(courtScope.courtAttemptId === undefined
            ? {}
            : { courtAttemptId: courtScope.courtAttemptId }),
        });
        turnRequest = thrown.turnRequest;
        return await finishAfterTurn(
          withProcessCancelSkipAutoResume(
            {
              ...thrown.settled,
              turnDispatched: true as const,
              ...deferredPersist,
            },
            env.signal,
          ),
        );
      }
      const deliveryTurn = await settleCompletedHostTurn({
        admitted,
        env,
        // Only the final Terminal presents; intermediate delivery attempts stay quiet.
        io: { ...io, stdout: () => {} },
        adapters,
        shouldPresent,
        request: deliveryTurnRequest,
        result: deliveryResult,
        // Run-state terminal write belongs to the OUTERMOST turn only, so a
        // still-silent delivery attempt never makes the run look lawfully terminal.
        persistRunState: false,
        deferredPersist,
        finishAfterTurn,
        courtScope,
        markPending: (terminal) => { pendingSettlement = "sealed"; pendingTerminal = terminal; },
      });
      // The delivery turn's own outcome IS the run's outcome, except when it
      // simply still has no receipt — that is the loop's own case to keep going.
      if (deliveryTurn.kind === "settled") {
        // #1132: the delivery turn settles with persistRunState:false, so a run
        // that ends HERE (得卷 or a real failure) still needs the outermost
        // single run-state write. Without it the ledger says accepted while
        // run-state stays `running`, and every later resume entry (ADR 0080)
        // reads a finished run as live. The still-silent attempts above must
        // NOT write; this one, which ends the run, must.
        if (persistRunState && deliveryTurn.outcome.terminal !== undefined) {
          try {
            await persistReturnedRunState(admitted);
          } catch (error) {
            await recordBestEffortPostDispatchDiagnostic(
              admitted,
              env,
              `run-state persistence failed beside催交 terminal (best-effort continue): ${describeErrorIdentity(error)}`,
              io,
            );
          }
        }
        return await finishAfterTurn(deliveryTurn.outcome);
      }
    }

    const noReceiptScope = { ...courtScope, previewOnly: true as const };
    const noReceipt = await attachRecordedSubmissions(
      admitted,
      await settleHostEndedNoReceipt(
        admitted,
        env.principalAuthority,
        noReceiptScope,
        receiptDelivery.issuedDeliveryRequests(),
      ) as T,
      noReceiptScope,
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
          ...(courtScope.courtAttemptId === undefined
            ? {}
            : { courtAttemptId: courtScope.courtAttemptId }),
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
  } catch (error) {
    if (turnDispatched && !(error instanceof TurnDispatchedFailure)) {
      throw new TurnDispatchedFailure(error);
    }
    throw error;
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
 * - same-ticket summons (审核循环续话): caller/peer words + optional caller file-flag
 *   paths only — no「请重读」、no code-authored content substitute,
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
    readonly attachments: readonly { path: string }[];
  },
): RoleTurnRequestProjectionOptions {
  // #879: officer dialogue is caller/peer words; #1166 J11 merges caller file-flag
  // paths when present. Gate with no file flags stays body-only (ADR 0085).
  const officerDialogue = isStationChildOfficerDialogue(admitted.role, env);
  const fileFlags = summonsPrepared?.attachments ?? [];
  let prompt: string;
  if (request.message !== undefined) {
    if (summonsPrepared !== undefined) {
      // #755: same-ticket review / open-court — caller words + caller file flags.
      prompt = officerDialogue && fileFlags.length === 0
        ? request.message
        : appendCallerFileFlagPaths(request.message, fileFlags);
    } else if (request.summons !== undefined) {
      // #755: same-ticket summons without prepared materials — caller words only.
      prompt = request.message;
    } else {
      prompt = request.message;
    }
  } else if (summonsPrepared !== undefined) {
    const body = summonsPrepared.instruction;
    // No file flags: body alone (gate peer words). With flags: merge delivery.
    prompt = officerDialogue && fileFlags.length === 0
      ? body
      : appendCallerFileFlagPaths(body, fileFlags);
  } else if (request.summons !== undefined) {
    // Same-ticket summons without prepared dialogue. Notary always fills via
    // resolveReviewSeatDialogueBody (#1208); other seats carry parent/caller words.
    prompt = "";
  } else {
    prompt = "";
  }
  return {
    ...projectPublicTurnAxes(env),
    ...(env.host === undefined ? {} : { host: env.host }),
    ...(env.correlationId === undefined && admitted.correlationId === undefined
      ? {}
      : { correlationId: env.correlationId ?? admitted.correlationId }),
    continuation: {
      kind: "resume",
      prompt,
    },
    ...(env.stationChild === undefined ? {} : { stationChild: env.stationChild }),
    ...(env.navigatorByStatusPrepare === true
      ? { navigatorByStatusPrepare: true as const }
      : {}),
    // #1132: one configured ceiling, already resolved by the caller (#422).
    deliveryRequestLimit: deliveryLimitFromConfig(env.autoResumeLimit),
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
    ...projectPublicTurnAxes(env),
    ...(env.host === undefined ? {} : { host: env.host }),
    ...(correlationId === undefined || correlationId.trim() === ""
      ? {}
      : { correlationId }),
    continuation,
    ...(env.stationChild === undefined ? {} : { stationChild: env.stationChild }),
    ...(env.navigatorByStatusPrepare === true
      ? { navigatorByStatusPrepare: true as const }
      : {}),
    // #1132: one configured ceiling, already resolved by the caller (#422).
    deliveryRequestLimit: deliveryLimitFromConfig(env.autoResumeLimit),
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

/**
 * One auto-resume dispatch: deferred run-state persist settles on the same
 * path for station-child and ordinary in-call retries. The caller owns how
 * the turn request is built and which correlation id the env carries.
 */
async function runSettledAutoResumeLoop<
  A extends AdmittedRoleInvocation,
  T extends TerminalResult,
  P,
>(input: {
  admitted: A;
  env: PostAdmissionEnv;
  io: CliIo;
  adapters: PostAdmissionAdapters<A, T>;
  effectiveEngine?: string;
  dispatchEnv?: PostAdmissionEnv;
  buildInitialPayload: () => P;
  buildResumePayload: () => P;
  toRequest: (payload: P) => Promise<RoleTurnRequest>;
}): Promise<{ exitCode: number; admitted?: A; terminal?: T }> {
  const adapters = withOnceSuccessfulBeforeDispatch(input.adapters);
  const dispatchEnv = input.dispatchEnv ?? input.env;
  const receiptDelivery = createReceiptDeliveryPolicy(input.env.autoResumeLimit);
  return runWithAutoResumeLoop({
    admitted: input.admitted,
    principalAuthority: input.env.principalAuthority,
    io: input.io,
    sessionAppender: input.env.sessionAppender,
    autoResumeLimit: input.env.autoResumeLimit,
    ...(input.env.signal === undefined ? {} : { signal: input.env.signal }),
    buildInitialPayload: input.buildInitialPayload,
    buildResumePayload: input.buildResumePayload,
    dispatch: async (payload, lease, _isFirst, attemptIo) =>
      dispatchAfterWriterLease({
        ...(lease === undefined ? {} : { lease }),
        build: () => input.toRequest(payload),
        dispatch: async (request) => {
          const result = await dispatchPostAdmissionTurn({
            admitted: input.admitted,
            env: dispatchEnv,
            io: attemptIo,
            request,
            ...(lease === undefined ? {} : { lease }),
            adapters,
            persistRunState: false,
            receiptDelivery,
            ...(input.effectiveEngine === undefined
              ? {}
              : { effectiveEngine: input.effectiveEngine }),
          });
          return settleDeferredPersist(
            input.admitted,
            input.env,
            attemptIo,
            result,
          );
        },
      }),
  });
}

/**
 * Same-ticket summons materials: caller paths as-is (#1165). No copy or freeze.
 */
export async function prepareSummonsResumeMaterials(
  _runDirectory: string,
  summons: SameTicketSummonsMaterials | undefined,
): Promise<
  | {
      readonly instruction: string;
      readonly instructionEmpty: boolean;
      readonly attachments: readonly { path: string }[];
    }
  | undefined
> {
  if (summons === undefined) return undefined;
  if (summons.instruction === undefined && (summons.attachmentPaths?.length ?? 0) === 0) {
    return undefined;
  }
  const instruction = summons.instruction ?? "";
  const instructionEmpty =
    summons.instructionEmpty ?? instruction.length === 0;
  const attachments = (summons.attachmentPaths ?? []).map((path) => ({ path }));
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
 * settlement identity; internal re-summons passes caller file-flag paths as-is.
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

        // Public explicit resume: attach the stored native id when the caller
        // left it unset (399c3c8c). In-call auto-resume / 催交 / gate retry omit
        // the field; those load inside the host adapter (host-contracts).
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
      type StationChildAttempt = { readonly resumeTurn: boolean };
      // One public call → one detour scope across in-place auto-resume dispatches.
      const invocationScopeId = mintEngineDetourInvocationScope({
        ...(input.effectiveEngine === undefined
          ? {}
          : { effectiveEngine: input.effectiveEngine }),
      });
      return await runSettledAutoResumeLoop({
        admitted: loaded.admitted,
        env,
        io: input.io,
        adapters,
        ...(input.effectiveEngine === undefined
          ? {}
          : { effectiveEngine: input.effectiveEngine }),
        buildInitialPayload: (): StationChildAttempt => ({ resumeTurn: false }),
        buildResumePayload: (): StationChildAttempt => ({ resumeTurn: true }),
        toRequest: async (payload) => {
          // #840 r8 / #1208: call-local retry keeps this court's frozen summons /
          // 交卷 body / attachments and resends the same turn prompt — never a
          // filler phrase or engine handbook substitute.
          if (payload.resumeTurn && firstTurn !== undefined) {
            return {
              ...firstTurn,
              continuation: {
                kind: "resume",
                prompt: firstTurn.continuation.prompt,
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
      (failure) => writeResumeDiagnostic(
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
  knownRunDirectory?: string,
): Promise<boolean> {
  let foundRunDirectory: string | undefined;
  try {
    foundRunDirectory = await findRunDirectoryById(home, runId, undefined, undefined, knownRunDirectory);
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
      writeResumeDiagnostic(runDirectory, runId, failure),
    );
    return true;
  }
  if (record === undefined) return false;
  await presentResumeFailurePointer(io, thrown, (failure) =>
    writeResumeDiagnostic(runDirectory, runId, failure, record.role),
  );
  return true;
}

export async function presentLocatedResumeFailure(
  home: string,
  runId: string,
  authority: DurablePrincipalAuthority,
  io: CliIo,
  thrown: unknown,
  knownRunDirectory?: string,
): Promise<boolean> {
  return await pointExistingRunFailure(home, runId, authority, io, thrown, knownRunDirectory);
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
      message: errorText(thrown),
      cause,
    }, io);
  }
}

async function writeResumeDiagnostic(
  runDirectory: string,
  runId: string,
  failure: ControlledFailure,
  role?: AdmittedRoleInvocation["role"],
): Promise<string> {
  return reportRunRecord(runDirectory, "resume-diagnostic", {
    runId,
    ...(role === undefined ? {} : { role }),
    diagnostic: failure.diagnostic,
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    ...(failure.identity === undefined ? {} : { identity: failure.identity }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
  }, "post-admission").recordFile;
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
  // #1208: auto-resume resends this turn's actual prompt, never a filler phrase.
  return await runPostAdmissionResumable({
    admitted: input.admitted,
    env: input.env,
    io: input.io,
    buildInitialRequest: () => input.request,
    buildResumeRequest: () => ({
      ...input.request,
      continuation: {
        kind: "resume",
        prompt: input.request.continuation.prompt,
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

  // One public call → one detour scope across in-place auto-resume dispatches.
  const invocationScopeId = mintEngineDetourInvocationScope({
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
  });
  const buildScopedInitial = (): RoleTurnRequest =>
    withEngineDetourInvocationScope(buildInitialRequest(), invocationScopeId);
  const buildScopedResume = (): RoleTurnRequest =>
    withEngineDetourInvocationScope(buildResumeRequest(), invocationScopeId);

  return runSettledAutoResumeLoop({
    admitted,
    env,
    io,
    adapters: input.adapters,
    ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
    // Ordinary in-call retry keeps the admitted correlation when one was stored.
    dispatchEnv: {
      ...env,
      ...(admitted.correlationId === undefined ? {} : { correlationId: admitted.correlationId }),
    },
    buildInitialPayload: buildScopedInitial,
    buildResumePayload: buildScopedResume,
    toRequest: async (request) => request,
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
    await presentTerminal(result.terminal, io, admitted.runDirectory);
  }
  if (result.terminal !== undefined) {
    (result.terminal as { autoResumeCount?: number }).autoResumeCount = 0;
  }
  return result;
}
