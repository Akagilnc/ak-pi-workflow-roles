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
import { readSealedSubmission } from "../submission-ledger.ts";
import { clearReviewerDispatchRejection } from "./reviewer-dispatch-rejection.ts";
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
import type { NamedRoleTurnHostAdapter } from "./role-turn-host-resolution.ts";
import {
  type TerminalResult,
  type TerminalRoleName,
} from "./terminal.ts";
import { persistReturnedRunState, runWithAutoResumeLoop } from "./auto-resume.ts";

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
 * Pure, I/O-free failure terminal for a dispatch-scoped exception that
 * escaped every more specific handler in dispatchPostAdmissionTurn (#840 r9
 * 判词 class 1 boundary: "覆盖 executeTurn 已启动后至返回带 turnDispatched
 * 结果前的全部异常,不限于 clearCurrentCourt 实例"). This is the backstop
 * catch's only tool, so it must never itself throw.
 */
function synthesizeDispatchExceptionTerminal(
  admitted: { readonly runId: string; readonly role: TerminalRoleName },
  error: unknown,
): TerminalResult {
  const diagnostic = `dispatch settlement threw after the host turn started: ${describeErrorIdentity(error)}`;
  const decisiveFacts: Record<string, unknown> = { cause: "unrecognized", diagnostic };
  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate?.name === "string") decisiveFacts.errorName = candidate.name;
  if (typeof candidate?.code === "string" || typeof candidate?.code === "number") {
    decisiveFacts.errorCode = candidate.code;
  }
  return {
    roleOutcome: {
      kind: "failure",
      role: admitted.role,
      cause: "unrecognized",
      diagnostic,
      decisiveFacts,
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: admitted.runId,
  };
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

  if (persistRunState) {
    await persistReturnedRunState(admitted, authority);
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
    await markRunRunning(admitted.runDirectory, env.model, effectiveEngine, env.host);

    let result: RoleTurnResult;
    try {
      result = await env.roleTurnHost.executeTurn(turnRequest);
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
      return { ...settled, turnDispatched: true as const, ...deferredPersist };
    }

    // Everything below runs after the host turn genuinely started. The outer
    // catch is a last-resort net (#840 r9 判词 class 1 boundary — "覆盖
    // executeTurn 已启动后至返回带 turnDispatched 结果前的全部异常,不限于
    // clearCurrentCourt 实例"): every specific handler below already returns
    // rather than rethrows, so only a failure inside one of those handlers
    // themselves (e.g. presentControlledFailure's own settlement/observation
    // reads) can still reach it.
    try {
      try {
        await writeFile(
          join(admitted.runDirectory, "stderr.log"),
          result.stderr,
          "utf8",
        );
      } catch (error) {
        // Best-effort: the turn's own stderr capture is secondary to lawful /
        // controlled-failure settlement below, but the failure itself must
        // still leave a trace (失败诚实宪法 真因必须落痕), not a silent catch.
        io.stderr(
          formatCliDiagnostic(
            `stderr.log write failed (best-effort continue): ${describeErrorIdentity(error)}`,
          ),
        );
      }

      let settled: T | undefined;
      // Same-ticket re-summons carry courtAttemptId — settle only that attempt so a
      // prior sealed pass cannot wash this turn's missing/escalated/failed result.
      const courtScope =
        request.courtAttemptId === undefined || request.courtAttemptId.length === 0
          ? undefined
          : { courtAttemptId: request.courtAttemptId };
      try {
        settled = await adapters.trySettle(admitted, env.principalAuthority, courtScope);
      } catch (error) {
        // Settle throw is a real failure fact — never swallow into undefined.
        const settledFailure = (await presentControlledFailure(
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
        )) as { exitCode: number; admitted: A; terminal: T };
        return { ...settledFailure, turnDispatched: true as const, ...deferredPersist };
      }
      if (settled !== undefined && shouldPresent(settled)) {
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
            // summons over already-delivered work (#840 r9 判词 class 1 已交劳动
            // 只整理终局不重做). A later bare resume self-heals: buildRequestAfterLease
            // finds the open court already sealed and clears it then (documented
            // continue-under-failure contract, not a swallow — 失败诚实宪法 真因
            // 必须落痕).
            io.stderr(
              formatCliDiagnostic(
                `current-court cleanup failed after accepted settlement (best-effort continue, self-heals on next resume): ${describeErrorIdentity(error)}`,
              ),
            );
          }
        }
        // Lawful persist + present is the caller's stop seam (auto-resume loop /
        // manual resume), not this retried host-turn function.
        return {
          exitCode: exitCodeForTerminalOutcome(settled.roleOutcome),
          admitted,
          terminal: settled,
          turnDispatched: true as const,
          ...deferredPersist,
        };
      }

      // Any exception while resolving the failure facts below — including the
      // session-file decode itself — still happened after the host turn
      // genuinely started (#840 r9 判词 class 1). Fold it into the same single
      // controlled-failure settlement instead of losing turnDispatched to an
      // uncaught throw.
      let failureInput: ControlledFailureInput;
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
        const resolution = await resolveAuditedRunnerFailureResolution({
          runner: runnerKnownFailure,
          sessionFile,
          credential: credentialFailure,
          runDirectory: admitted.runDirectory,
        });
        failureInput = {
          timedOut: result.timedOut,
          code: result.code,
          stderr: result.stderr,
          ...controlledFailureInputFromResolution(resolution),
        };
      } catch (error) {
        failureInput = {
          timedOut: false,
          code: result.code,
          stderr: result.stderr,
          thrown: error,
        };
      }
      const failed = (await presentControlledFailure(
        admitted,
        failureInput,
        adapters,
        env.principalAuthority,
        io,
        persistRunState,
      )) as { exitCode: number; admitted: A; terminal: T };
      return { ...failed, turnDispatched: true as const, ...deferredPersist };
    } catch (error) {
      // Last-resort net: pure synthesis plus a best-effort persist attempt —
      // no further fallible step may run here, or the dispatch fact could be
      // lost one level up again (#840 r9 判词 class 1).
      if (persistRunState) {
        try {
          await persistReturnedRunState(admitted, env.principalAuthority);
        } catch {
          // best-effort — the terminal below still carries the true cause.
        }
      }
      const terminal = synthesizeDispatchExceptionTerminal(admitted, error);
      presentFailureTerminal(terminal, io);
      return {
        exitCode: 1,
        admitted,
        terminal: terminal as T,
        turnDispatched: true as const,
        ...deferredPersist,
      };
    }
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
  let prompt: string;
  if (request.message !== undefined) {
    if (summonsPrepared !== undefined) {
      // #755: same-ticket review / open-court — caller words + optional paths.
      // Attachments are not a gate: message-only summons must stay plain too.
      prompt = buildInstructionTransportPrompt({
        instruction: request.message,
        instructionEmpty: false,
        attachments: summonsPrepared.attachments,
      });
    } else if (request.summons !== undefined) {
      // #755: same-ticket summons without prepared materials — caller words only.
      prompt = request.message;
    } else {
      // Bare manual resume — outsourcing engine axis keeps handbook (#600/#736).
      prompt = buildResumeContinuationPrompt({
        packageRoot: env.packageRoot,
        ...(env.engine === undefined ? {} : { engine: env.engine }),
        message: request.message,
      });
    }
  } else if (summonsPrepared !== undefined) {
    // #755: same-ticket review summons — instruction/attachments only.
    prompt = buildInstructionTransportPrompt(summonsPrepared);
  } else if (request.summons !== undefined) {
    // #755: same-ticket summons with no instruction/attachments (e.g. notary
    // source-run pointer) — plain resume envelope, no handbook / 重新读.
    prompt = RESUME_TRANSPORT_ENVELOPE;
  } else {
    // Bare manual resume — outsourcing engine axis keeps handbook (#600/#736).
    prompt = buildResumeContinuationPrompt({
      packageRoot: env.packageRoot,
      ...(env.engine === undefined ? {} : { engine: env.engine }),
    });
  }
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

        // Bare resume: read + seal-judge + bound clear only under the held lease.
        if (request.summons === undefined) {
          const openCourt = await readCurrentCourt(admittedForBuild.runDirectory);
          if (openCourt !== undefined) {
            const sealedForOpen = await readSealedSubmission(
              admittedForBuild.projectRoot,
              admittedForBuild.runId,
              {
                home: homeFromRunDirectory(admittedForBuild.runDirectory),
                attemptId: openCourt.courtAttemptId,
              },
            );
            if (sealedForOpen === undefined) {
              // Continue open court: same summons materials + existing courtAttemptId.
              // Caller message (if any) stays on the request — projection keeps it.
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
            } else {
              // Open court already sealed — clear only the court id just judged.
              await clearCurrentCourt(
                admittedForBuild.runDirectory,
                openCourt.courtAttemptId,
              );
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
      const engine = input.effectiveEngine ?? input.env.engine;
      const stationAdapters = withOnceSuccessfulBeforeDispatch(adapters);
      type StationChildAttempt = { readonly resumeTurn: boolean };
      return await runWithAutoResumeLoop({
        admitted: loaded.admitted,
        principalAuthority: input.env.principalAuthority,
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
              if (payload.resumeTurn && firstTurn !== undefined) {
                return {
                  ...firstTurn,
                  continuation: {
                    kind: "resume",
                    prompt: buildResumeContinuationPrompt({
                      packageRoot: input.env.packageRoot,
                      ...(engine === undefined ? {} : { engine }),
                    }),
                  },
                };
              }
              const turnRequest = await buildRequestAfterLease();
              firstTurn = turnRequest;
              return turnRequest;
            },
            dispatch: (turnRequest) =>
              dispatchPostAdmissionTurn({
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
              }),
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
  const engine = input.effectiveEngine ?? input.env.engine;
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
          ...(engine === undefined ? {} : { engine }),
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
        persistRunState: false,
        // #600: every attempt (initial + auto-resume) writes seat engine when present.
        ...(effectiveEngine === undefined ? {} : { effectiveEngine }),
      }),
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
    await persistReturnedRunState(admitted, env.principalAuthority, { lawful: true });
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
