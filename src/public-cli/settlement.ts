/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #107 / #101).
 * Controlled failures and audit human decisions settle here without washing causes.
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { sessionFileOf, subjectDirectoryOfRun } from "../role-run-placement.ts";
import { parseTicketNumber } from "../run-ticket-number.ts";

import { sitianReport, type RecordPointer } from "../sitian-facade.ts";
import {
  ATTEMPT_HISTORY_IDENTITY_FIELD,
  TERMINAL_COURT_ATTEMPT_FIELD,
  writeRunTerminal,
} from "../run-terminal-artifacts.ts";

import {
  readRecordedSubmissionRows,
  readReceipt,
  type LedgerFault,
  type RecordedSubmissionRow,
} from "../submission-ledger.ts";

import { CONTROLLED_FAILURE_CAUSES, type RoleTurnKnownFailure } from "../host-contracts.ts";
import {
  childSignalDeathDiagnostic,
  processCancelDiagnostic,
  type CatchableProcessSignal,
} from "./process-cancel.ts";
import { readStrictPiSessionJsonl } from "../ledger-session-read.ts";
import { serializeThrownValue } from "../serialize-thrown-value.ts";
import { describeErrorIdentity } from "./run-lifecycle.ts";
import {
  readEngineDetourToolUsage,
  readInvocationEngineMounted,
  runDirectoryFromSessionDirectory,
  sessionFileFromSessionDirectory,
  withEngineDetourToolUsageFact,
} from "../engine-detour-usage.ts";

import type { DoctorCaseCost } from "../doctor-contracts.ts";
import { DOCTOR_CANDIDATE_ENTRY_TYPE } from "../dossier-resolution.ts";
import {
  homeFromRunDirectory,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import { findLatestDurablePackagedRoleTerminal } from "../navigator-invocation-identity.ts";
import {
  isNavigatorSeat,
  packagedRoleMetadata,
  type PackagedArtifactFace,
} from "../packaged-role-registry.ts";
import {
  NO_RECEIPT_LIFECYCLE_ENTRY_TYPE,
  noReceiptLifecycleFacts,
  parseNoReceiptLifecycleFacts,
  priorReceiptContinuation,
  receiptAttemptPointer,
  type NoReceiptLifecycleFacts,
} from "../receipt-delivery-policy.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
  SessionCustomEntryAppender,
} from "../host-contracts.ts";
import { readStateRowsSync, runCurrentPath } from "../run-dossier.ts";
import { reportRunRecord } from "../sitian-facade.ts";

/**
 * Court-turn settlement scope (#637 same-ticket re-summons).
 * courtAttemptId tags the new court; recorded payloads stay run-scoped (#836).
 */
export type SettlementCourtScope = {
  /** Only the dispatched host turn may record this attempt; later reads are projections. */
  readonly recordAttemptHistory?: true;
  /** Inspect a candidate without rewriting history or terminal artifact faces. */
  readonly previewOnly?: true;
  /** Recover the court of an already sealed submission. */
  readonly seal?: "latest" | { readonly receipt: string | undefined };
  readonly courtAttemptId?: string;
  /** Public-invocation scope from the shared Host envelope (#537). */
  readonly invocationScopeId?: string;
  /**
   * Package fault beside an already chosen terminal. The host report stays.
   * Bound by the public court to the one post-dispatch receiver.
   */
  readonly notePackageFault?: (diagnostic: string) => void | Promise<void>;
};

/**
 * One retention path for a package fault beside an already chosen terminal.
 * Session append is first when the caller has that channel. The artifact file
 * is only the fallback after that append throws. Either failure is reported;
 * neither replaces the terminal.
 */
export async function retainPackageFault(input: {
  readonly runDirectory: string;
  readonly diagnostic: string;
  /** Original package exception, independent of the host report. */
  readonly error?: unknown;
  readonly appendSession?: (payload: {
    readonly diagnostic: string;
    readonly recordedAt: string;
  }) => Promise<void>;
  /** The caller this fault belongs to; a quiet nested seat passes it on (callerDiagnostic). */
  readonly io?: Pick<import("./cli-io.ts").CliIo, "stderr" | "callerDiagnostic">;
}): Promise<void> {
  const payload = {
    diagnostic: input.diagnostic,
    recordedAt: new Date().toISOString(),
    ...(Object.hasOwn(input, "error") ? { failure: projectThrownFailureLeaf(input.error) } : {}),
  };
  let retentionFailure: string | undefined;
  // The run's log is the fallback after the session append throws, and the only
  // channel when the caller has none.
  const writeLog = (appendFailure?: ControlledFailure): void => {
    reportRunRecord(input.runDirectory, "post-admission-diagnostic", {
      version: 1,
      ...payload,
      ...(appendFailure === undefined ? {} : { retentionFailure: appendFailure }),
    }, "settlement");
  };
  if (input.appendSession !== undefined) {
    try {
      await input.appendSession(payload);
    } catch (appendError) {
      retentionFailure =
        `post-dispatch diagnostic session append failed (best-effort continue): dossier=${describeErrorIdentity(appendError)}`;
      try {
        writeLog(projectThrownFailureLeaf(appendError));
      } catch (logError) {
        retentionFailure =
          `post-dispatch diagnostic durable retention failed on both channels (best-effort continue): dossier=${describeErrorIdentity(appendError)}; log=${describeErrorIdentity(logError)}`;
      }
    }
  } else {
    try {
      writeLog();
    } catch (logError) {
      retentionFailure =
        `post-dispatch diagnostic durable retention failed (best-effort continue): log=${describeErrorIdentity(logError)}`;
    }
  }
  const stderr = input.io === undefined
    ? (text: string) => { process.stderr.write(text); }
    : input.io.callerDiagnostic ?? input.io.stderr;
  try {
    stderr(formatCliDiagnostic(input.diagnostic));
    if (retentionFailure !== undefined) stderr(formatCliDiagnostic(retentionFailure));
  } catch {
    // Presentation is best-effort beside an already-formed host terminal.
  }
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
export function packageFaultNoteFor(
  admitted: { readonly runDirectory: string; readonly principal: DurablePrincipal },
  env: { readonly sessionAppender: SessionCustomEntryAppender; readonly principalAuthority: DurablePrincipalAuthority },
  io: Pick<import("./cli-io.ts").CliIo, "stderr" | "callerDiagnostic">,
): (diagnostic: string) => Promise<void> {
  return (diagnostic) => retainPackageFault({
    runDirectory: admitted.runDirectory,
    diagnostic,
    appendSession: (payload) => env.sessionAppender(
      env.principalAuthority,
      admitted.principal,
      POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE,
      payload,
    ),
    io,
  });
}

/**
 * ADR 0080: the one disposition for a finishing step that throws once a
 * conclusion is in hand — the true cause is noted beside it and the conclusion
 * stays. Every entry that reaches a submission finishes through this.
 */
export async function besideConclusion<T>(
  note: (diagnostic: string, error: unknown) => Promise<void>,
  step: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    await note(`${step} failed beside host terminal (best-effort continue): ${describeErrorIdentity(error)}`, error);
    return undefined;
  }
}

/** Record a package fault without letting the note replace the terminal. */
export async function noteSettlementFault(
  runDirectory: string,
  scope: SettlementCourtScope | undefined,
  diagnostic: string,
): Promise<void> {
  if (scope?.notePackageFault !== undefined) {
    await scope.notePackageFault(diagnostic);
    return;
  }
  await retainPackageFault({ runDirectory, diagnostic });
}

/**
 * #1201 public identity of a leg's terminal: the ticket it is filed under and
 * the receipts this settle accepted. Row references resolve under the leg's
 * subject directory as it stands now; a leg that has reported no ticket names
 * no ticket and no round.
 */
export function filedIdentity(
  runDirectory: string,
  filed: readonly TerminalReceiptRef[] = [],
): Pick<TerminalResult, "ticket" | "receipts"> {
  const subjectDirectory = subjectDirectoryOfRun(runDirectory);
  if (subjectDirectory === undefined) return {};
  const ticket = parseTicketNumber(basename(subjectDirectory));
  return {
    ...(ticket === undefined ? {} : { ticket }),
    ...(filed.length === 0 ? {} : {
      receipts: filed.map(({ receipt, round }) => ({ receipt: join(subjectDirectory, receipt), ...(round && { round }) })),
    }),
  };
}

export function settlementRows(admitted: Pick<AdmittedRoleInvocation, "projectRoot" | "runId" | "runDirectory">) {
  return readRecordedSubmissionRows(admitted.projectRoot, admitted.runId, {
    home: homeFromRunDirectory(admitted.runDirectory), sessionParent: sessionFileOf(admitted.runDirectory),
  });
}

function projectOriginals(rows: readonly RecordedSubmissionRow[], current?: ReadonlySet<RecordedSubmissionRow>) {
  const submissions: unknown[] = [], payloads: unknown[] = [];
  const receiptErrors: NonNullable<TerminalResult["receiptErrors"]>[number][] = [];
  let requiredFault: LedgerFault | undefined;
  for (const row of rows) {
    try {
      const original = readReceipt(row);
      submissions.push(original);
      if (current?.has(row)) payloads.push(original);
    } catch (error) {
      const diagnostic = errorText(error);
      if (current?.has(row)) requiredFault ??= { diagnostic: `${row.path}: ${diagnostic}`, cause: error };
      receiptErrors.push({ receipt: row.path, diagnostic,
        ...(error instanceof Error ? { identity: thrownIdentity(error) } : {}) });
    }
  }
  const history = { ...(submissions.length && { submissions }), ...(receiptErrors.length && { receiptErrors }) };
  return { payloads, history, requiredFault };
}

/** Attach full ledger submissions onto any settled terminal (#836). */
export async function attachRecordedSubmissions<T extends TerminalResult>(
  admitted: Pick<AdmittedRoleInvocation, "projectRoot" | "runId" | "runDirectory">,
  terminal: T,
  scope?: SettlementCourtScope,
  rows?: readonly RecordedSubmissionRow[],
): Promise<T> {
  const note = (diagnostic: string) => noteSettlementFault(admitted.runDirectory, scope, diagnostic);
  return await besideConclusion(note, "submission history read", async () => {
    if (!rows) {
      const ledger = await settlementRows(admitted);
      for (const issue of [ledger.fault, ledger.discoveryFault, ledger.malformed]) {
        if (issue) await note(issue.diagnostic);
      }
      rows = ledger.rows;
    }
    return { ...terminal, ...projectOriginals(rows).history };
  }) ?? terminal;
}

/**
 * Host ended with no recorded submission — lawful no_receipt (exit 0).
 * Does not invent an output failure for an empty ledger.
 * #953: empty public terminal face — clear every reader-adoptable prior face.
 */
export async function settleHostEndedNoReceipt(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope?: SettlementCourtScope,
  /**
   * #1132: delivery requests this run actually issued. Zero stays zero when
   * nothing was sent and this attempt has no lifecycle fact. A fact already
   * written for this run and attempt supplies the count when it is larger.
   * The budget is never the count, and another loop's resumes are not催交.
   */
  issuedDeliveryRequests = 0,
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const binding = {
    runPointer: admitted.runDirectory,
    attemptPointer: receiptAttemptPointer(admitted.runDirectory, scope?.invocationScopeId),
  };
  // The delivery owner records what actually happened this attempt — whether the
  // terminal tool was called and what was rejected. Present those facts; a fixed
  // `false` / `[]` would assert an empty delivery that never happened
  // (#1032: 无回执如实呈 no_receipt; 单一真源).
  const recorded = await readRecordedNoReceiptFacts(coordinates.sessionFile, binding, scope?.invocationScopeId);
  if (recorded instanceof LifecycleReadFailure) {
    // A present record that cannot be read is not an empty delivery. Omit the
    // facts and keep the real error beside the no_receipt terminal.
    await noteSettlementFault(
      admitted.runDirectory,
      scope,
      `no-receipt lifecycle record could not be read: ${describeErrorIdentity(recorded.error ?? recorded)}`,
    );
    return settleNoReceiptTerminal(admitted, authority, scope, undefined);
  }
  return settleNoReceiptTerminal(
    admitted,
    authority,
    scope,
    noReceiptLifecycleFacts({
      terminalToolCalled: recorded?.terminalToolCalled ?? false,
      rejectedReceipts: recorded?.rejectedReceipts ?? [],
      deliveryTurns: Math.max(issuedDeliveryRequests, recorded?.deliveryTurns ?? 0),
      ...binding,
    }),
  );
}

/** A lifecycle record that exists but could not be read or parsed. */
export class LifecycleReadFailure extends Error {
  /** The underlying read or parse failure, kept whole. */
  readonly error: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LifecycleReadFailure";
    this.error = options?.cause;
  }
}

/**
 * The delivery owner's own lifecycle record for this attempt.
 * - undefined: the owner wrote no record (genuine absence).
 * - LifecycleReadFailure: a record exists but could not be read or parsed.
 */
async function readRecordedNoReceiptFacts(
  sessionFile: string,
  binding: { runPointer: string; attemptPointer: string },
  invocationScopeId?: string,
): Promise<NoReceiptLifecycleFacts | undefined | LifecycleReadFailure> {
  let entries: readonly SessionEntry[];
  try {
    entries = await readBoundSessionEntries(sessionFile);
  } catch (error) {
    // A session that was never written is genuine absence; anything else is a
    // real read failure about this run.
    if (isEnoent(error)) return undefined;
    return new LifecycleReadFailure(
      `session transcript unreadable: ${errorText(error)}`,
      { cause: error },
    );
  }
  const scoped = invocationScopeId !== undefined && invocationScopeId.trim() !== "";
  const entry = (scoped ? entries : entries.slice(currentAttemptStartIndex(entries))).slice().reverse().find(
    (item: SessionEntry) => {
      if (item.customType !== NO_RECEIPT_LIFECYCLE_ENTRY_TYPE
        && item.message?.customType !== NO_RECEIPT_LIFECYCLE_ENTRY_TYPE) return false;
      const raw = item.data ?? item.message?.details;
      return !scoped || !isRecord(raw) || raw.attemptPointer === undefined
        || raw.attemptPointer === binding.attemptPointer;
    },
  );
  const raw = entry?.data ?? entry?.message?.details;
  if (raw === undefined) {
    if (!scoped) return undefined;
    const prior = priorReceiptContinuation(entries, invocationScopeId!);
    return noReceiptLifecycleFacts({ ...prior, ...binding });
  }
  try {
    const facts = parseNoReceiptLifecycleFacts(raw);
    return facts.runPointer === binding.runPointer
      && facts.attemptPointer === binding.attemptPointer
      ? (scoped ? noReceiptLifecycleFacts({ ...priorReceiptContinuation(entries, invocationScopeId!), ...binding }) : facts)
      : undefined;
  } catch (error) {
    return new LifecycleReadFailure(
      `no-receipt lifecycle record is malformed: ${errorText(error)}`,
      { cause: error },
    );
  }
}

async function settleNoReceiptTerminal(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
  facts: NoReceiptLifecycleFacts | undefined,
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const roleOutcome: TerminalRoleOutcome = facts === undefined
    ? {
        kind: "no_receipt", role: admitted.role, status: "no-accepted-receipt",
        decisiveFacts: {},
      }
    : {
        kind: "no_receipt", role: admitted.role, status: "no-accepted-receipt",
        ...facts, decisiveFacts: facts,
      };
  const terminal = await attachEngineDetourToolUsage({
    roleOutcome,
    navigator: isNavigatorSeat(admitted.role)
      ? NAVIGATOR_SEAT_OWN_FACT
      : await extractNavigatorFactFromAdmittedSession(
        coordinates.sessionFile,
        admitted.runDirectory,
        scope,
      ),
    artifacts: [],
    ...filedIdentity(admitted.runDirectory),
  }, coordinates.sessionDirectory, detourUsageContext(admitted, scope));
  return publishSeatSettlement(admitted, authority, scope, { terminal });
}

/** Transitional host-session reads remain only for non-sealed failure and audit evidence. */
function coordinatesFromAdmitted(
  authority: DurablePrincipalAuthority,
  admitted: { readonly principal: DurablePrincipal },
): DurablePrincipalCoordinates {
  return authority.decode(admitted.principal);
}
import {
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  adviceNavigatorFact,
  type ControlledFailureCause,
  type TerminalArtifactRef,
  type TerminalNavigatorFact,
  type TerminalReceiptRef,
  type TerminalResult,
  type TerminalRoleName,
  type TerminalRoleOutcome,
} from "./terminal.ts";

import { isEnoent, isMissingPathError, isRecord, errorText } from "../unknown-value.ts";

export type { ControlledFailureCause };

export {
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
};

/**
 * Preserved post-admission failure (not a role Receipt). The host contract owns
 * the shape; the only difference settlement requires is that a settled failure
 * always carries a diagnostic to present, so `cause` and `identity` stay
 * omitted when no typed fact confirms them (#881 — no fabricated label).
 */
export type ControlledFailure = RoleTurnKnownFailure & {
  readonly diagnostic: string;
  /**
   * Real facts this package observed while handling the call, kept beside the
   * host's report rather than inside its open `details`. `details` belongs to
   * the host: a key written there can collide with a key the host itself
   * carries, and the host's value would be the one lost (host-contracts.ts:41
   * — an open record with no reserved keys).
   */
  readonly packageFact?: PackageSideFact;
  /**
   * Host stderr that is not already this failure's diagnostic. A stderr log
   * or artifact write can fail; the original bytes stay on this object.
   */
  readonly stderr?: string;
};

/**
 * Facts the package itself established, each kept whole. None of them is ever
 * promoted into the host's cause, diagnostic or details.
 */
export type PackageSideFact = {
  /**
   * This package's own view of the host's exit for this call. Kept beside the
   * host's `details`, never inside it.
   */
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  /**
   * The signal that ended the host child on this call, when the host reported
   * one. Beside the host's details, never inside them.
   */
  readonly signal?: string;
  /**
   * Catchable process signal this call actually received. Beside the host's
   * report, never a replacement for it.
   */
  readonly cancelName?: string;
  /** An exception caught after the host already reported this call. */
  readonly thrown?: RoleTurnKnownFailure & { readonly diagnostic: string };
  /** A durable stderr log-line write that failed while handling this call. */
  readonly stderrLogWriteFailure?: unknown;
};

/**
 * Host stderr as recorded — full bytes, no flood filter, no char clip (#836).
 */
export function conciseChildDiagnostic(
  stderr: string,
  fallback: string,
): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? stderr : fallback;
}

export function formatCliDiagnostic(message: string): string {
  return `ak-role: ${message}\n`;
}

/** #836: full diagnostic on stderr — no first-line clip / flood filter. */
export function formatFailureStderrDiagnostic(failure: ControlledFailure): string {
  const text = failure.diagnostic.trim().length > 0 ? failure.diagnostic : "failure";
  const head = formatCliDiagnostic(text);
  const beside = failure.stderr;
  if (beside === undefined || beside.length === 0 || beside === failure.diagnostic) return head;
  return beside.endsWith("\n") ? `${head}${beside}` : `${head}${beside}\n`;
}

/**
 * #676 B: one cause face for public stderr — Error.message, else object JSON with
 * status/body/headers when present, else String. Never wash objects to [object Object].
 */
export function formatErrorCauseDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null) {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
}

/** Pre-admission structural rejection: stderr only, no run, no Terminal. Cause retained when present. */
export function presentStructuralRejection(
  error: { message: string; cause?: unknown },
  io: { stderr: (text: string) => void },
): void {
  let message = error.message;
  const cause = error.cause;
  if (cause !== undefined) {
    const detail = formatErrorCauseDetail(cause);
    if (detail.trim().length > 0) {
      message = `${message}; cause: ${detail}`;
    }
  }
  io.stderr(formatCliDiagnostic(message));
}

/** ControlledFailure face without admitted-run Terminal (stdout body + stderr line). */
export function presentControlledFailure(
  failure: ControlledFailure,
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): void {
  io.stdout(`${JSON.stringify(failure, null, 2)}\n`);
  io.stderr(formatFailureStderrDiagnostic(failure));
}

/**
 * A caught error's identity, read structurally off the thrown value: its name
 * and its `code` when it carries one (an OS errno, typically). The errno
 * travels as data so a consumer asserts the identity instead of recognising
 * the system error by its message wording (质量法: 机器只咬契约，不咬呈现).
 */
export type ThrownErrorIdentity = {
  readonly name: string;
  readonly code?: string | number;
};

function thrownIdentity(error: Error): ThrownErrorIdentity {
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

function isControlledFailureCause(cause: unknown): cause is ControlledFailureCause {
  return CONTROLLED_FAILURE_CAUSES.some((known) => known === cause);
}

/** Production-owned typed thrown failure (explicit-internal channel). */
function isTypedActivationError(
  error: unknown,
): error is Error & {
  knownCause: ControlledFailureCause;
  failureCode?: string | number;
  details?: Readonly<Record<string, unknown>>;
} {
  if (!(error instanceof Error)) return false;
  const cause = (error as { knownCause?: unknown }).knownCause;
  return isControlledFailureCause(cause);
}

/**
 * Project one thrown value into a ControlledFailure leaf.
 * Sole owner for thrown-leaf identity/diagnostic mapping.
 * Aggregate shells and their direct children remain distinct facts.
 */
export function projectThrownFailureLeaf(error: unknown): ControlledFailure {
  const originalDetails = error !== null && typeof error === "object"
    ? (error as { details?: Readonly<Record<string, unknown>> }).details
    : undefined;
  const testimony = {
    error: serializeThrownValue(error),
    ...(error instanceof AggregateError
      ? { concurrentFailures: error.errors.map(projectThrownFailureLeaf) }
      : {}),
  };
  const details = originalDetails === undefined ? testimony : originalDetails;
  const packageFact = originalDetails === undefined ? {} : {
    packageFact: {
      thrown: {
        diagnostic: error instanceof Error ? error.message || error.name || "exception" : "non-Error throw",
        details: testimony,
      },
    },
  };
  if (isTypedActivationError(error)) {
    const identity = thrownIdentity(error);
    return {
      cause: error.knownCause,
      diagnostic: error.message || error.name || "exception",
      identity: error.failureCode !== undefined && identity.code === undefined
        ? { ...identity, code: error.failureCode }
        : identity,
      details,
      ...packageFact,
    };
  }
  if (error instanceof Error) {
    const identity = thrownIdentity(error);
    // No typed confirmation → keep original diagnostic/identity; do not mint a class (#881).
    return {
      diagnostic: error.message || error.name || "exception",
      identity,
      details,
      ...packageFact,
    };
  }
  return {
    diagnostic: error !== null && typeof error === "object" ? "non-Error throw" : String(error),
    details,
    ...packageFact,
  };
}

/**
 * Merge caller-owned secondary evidence into a classified failure without
 * washing path facts. The package's own facts ride along on every branch, so
 * no fallback path silently drops them.
 */
function withKnownDetails(
  failure: ControlledFailure,
  knownDetails: Readonly<Record<string, unknown>> | undefined,
  packageFact?: PackageSideFact,
): ControlledFailure {
  const facts = packageFact === undefined || Object.keys(packageFact).length === 0
    ? undefined
    : packageFact;
  // The host's own details win outright: this helper must not displace a key the
  // host carried. Only when the host supplied no record at all does the
  // classified failure keep the details it derived from the host's exit.
  return {
    ...failure,
    ...(facts === undefined ? {} : { packageFact: facts }),
    // The host's own record replaces the derived one when it supplied one; when
    // it supplied none, the failure keeps what it derived from the host's exit.
    ...(knownDetails === undefined ? {} : { details: knownDetails }),
  };
}

/**
 * Classify a controlled post-admission failure without washing original identities.
 * Cause classes are closed; diagnostic text retains the original identity when known.
 *
 * Order: thrown → knownCause → timeout → activation (nonzero) → clean exit.
 * knownCause precedes timeout so a co-present typed provider/session identity is not
 * washed when the child also timed out. Cause is never inferred from stderr wording.
 * AggregateError shells, direct children and raw testimony stay distinct.
 */
/**
 * Wording for a failure the host reported without a diagnostic of its own. The
 * host's signal or cancellation is named when it gave one; otherwise the exit
 * is. Only ever a fallback — a host that reported a diagnostic keeps it
 * (owner 4743ade7: 代码凭什么要去决定cli的失败原因？).
 */
function hostReportedFallbackOf(input: {
  readonly timedOut?: boolean;
  readonly code?: number | null;
  readonly signal?: string;
  readonly cancelName?: string;
}): string {
  if (input.cancelName !== undefined) return processCancelDiagnostic(input.cancelName as CatchableProcessSignal);
  if (input.signal !== undefined) return childSignalDeathDiagnostic(input.signal);
  if (input.timedOut === true) return "role run timed out";
  return `role run failed with exit ${input.code ?? "null"}`;
}

/** This call's package-side facts, or undefined when there are none. */
function packageFactsOf(input: {
  readonly packageFact?: PackageSideFact;
  readonly code?: number | null;
  readonly timedOut?: boolean;
  readonly signal?: string;
  readonly cancelName?: string;
}): PackageSideFact | undefined {
  const facts: PackageSideFact = {
    ...(input.code === undefined ? {} : { exitCode: input.code }),
    ...(input.timedOut === true ? { timedOut: true } : {}),
    ...(input.signal === undefined || input.signal.length === 0 ? {} : { signal: input.signal }),
    ...(input.cancelName === undefined || input.cancelName.length === 0
      ? {}
      : { cancelName: input.cancelName }),
    ...(input.packageFact ?? {}),
  };
  return Object.keys(facts).length === 0 ? undefined : facts;
}

export function classifyPostAdmissionFailure(input: {
  timedOut: boolean;
  code: number | null;
  stderr: string;
  /**
   * Caught post-admission exception. Presence (own key) is distinct from value:
   * JavaScript permits `throw undefined`, which must keep the original thrown fact rather than
   * being washed into activation/null-exit paths that treat missing thrown as absence.
   */
  thrown?: unknown;
  /** Upstream-typed cause when the failure origin is already known. */
  knownCause?: ControlledFailureCause;
  /** Optional identity paired with knownCause (production channel). */
  knownIdentity?: {
    readonly name?: string;
    readonly code?: string | number;
  };
  /**
   * Optional diagnostic already owned by a typed production field (session
   * errorMessage, runner knownFailure.diagnostic). Preferred over stderr selection.
   */
  knownDiagnostic?: string;
  /** Secondary evidence already carried by the typed production failure. */
  knownDetails?: Readonly<Record<string, unknown>>;
  /** The signal that killed the host child, when one did (a non-normal exit). */
  signal?: string;
  /**
   * A catchable process-signal cancellation the host reported. Like `signal`,
   * it only supplies fallback wording: the host's own diagnostic always wins.
   */
  readonly cancelName?: string;
  /** Further package-side facts merged under `packageFact`, never the cause. */
  packageFact?: PackageSideFact;
}): ControlledFailure {
  // Own-key presence, not value: `throw undefined` is a real caught exception.
  // An exception caught after the host already reported its own failure carries
  // both real facts: the host's report stays the cause, and the later exception
  // is kept beside it (失败诚实宪法：接住可以，洗白不行).
  if (Object.hasOwn(input, "thrown")) {
    const thrown = projectThrownFailureLeaf(input.thrown);
    // A host that carried a details record reported *something* for this call,
    // even with no typed class: that record is its own and must not be
    // displaced by the exception.
    const hostReported = input.knownCause !== undefined
      || (input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== "")
      || input.knownIdentity !== undefined
      || input.knownDetails !== undefined;
    // The host reported no *typed* class, but it did report this call: a
    // nonzero exit, a timeout, or a signal death are its own facts. A later
    // settlement exception does not replace them — it is a different failure
    // and rides beside them (owner 4743ade7: 代码凭什么要去决定cli的失败原因？).
    if (!hostReported) {
      // A number is the host having reported an exit. A null code with a signal
      // is its native signal-death report. Anything else means the host produced
      // no result at all, and then the exception really is the only fact there
      // is — there is nothing of the host's to preserve over it.
      const hostFailed = input.timedOut
        || input.signal !== undefined
        || (typeof input.code === "number" && input.code !== 0);
      if (!hostFailed) {
        const facts = packageFactsOf(input);
        if (facts?.cancelName === undefined && facts?.signal === undefined) return thrown;
        return {
          ...thrown,
          packageFact: { ...facts, ...(thrown.packageFact ?? {}) },
        };
      }
      const facts = packageFactsOf(input);
      const packageFact = facts === undefined ? { thrown } : { ...facts, thrown };
      return {
        ...(input.timedOut ? { cause: "timeout" as const } : {}),
        ...(input.signal === undefined ? {} : { identity: { name: "ChildSignalDeath", code: input.signal } }),
        diagnostic: conciseChildDiagnostic(
          input.stderr,
          hostReportedFallbackOf(input),
        ),
        // The host's record is untouched; this package's view of the exit and
        // the caught exception both ride under `packageFact`.
        packageFact,
      };
    }
    // The host's report is presented exactly as it gave it — a field it left out
    // is not filled in from the exception, which is a different failure. The
    // exception is kept whole beside it under its own key, so neither erases
    // the other (失败诚实宪法：接住可以，洗白不行).
    return {
      ...(input.knownCause === undefined ? {} : { cause: input.knownCause }),
      // A settled failure always presents a diagnostic. The host's own is used
      // when it gave one; when it gave none, this call's own stderr supplies the
      // text. The exception is a different failure and never fills this field —
      // it rides whole under `packageFact` (owner 4743ade7: 代码凭什么要去决定cli的失败原因？).
      diagnostic: input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== ""
        ? input.knownDiagnostic
        : conciseChildDiagnostic(input.stderr, hostReportedFallbackOf(input)),
      ...(input.knownIdentity === undefined
        ? {}
        : { identity: input.knownIdentity }),
      // The host's details are handed back exactly as given.
      ...(input.knownDetails === undefined ? {} : { details: input.knownDetails }),
      // Every fact this package captured on this call — the caught exception and
      // any earlier auxiliary read failure — is reported, none of them dropped.
      packageFact: { ...packageFactsOf(input), thrown },
    };
  }
  // #881: untyped original testimony retains diagnostic/identity, not a
  // fabricated activation/output cause. Bare details remain secondary evidence.
  if (input.knownCause !== undefined ||
    (input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== "") ||
    input.knownIdentity !== undefined) {
    const fallback =
      input.knownCause === "provider" ? "provider failure"
      : input.knownCause === "session" ? "session unreadable"
      : input.knownCause === "output" ? "role run completed without a lawful typed terminal result"
      : input.knownCause === undefined ? "role run failed"
      : `role run failed (${input.knownCause})`;
    const diagnostic = input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== ""
      ? input.knownDiagnostic
      : conciseChildDiagnostic(input.stderr, fallback);
    const packageFact = packageFactsOf(input);
    return {
      ...(input.knownCause === undefined ? {} : { cause: input.knownCause }),
      diagnostic,
      // The host's details are handed back byte-for-byte. This package's own
      // view of the exit rides beside them — writing `exitCode` in there would
      // overwrite a value the host itself carried (host-contracts.ts:41: an
      // open read-only record with no reserved keys).
      ...(input.knownDetails === undefined ? {} : { details: input.knownDetails }),
      ...(packageFact === undefined ? {} : { packageFact }),
      ...(input.knownIdentity === undefined ? {} : { identity: input.knownIdentity }),
    };
  }
  if (input.timedOut) {
    return withKnownDetails(
      {
        cause: "timeout",
        diagnostic: "role run timed out",
        details: { timedOut: true, exitCode: input.code },
      },
      input.knownDetails,
      packageFactsOf(input),
    );
  }
  if (input.code !== 0 || input.cancelName !== undefined) {
    // A nonzero exit or a cancellation says the run failed, not its class. No typed fact confirmed a
    // class, so `cause` stays absent and the CLI's own diagnostic and exit code
    // are what remains (host contract: omit cause, keep the original). A signal
    // or cancellation the host did report is named, not restated as an exit.
    const fallback = hostReportedFallbackOf(input);
    return withKnownDetails(
      {
        diagnostic: conciseChildDiagnostic(input.stderr, fallback),
        details: { exitCode: input.code },
      },
      input.knownDetails,
      packageFactsOf(input),
    );
  }
  // No typed fact confirmed a class, so none is asserted: the host exited
  // cleanly, and the package has nothing to add (host-contracts.ts:19–42: omit
  // cause and keep the original when no typed confirmation exists). A caller
  // that must present a failure for a clean run settles it on the no_receipt
  // path, not by minting a class here.
  return withKnownDetails(
    {
      diagnostic: conciseChildDiagnostic(
        input.stderr,
        "role run completed without a lawful typed terminal result",
      ),
    },
    input.knownDetails,
    packageFactsOf(input),
  );
}

/** One projection owner for the four audited public runners. */
export function explicitInternalKnownFailureClassificationInput(
  failure: RoleTurnKnownFailure | undefined,
) {
  if (failure === undefined) return {};
  return {
    ...(failure.cause === undefined ? {} : { knownCause: failure.cause }),
    ...(failure.identity === undefined ? {} : { knownIdentity: failure.identity }),
    ...(failure.diagnostic === undefined ? {} : { knownDiagnostic: failure.diagnostic }),
    ...(failure.details === undefined ? {} : { knownDetails: failure.details }),
  };
}

/**
 * Post-role Navigator delivery grace (Issue #11 / #101 / #106 / #159).
 * After the parent finishes: wait at most this long for navigator output, then
 * stop waiting. Navigator must already be running from parent start (prepare
 * host round in parallel); this window is only the tail after parent end — not
 * the budget to start a cold full host turn (owner 2026-09-17 #959).
 */
export const NAVIGATOR_POST_ROLE_GRACE_MS = 10_000;

type SessionMessage = {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
  content?: unknown;
  customType?: string;
  /** Native provider-stop fields (pi-ai AssistantMessage). */
  stopReason?: string;
  errorMessage?: string | null;
  provider?: string;
  model?: string;
  api?: string;
  rawStopReason?: string;
  diagnostics?: unknown;
  /** Typed HTTP / SDK structured fields when held on the call surface. */
  statusCode?: number;
  status?: number;
  httpStatus?: number;
  body?: unknown;
  code?: unknown;
  errno?: unknown;
};

type SessionEntry = {
  type?: string;
  customType?: string;
  message?: SessionMessage;
  /** Custom entry payload (e.g. ak-navigator-invocation principal). */
  data?: unknown;
  timestamp?: string;
  /** Session principal id from the durable header entry. */
  id?: string;
  /** Session cwd from the durable header entry. */
  cwd?: string;
  /** Parent session principal on durable child session headers. */
  parentSession?: string;
};

/**
 * Read the exact bound Pi session file principal.
 * Does not scan the session directory for "latest" — resume identity is the file.
 * A malformed line keeps the parser's own error. Callers that already hold a
 * terminal note it; they do not relabel it as a host session cause.
 */
export async function readBoundSessionEntries(
  sessionFile: string,
): Promise<SessionEntry[]> {
  return await readStrictPiSessionJsonl(sessionFile) as SessionEntry[];
}

/**
 * #419 per-attempt process history. 史必追加，指针可覆盖；指针可以覆盖的前提是史已落。
 * Reuses the run session principal's append-only JSONL custom-entry shape
 * (plain custom entries are state records and never enter LLM context), so no
 * second ledger mechanism is introduced.
 */
export const ATTEMPT_HISTORY_ENTRY_TYPE = "ak_run_attempt_history" as const;

/** Complete per-attempt result as recorded in the appended history. */
type AttemptHistoryOutcome =
  | TerminalRoleOutcome
  | ({ kind: "failure"; role: string } & ControlledFailure);

type AttemptHistorySource = {
  readonly role: string;
  readonly runId: string;
  readonly sessionFile: string;
};

function attemptHistorySource(
  admitted: Pick<AdmittedRoleInvocation, "role" | "runId">,
  coordinates: Pick<DurablePrincipalCoordinates, "sessionFile">,
): AttemptHistorySource {
  return {
    role: admitted.role,
    runId: admitted.runId,
    sessionFile: coordinates.sessionFile,
  };
}

/** Append the complete attempt to the package ledger before overwriting pointer artifacts (#419). */
export async function appendRunAttemptHistory(
  source: AttemptHistorySource,
  outcome: AttemptHistoryOutcome,
): Promise<RecordPointer> {
  return sitianReport({
    level: "event",
    kind: "attempt-history",
    subject: { runId: source.runId },
    sessionParent: source.sessionFile,
    payload: { type: ATTEMPT_HISTORY_ENTRY_TYPE, role: source.role, runId: source.runId, outcome },
    source: "settlement",
  });
}

function parseNavigatorAttendanceDetails(
  details: Record<string, unknown>,
): TerminalNavigatorFact {
  const disposition = details.disposition;
  // #959: advice prose is presented as-is. Legacy "recommendation" with next/reason/
  // command is projected into prose so historical sessions still render — never wash
  // a real recommendation into no-advice when any advice body is recoverable.
  if (disposition === "advice" || disposition === "recommendation") {
    let prose: string | undefined;
    if (typeof details.prose === "string" && details.prose.trim() !== "") {
      prose = details.prose;
    } else {
      const next = isRecord(details.next) && typeof details.next.role === "string"
        ? details.next.role
        : undefined;
      const reason = typeof details.reason === "string" && details.reason.trim() !== ""
        ? details.reason
        : undefined;
      const command = typeof details.command === "string" && details.command.trim() !== ""
        ? details.command
        : undefined;
      if (reason !== undefined && next !== undefined) {
        prose = `${reason}（下一步：${next}）`;
      } else if (reason !== undefined) {
        prose = reason;
      } else if (next !== undefined) {
        // Historical recommendation with only typed next — still real advice.
        prose = `下一步：${next}`;
      } else if (command !== undefined) {
        prose = command;
      }
    }
    if (prose === undefined || prose.trim() === "") {
      // Attended but empty body is affirmative no-advice, not unavailable (#959).
      return { disposition: "no-advice" };
    }
    return adviceNavigatorFact({ prose });
  }
  if (disposition === "unavailable") {
    return {
      disposition: "unavailable",
      source:
        typeof details.unavailableSource === "string"
          ? details.unavailableSource
          : "unknown",
      reason:
        typeof details.unavailableReason === "string"
          ? details.unavailableReason
          : "Navigator unavailable",
    };
  }
  // arrival and legacy silence both mean affirmative lawful no next-role advice.
  if (disposition === "no-advice" || disposition === "arrival" || disposition === "silence") {
    return { disposition: "no-advice" };
  }
  return {
    disposition: "unavailable",
    source: "unknown",
    reason: "Navigator attendance disposition is unparseable",
  };
}

/**
 * #537: project this-invocation ak_engine_detour usage onto decisiveFacts.
 * Absent when engine is not mounted; callCount 0 when mounted with zero calls.
 * Never mutates role payloads (ADR 0003 / 0042 / 0052).
 * Scope is the public-invocation id bound once per ak-role call — never
 * courtAttemptId and never Pi session.jsonl toolResult join. Session damage
 * therefore cannot replace an already-formed roleOutcome (no_receipt / failure).
 */
async function attachEngineDetourToolUsage<
  T extends { roleOutcome: TerminalRoleOutcome },
>(
  base: T,
  sessionDirectory: string,
  detourContext: {
    readonly runDirectory?: string;
    readonly invocationScopeId?: string;
    readonly notePackageFault?: SettlementCourtScope["notePackageFault"];
  } = {},
): Promise<T> {
  const runDirectory =
    typeof detourContext.runDirectory === "string" && detourContext.runDirectory.length > 0
      ? detourContext.runDirectory
      : runDirectoryFromSessionDirectory(sessionDirectory);
  const note = (diagnostic: string) => noteSettlementFault(runDirectory,
    detourContext.notePackageFault === undefined ? undefined : { notePackageFault: detourContext.notePackageFault }, diagnostic);
  if (!await besideConclusion(note, "engine mount read", () => readInvocationEngineMounted(runDirectory))) return base;

  // Public-invocation scope from the shared Host envelope (settlement scope), never
  // courtAttemptId and never a detour sidecar file.
  const invocationScopeId =
    typeof detourContext.invocationScopeId === "string" &&
    detourContext.invocationScopeId.length > 0
      ? detourContext.invocationScopeId
      : undefined;

  const sessionFile = sessionFileFromSessionDirectory(sessionDirectory);
  const read = await besideConclusion(note, "engine detour read", async () => ({ usage: await readEngineDetourToolUsage({
    sessionParent: sessionFile,
    engineMounted: true,
    ...(invocationScopeId === undefined ? {} : { invocationScopeId }),
    cwd: runDirectory,
  }) }));
  if (read === undefined) return base;
  return {
    ...base,
    roleOutcome: withEngineDetourToolUsageFact(base.roleOutcome, read.usage),
  };
}

/** Engine-detour usage context from admitted run + settlement scope. */
function detourUsageContext(
  admitted: { readonly runDirectory: string },
  scope?: SettlementCourtScope,
): {
  readonly runDirectory: string;
  readonly invocationScopeId?: string;
  readonly notePackageFault?: SettlementCourtScope["notePackageFault"];
} {
  return {
    runDirectory: admitted.runDirectory,
    ...(scope?.invocationScopeId === undefined || scope.invocationScopeId.length === 0
      ? {}
      : { invocationScopeId: scope.invocationScopeId }),
    ...(scope?.notePackageFault === undefined ? {} : { notePackageFault: scope.notePackageFault }),
  };
}

export function extractNavigatorFact(
  entries: readonly SessionEntry[],
): TerminalNavigatorFact {
  // Affirmative attendance only. Missing / unparseable is never no-advice.
  // The shared lifecycle places the settled event on this submission's closure;
  // an unrelated attendance message cannot supply another call's result.
  const terminal = findLatestDurablePackagedRoleTerminal(entries);
  if (terminal === undefined) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance has no durable packaged role terminal",
    };
  }

  for (let i = terminal.index; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== "ak-role-submission-closure") continue;
    const details = isRecord(entry.data) ? entry.data.navigator : undefined;
    if (!isRecord(details)) break;
    return parseNavigatorAttendanceDetails(details);
  }
  // Absence is not successful no-advice — require affirmative typed attendance.
  return {
    disposition: "unavailable",
    source: "unknown",
    reason: "Navigator attendance is missing from the session",
  };
}

/**
 * Exact-session Navigator fact for failure Terminal settlement.
 * Never infers no-advice from omission; session read failures stay typed unavailable
 * so the controlled-failure Terminal itself still settles.
 */
/** The navigator run is the advice itself; it has no attendance of its own (#1192). */
const NAVIGATOR_SEAT_OWN_FACT: TerminalNavigatorFact = { disposition: "no-advice" };

async function extractNavigatorFactFromAdmittedSession(
  sessionFile: string,
  runDirectory: string,
  scope: SettlementCourtScope | undefined,
): Promise<TerminalNavigatorFact> {
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractNavigatorFact(entries);
  } catch (error) {
    if (isEnoent(error)) {
      return {
        disposition: "unavailable",
        source: "unknown",
        reason: "Navigator attendance is missing from the session",
      };
    }
    await noteSettlementFault(
      runDirectory,
      scope,
      `navigator session read failed beside host terminal: ${sessionFile}: ${describeErrorIdentity(error)}`,
    );
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is unavailable because the session could not be read",
    };
  }
}

/** 甲 pointer + court tag carried on the terminal body for later re-projection. */
function terminalBelongingFields(
  attemptHistoryIdentity: string | undefined,
  scope: SettlementCourtScope | undefined,
): Record<string, string> {
  const courtAttemptId = scope?.courtAttemptId;
  return {
    ...(attemptHistoryIdentity === undefined
      ? {}
      : { [ATTEMPT_HISTORY_IDENTITY_FIELD]: attemptHistoryIdentity }),
    ...(courtAttemptId === undefined || courtAttemptId.length === 0
      ? {}
      : { [TERMINAL_COURT_ATTEMPT_FIELD]: courtAttemptId }),
  };
}

/**
 * Belonging attempt-history identity for a non-recording re-projection (#1161 甲 / R2).
 * Court-tagged settle recovers from that court's own prior terminal row in
 * state.jsonl. Untagged normal rewrite (bare resume after a sealed face, no open
 * court) keeps only the face being rewritten — the last terminal row's own
 * identity. If that face has none (approved gap), return undefined: never walk
 * older terminals for a non-empty pointer, never invent-append (N1), never
 * subject.attemptId on attempt-history. Bare resume therefore cannot restore
 * court B's pointer while the current face is A (or A's gap). Court-tagged
 * lookup that finds no row still returns undefined — the approved gap.
 */
async function belongingAttemptHistoryIdentity(
  runDirectory: string,
  scope: SettlementCourtScope | undefined,
): Promise<string | undefined> {
  const courtAttemptId = scope?.courtAttemptId;
  let rows: readonly Record<string, unknown>[];
  try {
    rows = readStateRowsSync(runDirectory);
  } catch (error) {
    // Documented: history/state failure domain does not block the terminal face
    // (#1161 / main history disposition). True cause must leave a trace.
    await noteSettlementFault(
      runDirectory,
      scope,
      `terminal state read failed beside terminal projection: ${describeErrorIdentity(error)}`,
    );
    return undefined;
  }
  if (courtAttemptId !== undefined && courtAttemptId.length > 0) {
    let found: string | undefined;
    for (const row of rows) {
      if (row.kind !== "terminal" || !isRecord(row.payload)) continue;
      const body = row.payload.body;
      if (!isRecord(body) || body[TERMINAL_COURT_ATTEMPT_FIELD] !== courtAttemptId) continue;
      const identity = body[ATTEMPT_HISTORY_IDENTITY_FIELD];
      if (typeof identity === "string" && identity.length > 0) found = identity;
    }
    return found;
  }
  // Untagged: only the current face (last terminal). Gap face stays a gap.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== "terminal" || !isRecord(row.payload)) continue;
    const body = row.payload.body;
    if (!isRecord(body)) return undefined;
    const identity = body[ATTEMPT_HISTORY_IDENTITY_FIELD];
    return typeof identity === "string" && identity.length > 0 ? identity : undefined;
  }
  return undefined;
}

/** Sealed seats present the ledger. A session tool error does not invent a host failure. */
export type PreparedSeat<T extends TerminalResult = TerminalResult> = { terminal: T; report?: Record<string, unknown> };

export type SeatReadFailure = { failure: ControlledFailure; history: Pick<TerminalResult, "submissions" | "receiptErrors"> };

export function matchesAuditedSeal(pin: { readonly receipt: string | undefined }, row: TerminalReceiptRef): boolean {
  return basename(row.receipt) === pin.receipt;
}

export async function preparePublicSeat(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
): Promise<PreparedSeat | SeatReadFailure | { rows: readonly RecordedSubmissionRow[] }> {
  const { rows, fault, discoveryFault, malformed, lastCourt } = await settlementRows(admitted);
  const accepted = rows.filter(row => row.kind === "accepted" && row.role === admitted.role);
  let attempt = scope?.courtAttemptId ?? scope?.invocationScopeId;
  let unknownCourt = fault;
  let current: RecordedSubmissionRow[] | undefined;
  const pin = scope?.seal === "latest" ? undefined : scope?.seal;
  if (scope?.seal) {
    const seal = pin && accepted.find(row => matchesAuditedSeal(pin, row));
    if (pin) current = seal ? [seal] : [];
    attempt = !pin && typeof lastCourt === "string" ? lastCourt : seal?.attemptId;
    if (!pin && typeof lastCourt === "object") unknownCourt ??= lastCourt;
    if (attempt) scope = { ...scope, courtAttemptId: attempt };
  }
  current ??= accepted.filter(row => attempt !== undefined && row.attemptId === attempt);
  unknownCourt ??= rows.find(row => row.dispositionFault && (pin
    ? matchesAuditedSeal(pin, row) : attempt !== undefined && row.attemptId === attempt))?.dispositionFault;
  for (const issue of [discoveryFault, malformed]) {
    if (issue && issue !== unknownCourt) await noteSettlementFault(admitted.runDirectory, scope, issue.diagnostic);
  }
  if (!current.length && !unknownCourt) return { rows };
  const { payloads, history, requiredFault } = projectOriginals(rows, new Set(current));
  const failed = unknownCourt ?? requiredFault;
  if (failed) return { history, failure: { ...projectThrownFailureLeaf(failed.cause), diagnostic: failed.diagnostic } };
  const roleOutcome = { kind: "accepted" as const, role: admitted.role, payloads };
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  let entries: SessionEntry[] = [];
  let navigator = NAVIGATOR_SEAT_OWN_FACT;
  if (!isNavigatorSeat(admitted.role)) {
    try {
      entries = await readBoundSessionEntries(coordinates.sessionFile);
    } catch (error) {
      if (!isEnoent(error)) await noteSettlementFault(admitted.runDirectory, scope,
        `session read failed beside lawful terminal: ${describeErrorIdentity(error)}`);
    }
    navigator = extractNavigatorFact(entries);
  }
  const terminal = await attachEngineDetourToolUsage({
    ...history, roleOutcome,
    navigator,
    artifacts: [],
    ...filedIdentity(admitted.runDirectory, current),
  }, coordinates.sessionDirectory, detourUsageContext(admitted, scope));
  return { terminal, report: declaredSeatReport(admitted, roleOutcome, entries, scope) };
}

/** The cancellation check and previews do not change the already computed verdict. */
export async function publishSeatSettlement<T extends TerminalResult>(admitted: AdmittedRoleInvocation, authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined, { terminal, report }: PreparedSeat<T>): Promise<T> {
  if (scope?.previewOnly) return terminal;
  const published = await besideConclusion((diagnostic) => noteSettlementFault(admitted.runDirectory, scope, diagnostic), "terminal publication", async () => {
    if (report !== undefined) {
      writeRunTerminal(admitted.runDirectory, "report", report);
      return { ...terminal, artifacts: [{ kind: "report", path: runCurrentPath(admitted.runDirectory) }] };
    }
    const identity = scope?.recordAttemptHistory
      ? (await appendRunAttemptHistory(attemptHistorySource(admitted, coordinatesFromAdmitted(authority, admitted)), terminal.roleOutcome)).identity
      : await belongingAttemptHistoryIdentity(admitted.runDirectory, scope);
    writeRunTerminal(admitted.runDirectory, "no_receipt", {
      role: admitted.role, runId: admitted.runId, outcome: terminal.roleOutcome, ...terminalBelongingFields(identity, scope),
    });
    return terminal;
  });
  return published ?? terminal;
}

/**
 * #836: cost and the auditor's no-receipt facts ride beside the role's
 * testimony on the current attempt's candidate entry. Absence is omitted,
 * never invented. Both facts come from that one entry.
 */
function extractDoctorCandidateFacts(
  entries: readonly SessionEntry[],
): { readonly cost?: DoctorCaseCost; readonly auditNoReceipt?: unknown } {
  const scanStart = currentAttemptStartIndex(entries);
  for (let i = entries.length - 1; i >= scanStart; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== DOCTOR_CANDIDATE_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data;
    if (!isRecord(data)) return {};
    return {
      ...(data.cost === undefined ? {} : { cost: data.cost as DoctorCaseCost }),
      ...(data.auditNoReceipt === undefined ? {} : { auditNoReceipt: data.auditNoReceipt }),
    };
  }
  return {};
}

const EMPTY_ARTIFACT_FACE: PackagedArtifactFace = {};

/** Terminal face for one seat. Absent means the report carries only the shared facts. */
function seatArtifactFace(role: string): PackagedArtifactFace {
  const record = packagedRoleMetadata(role);
  if (record !== undefined && "artifactFace" in record && record.artifactFace !== undefined) {
    return record.artifactFace;
  }
  return EMPTY_ARTIFACT_FACE;
}

function doctorReportFacts(
  face: PackagedArtifactFace,
  roleOutcome: TerminalRoleOutcome,
  entries: readonly SessionEntry[],
): Record<string, unknown> {
  if (face.doctorReportFacts !== true || roleOutcome.kind === "audit_escalation") return {};
  const facts = extractDoctorCandidateFacts(entries);
  return {
    ...(facts.cost === undefined ? {} : { cost: facts.cost }),
    ...(facts.auditNoReceipt === undefined ? {} : { auditNoReceipt: facts.auditNoReceipt }),
  };
}

function declaredSeatReport(
  admitted: AdmittedRoleInvocation,
  roleOutcome: TerminalRoleOutcome,
  entries: readonly SessionEntry[],
  scope: SettlementCourtScope | undefined,
): Record<string, unknown> {
  const face = seatArtifactFace(admitted.role);
  const phase = face.reportPhase === true
    ? { phase: (admitted as { phase?: unknown }).phase }
    : {};
  // The seal names the original. The terminal carries verdict facts only.
  const { payloads: _payloads, ...verdict } = roleOutcome as TerminalRoleOutcome & { payloads?: unknown };
  return {
    role: admitted.role,
    runId: admitted.runId,
    ...phase,
    outcome: verdict,
    ...doctorReportFacts(face, roleOutcome, entries),
    ...terminalBelongingFields(undefined, scope),
  };
}

/** Latest top-level user message index; 0 when the session has none (initial attempt). */
function currentAttemptStartIndex(entries: readonly SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      return i;
    }
  }
  return 0;
}


/**
 * Replace the leg's terminal with the controlled failure. A write failure
 * propagates: the caller notes it beside the host terminal.
 */
export async function publishFailureTerminal(
  admitted: AdmittedRoleInvocation,
  failure: ControlledFailure,
  coordinates: DurablePrincipalCoordinates,
  onErrorPublished?: (path: string) => void,
  scope?: SettlementCourtScope,
): Promise<TerminalArtifactRef[]> {
  // #419: a dispatched failure joins history before the terminal changes. A history
  // write failure never strands the failure terminal; it is rethrown after it.
  let historyFailure: unknown;
  let historyFailed = false;
  const failureOutcome = { kind: "failure" as const, role: admitted.role, ...failure };
  let attemptHistoryIdentity: string | undefined;
  if (scope?.recordAttemptHistory === true) {
    try {
      const pointer = await appendRunAttemptHistory(
        attemptHistorySource(admitted, coordinates),
        failureOutcome,
      );
      attemptHistoryIdentity = pointer.identity;
    } catch (error) {
      historyFailure = error;
      historyFailed = true;
    }
  } else {
    attemptHistoryIdentity = await belongingAttemptHistoryIdentity(
      admitted.runDirectory,
      scope,
    );
  }
  writeRunTerminal(admitted.runDirectory, "error", {
    kind: "error",
    role: admitted.role,
    runId: admitted.runId,
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    diagnostic: failure.diagnostic,
    ...(failure.identity === undefined ? {} : { identity: failure.identity }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
    // This package's own facts, kept beside the host's report.
    ...(failure.packageFact === undefined ? {} : { packageFact: failure.packageFact }),
    ...(failure.stderr === undefined ? {} : { stderr: failure.stderr }),
    ...terminalBelongingFields(attemptHistoryIdentity, scope),
  });
  const path = runCurrentPath(admitted.runDirectory);
  onErrorPublished?.(path);
  if (historyFailed) throw historyFailure;
  return [{ kind: "error", path }];
}

/**
 * Shared controlled-failure Terminal settlement (#107 ownership).
 * Role identity comes from the admitted run; no new failure classes are introduced here.
 */
export async function settleFailureTerminalResult(
  admitted: AdmittedRoleInvocation,
  failure: ControlledFailure,
  authority: DurablePrincipalAuthority,
  options: SettlementCourtScope & {
    readonly onErrorPublished?: (path: string) => void;
  } = {},
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  // Exact-session attendance only — never infer no-advice from caller omission.
  const navigator = isNavigatorSeat(admitted.role)
    ? NAVIGATOR_SEAT_OWN_FACT
    : await extractNavigatorFactFromAdmittedSession(
      sessionFile,
      admitted.runDirectory,
      options,
    );
  const artifacts: TerminalArtifactRef[] = options.previewOnly === true ? [] : await besideConclusion(
    (diagnostic) => noteSettlementFault(admitted.runDirectory, options, diagnostic), "failure artifact publication",
    () => publishFailureTerminal(admitted, failure, coordinates, options.onErrorPublished, options)) ?? [];
  const decisiveFacts: Record<string, unknown> = {
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    diagnostic: failure.diagnostic,
  };
  if (failure.identity?.name !== undefined) {
    decisiveFacts.errorName = failure.identity.name;
  }
  if (failure.identity?.code !== undefined) {
    decisiveFacts.errorCode = failure.identity.code;
  }
  if (failure.details !== undefined) {
    decisiveFacts.secondaryEvidence = failure.details;
  }
  if (failure.packageFact !== undefined) {
    decisiveFacts.packageFact = failure.packageFact;
  }
  if (failure.stderr !== undefined) {
    decisiveFacts.stderr = failure.stderr;
  }
  const roleOutcome: TerminalRoleOutcome = {
    kind: "failure",
    role: admitted.role,
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    diagnostic: failure.diagnostic,
    decisiveFacts,
  };
  return attachEngineDetourToolUsage(
    { roleOutcome, navigator, artifacts, ...filedIdentity(admitted.runDirectory) },
    sessionDirectory,
    detourUsageContext(admitted, options),
  );
}

/**
 * Emit the concise stderr diagnostic beside a settled failure volume.
 * Artifacts are already durable on the TerminalResult.
 */
export function presentFailureDiagnostic(
  terminal: TerminalResult,
  io: Pick<import("./cli-io.ts").CliIo, "stderr" | "omitFailureStderrDiagnostic">,
): void {
  if (terminal.roleOutcome.kind !== "failure" && terminal.roleOutcome.kind !== "no_receipt") {
    throw new TypeError("presentFailureDiagnostic requires a failure or no-receipt role outcome");
  }
  if (terminal.roleOutcome.kind === "failure") {
    if (io.omitFailureStderrDiagnostic) return;
    const hostStderr = terminal.roleOutcome.decisiveFacts.stderr;
    io.stderr(formatFailureStderrDiagnostic({
      ...(terminal.roleOutcome.cause === undefined ? {} : { cause: terminal.roleOutcome.cause }),
      diagnostic: terminal.roleOutcome.diagnostic,
      ...(typeof hostStderr === "string" && hostStderr.length > 0 ? { stderr: hostStderr } : {}),
    }));
    return;
  }
  // #676 D1/J3: no_receipt stays lawful exit 0; surface durable target-bind clarification on stderr.
  const bindDiagnostic = terminal.roleOutcome.decisiveFacts.targetBindDiagnostic;
  if (typeof bindDiagnostic === "string" && bindDiagnostic.trim() !== "") {
    io.stderr(formatFailureStderrDiagnostic({
      cause: "output",
      diagnostic: bindDiagnostic,
    }));
  }
}

/** Optional cancel hook so early settle can release an in-flight grace sleep. */
export type NavigatorGraceSleep = ((ms: number) => Promise<void>) & {
  cancel?: () => void;
};

function defaultNavigatorGraceSleep(): NavigatorGraceSleep {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = ((ms: number) =>
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        resolve();
      }, ms);
    })) as NavigatorGraceSleep;
  sleep.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return sleep;
}

/**
 * Race a promise against the post-role Navigator grace.
 * On timeout, returns the timeout sentinel; the caller records unavailable and
 * ignores or disposes late completion.
 * When work settles first, the grace sleep is canceled synchronously so its
 * timer/resource cannot keep the process alive after the race resolves.
 */
export function raceNavigatorGrace<T>(
  work: Promise<T>,
  graceMs: number = NAVIGATOR_POST_ROLE_GRACE_MS,
  sleep: NavigatorGraceSleep = defaultNavigatorGraceSleep(),
): Promise<{ status: "done"; value: T } | { status: "timeout" }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      sleep.cancel?.();
      action();
    };
    void work.then(
      (value) => finish(() => resolve({ status: "done", value })),
      (error) => finish(() => reject(error)),
    );
    void sleep(graceMs).then(() => {
      finish(() => resolve({ status: "timeout" }));
    });
  });
}
