/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #107 / #101).
 * Controlled failures and audit human decisions settle here without washing causes.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

import {
  readAnalystGateCyclesFromAuditorRoles,
  type AnalystGateCycleRound,
} from "../analyst-gate-cycles-read.ts";
import { sitianReport } from "../sitian-facade.ts";

import {
  readAttemptScopedSubmissionRows,
  readRecordedSubmissionRows,
  readRecordedSubmissions,
} from "../submission-ledger.ts";

import { CONTROLLED_FAILURE_CAUSES, type RoleTurnKnownFailure } from "../host-contracts.ts";
import { serializeThrownValue } from "../serialize-thrown-value.ts";
import {
  isV1ResumableProvider,
  readLatestTypedProviderHttpObservation,
  readTypedHttp429Observation,
  type TypedHttp429Observation,
  type TypedProviderHttpObservation,
} from "./run-lifecycle.ts";
import {
  projectEngineDetourToolUsageForPublicTerminal,
  readEngineDetourToolUsage,
  readInvocationEngineMounted,
  runDirectoryFromSessionDirectory,
  sessionFileFromSessionDirectory,
  withEngineDetourToolUsageFact,
} from "../engine-detour-usage.ts";

import type { DoctorCaseCost } from "../doctor-contracts.ts";
import { DOCTOR_CANDIDATE_ENTRY_TYPE } from "../dossier-resolution.ts";
import {
  ensureRunArtifactsDir,
  homeFromRunDirectory,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  SECRETARIAT_COUNTERSIGN_TERMINAL_FACT_KEY,
  SECRETARIAT_GATE_OFFICER_ENTRY_TYPE,
} from "../secretariat-contracts.ts";
import {
  classifyPackagedRoleTerminalResult,
  findLatestDurablePackagedRoleTerminal,
  NAVIGATOR_ROUTE_PLAYBOOK_FAILURE_ENTRY,
} from "../navigator-invocation-identity.ts";
import {
  packagedDurableOfficerEntry,
  packagedRoleAcceptedOutputTool,
  packagedRoleMetadata,
  packagedSkipsGateOnInfrastructureStage,
  type PackagedArtifactFace,
  type PackagedArtifactLeaf,
} from "../packaged-role-registry.ts";
import {
  RECEIPT_DELIVERY_TURN_LIMIT,
  currentAttemptPointer,
  noReceiptLifecycleFacts,
  type NoReceiptLifecycleFacts,
} from "../receipt-delivery-policy.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
} from "../host-contracts.ts";
import { roleRunArtifactsDirectory } from "../role-run-placement.ts";
import { rewriteRunDirectoryPathValue } from "../role-run-relocation.ts";
import {
  listSeamOwnedUniqueErrorFacePaths,
  uniqueErrorFallbackName,
  UNIQUE_ERROR_FALLBACK_STEM,
  RUN_TERMINAL_ARTIFACT_FILES,
  RUN_TERMINAL_ERROR_FALLBACK_RELATIVE_PATHS,
  RUN_TERMINAL_REPORT_FILE,
  RUN_TERMINAL_ERROR_FILE,
  RUN_TERMINAL_EVIDENCE_FILE,
  RUN_TERMINAL_ERROR_SETTLEMENT_FILE,
} from "../run-terminal-artifacts.ts";

/** Ledger reads use the run's machine home — not ambient process HOME (child write vs parent settle). */
function sealedLedgerHome(admitted: Pick<AdmittedRoleInvocation, "runDirectory">): string {
  return homeFromRunDirectory(admitted.runDirectory);
}

/**
 * Court-turn settlement scope (#637 same-ticket re-summons).
 * courtAttemptId tags the new court; recorded payloads stay run-scoped (#836).
 */
export type SettlementCourtScope = {
  /** Only the dispatched host turn may record this attempt; later reads are projections. */
  readonly recordAttemptHistory?: true;
  /** Inspect a candidate without rewriting history or terminal artifact faces. */
  readonly previewOnly?: true;
  readonly courtAttemptId?: string;
  /** Public-invocation scope from the shared Host envelope (#537). */
  readonly invocationScopeId?: string;
};

export function ledgerReadScope(
  admitted: Pick<AdmittedRoleInvocation, "runDirectory">,
  scope?: SettlementCourtScope,
): { home: string; sessionParent: string; attemptId?: string } {
  return {
    home: sealedLedgerHome(admitted),
    sessionParent: join(admitted.runDirectory, "session", "session.jsonl"),
    ...(scope?.courtAttemptId === undefined || scope.courtAttemptId.length === 0
      ? {}
      : { attemptId: scope.courtAttemptId }),
  };
}

function roleOutcomeFromRows(
  role: TerminalRoleName,
  rows: readonly {
    readonly role?: TerminalRoleName;
    readonly kind: "accepted" | "audit-escalation" | "correctable-rejection" | "infrastructure" | "candidate";
    readonly accepted: unknown;
    readonly auditReceipt?: unknown;
    readonly auditOfficer?: unknown;
  }[],
): Extract<TerminalRoleOutcome, { kind: "accepted" | "audit_escalation" }> | undefined {
  const mine = rows.filter((row) => row.role === role);
  // Terminal acceptance kind still only follows sealed / audit-escalation (#881):
  // correctable-rejection / infrastructure / candidate stay payloads, not acceptance.
  const terminal = mine.filter(
    (row) => row.kind === "accepted" || row.kind === "audit-escalation",
  );
  if (terminal.length === 0) return undefined;
  // Full sequence stays on payloads. The queue kind follows the latest terminal
  // row only — an earlier escalation must not outrank a later acceptance or
  // keep that earlier receipt (#1057).
  const payloads = mine.map((row) => row.accepted);
  const latest = terminal[terminal.length - 1]!;
  if (latest.kind === "audit-escalation") {
    return {
      kind: "audit_escalation", role, status: "audit_escalation", payloads,
      ...(Object.hasOwn(latest, "auditReceipt") ? { decisiveFacts: {
        auditEscalationReceipt: latest.auditReceipt,
        ...(Object.hasOwn(latest, "auditOfficer") ? { auditEscalationOfficer: latest.auditOfficer } : {}),
      } } : {}),
    };
  }
  return { kind: "accepted", role, payloads };
}

async function sealedLedgerOutcome(
  admitted: AdmittedRoleInvocation,
  role: TerminalRoleName,
  scope?: SettlementCourtScope,
): Promise<Extract<TerminalRoleOutcome, { kind: "accepted" | "audit_escalation" }> | undefined> {
  const home = sealedLedgerHome(admitted);
  // #879: when court scope is present, roleOutcome is this-court original only —
  // never last-wins over an undivided historical array, and never falls back to
  // full-run history when this court sealed zero rows. #836 presentation of full
  // history stays on attachRecordedSubmissions / terminal.submissions (run-scoped).
  if (scope?.courtAttemptId !== undefined && scope.courtAttemptId.length > 0) {
    const thisCourt = await readAttemptScopedSubmissionRows(
      admitted.projectRoot,
      admitted.runId,
      scope.courtAttemptId,
      home,
    );
    // Scope present + zero this-court rows → no this-court outcome (not run history).
    return roleOutcomeFromRows(role, thisCourt);
  }
  // No court scope: keep run-scoped ledger face (#836).
  const rows = await readRecordedSubmissionRows(
    admitted.projectRoot,
    admitted.runId,
    ledgerReadScope(admitted, scope),
  );
  return roleOutcomeFromRows(role, rows);
}

/** #836: every raw role payload in settle scope (调几次记几次). */
export async function recordedSubmissionPayloads(
  admitted: Pick<AdmittedRoleInvocation, "projectRoot" | "runId" | "runDirectory">,
  scope?: SettlementCourtScope,
): Promise<readonly unknown[]> {
  return readRecordedSubmissions(
    admitted.projectRoot,
    admitted.runId,
    ledgerReadScope(admitted, scope),
  );
}

export function withSubmissions<T extends TerminalResult>(
  terminal: T,
  submissions: readonly unknown[],
): T {
  if (submissions.length === 0) return terminal;
  // Run history is presentation, never a substitute for this court's reply (#879).
  return { ...terminal, submissions };
}

/** Attach full ledger submissions onto any settled terminal (#836). */
export async function attachRecordedSubmissions<T extends TerminalResult>(
  admitted: Pick<AdmittedRoleInvocation, "projectRoot" | "runId" | "runDirectory">,
  terminal: T,
  scope?: SettlementCourtScope,
): Promise<T> {
  // #836 / #879: submissions presentation is always run-scoped history. Do not
  // pass courtAttemptId here — roleOutcome already carries this-court payloads
  // from sealedLedgerOutcome when scoped; withSubmissions keeps them.
  void scope;
  const result = withSubmissions(
    terminal,
    await recordedSubmissionPayloads(admitted, undefined),
  );
  const errorPath = privateFailureErrorPaths.get(terminal);
  if (errorPath !== undefined) privateFailureErrorPaths.set(result, errorPath);
  return result;
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
): Promise<TerminalResult> {
  const facts = noReceiptLifecycleFacts({
    terminalToolCalled: false,
    rejectedReceipts: [],
    deliveryTurns: RECEIPT_DELIVERY_TURN_LIMIT,
    runPointer: admitted.runDirectory,
    attemptPointer: currentAttemptPointer(admitted.runDirectory),
  });
  return settleNoReceiptTerminal(admitted, authority, scope, facts);
}

async function settleNoReceiptTerminal(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
  facts: NoReceiptLifecycleFacts,
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const roleOutcome: TerminalRoleOutcome = {
    kind: "no_receipt", role: admitted.role, status: "no-accepted-receipt",
    ...facts, decisiveFacts: facts,
  };
  if (scope?.recordAttemptHistory === true) {
    await appendRunAttemptHistory(
      { role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile },
      roleOutcome,
    );
  }
  if (scope?.previewOnly !== true) await clearOppositeTerminalArtifactFace(admitted.runDirectory);
  return withOptionalGateProjection({
    roleOutcome,
    navigator: await extractNavigatorFactFromAdmittedSession(coordinates.sessionFile),
    artifacts: [],
    runId: admitted.runId,
  }, coordinates.sessionDirectory, detourGateContext(admitted, scope));
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
  type TerminalGateFact,
  type TerminalGateSeat,
  type TerminalNavigatorFact,
  type TerminalResult,
  type TerminalResume,
  type TerminalRoleName,
  type TerminalRoleOutcome,
} from "./terminal.ts";

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
};

/**
 * Facts the package itself established, each kept whole. None of them is ever
 * promoted into the host's cause, diagnostic or details.
 */
export type PackageSideFact = {
  /** An exception caught after the host already reported this call. */
  readonly thrown?: RoleTurnKnownFailure & { readonly diagnostic: string };
  /** The typed-HTTP sidecar could not be read; the host's report still stands. */
  readonly sidecarReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
  /** A durable stderr.log write that failed while handling this call. */
  readonly stderrLogWriteFailure?: unknown;
};

// A resumable public Terminal omits artifact paths (#108); its actual error
// publication remains available only to the CLI's resume presentation seam.
const privateFailureErrorPaths = new WeakMap<TerminalResult, string>();

export function publishedFailureErrorPath(terminal: TerminalResult): string | undefined {
  return privateFailureErrorPaths.get(terminal);
}

export function rewritePublishedFailureErrorPath(
  terminal: TerminalResult,
  oldRunDirectory: string,
  newRunDirectory: string,
): void {
  const errorPath = privateFailureErrorPaths.get(terminal);
  if (errorPath !== undefined) {
    privateFailureErrorPaths.set(
      terminal,
      rewriteRunDirectoryPathValue(errorPath, oldRunDirectory, newRunDirectory) as string,
    );
  }
}

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

/**
 * One concise stderr line for humans. Durable Error Artifact / Terminal keep the
 * full original diagnostic — presentation collapses newlines and flood frames.
 */
/** #836: full diagnostic on stderr — no first-line clip / flood filter. */
export function formatFailureStderrDiagnostic(failure: ControlledFailure): string {
  const text = failure.diagnostic.trim().length > 0 ? failure.diagnostic : "failure";
  return formatCliDiagnostic(text);
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

/** Session readiness after an admitted activation attempt. */
export type SessionReadiness =
  | { readonly state: "missing" }
  | { readonly state: "unreadable"; readonly diagnostic: string }
  | { readonly state: "present" };

export async function inspectJudgeSession(
  sessionFile: string,
): Promise<SessionReadiness> {
  try {
    await readFile(sessionFile, "utf8");
    return { state: "present" };
  } catch (error) {
    if (isMissingPathError(error)) return { state: "missing" };
    return {
      state: "unreadable",
      diagnostic:
        error instanceof Error
          ? error.message || error.name
          : String(error),
    };
  }
}

function thrownIdentity(error: Error): {
  name?: string;
  code?: string | number;
} {
  const identity: { name?: string; code?: string | number } = {
    name: error.name,
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    identity.code = code;
  }
  return identity;
}

/**
 * A caught read failure as a structured fact. The OS errno travels as `code`,
 * so a consumer asserts the identity instead of recognising the system error
 * by its message wording (质量法: 机器只咬契约，不咬呈现).
 */
function withErrorCode(error: Error): {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
} {
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" && code !== "" ? { code } : {}),
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

/** Flatten nested AggregateError leaves; non-aggregate values stay as one fact. */
function flattenThrownFailureLeaves(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) {
    return [error];
  }
  const leaves: unknown[] = [];
  for (const item of error.errors) {
    leaves.push(...flattenThrownFailureLeaves(item));
  }
  return leaves;
}

/**
 * Project one thrown value into a ControlledFailure leaf.
 * Sole owner for thrown-leaf identity/diagnostic mapping.
 * AggregateError nesting is handled by classifyThrownFailure.
 */
export function projectThrownFailureLeaf(error: unknown): ControlledFailure {
  if (isTypedActivationError(error)) {
    const identity = thrownIdentity(error);
    if (error.failureCode !== undefined && identity.code === undefined) {
      identity.code = error.failureCode;
    }
    return {
      cause: error.knownCause,
      diagnostic: error.message || error.name || "exception",
      identity,
      details: {
        ...(typeof error.details === "object" && error.details !== null
          ? error.details as Record<string, unknown>
          : error.details === undefined ? {} : { priorDetails: error.details }),
        error: serializeThrownValue(error),
      },
    };
  }
  if (error instanceof Error) {
    const identity = thrownIdentity(error);
    // No typed confirmation → keep original diagnostic/identity; do not mint a class (#881).
    return {
      diagnostic: error.message || error.name || "exception",
      identity,
      details: { error: serializeThrownValue(error) },
    };
  }
  return {
    diagnostic: error !== null && typeof error === "object" ? "non-Error throw" : String(error),
    details: { error: serializeThrownValue(error) },
  };
}

/**
 * Concurrent thrown failures (host + cleanup, etc.):
 * primary leaf owns cause/diagnostic/identity; remaining leaves stay as
 * details.concurrentFailures so neither fact covers the other.
 */
function classifyThrownFailure(error: unknown): ControlledFailure {
  if (!(error instanceof AggregateError)) {
    return projectThrownFailureLeaf(error);
  }
  const leaves = flattenThrownFailureLeaves(error);
  if (leaves.length === 0) {
    // Empty aggregate — retain the aggregate shell rather than invent a cause.
    return projectThrownFailureLeaf(error);
  }
  const primary = projectThrownFailureLeaf(leaves[0]);
  if (leaves.length === 1) {
    return primary;
  }
  const priorConcurrent = Array.isArray(primary.details?.concurrentFailures)
    ? primary.details.concurrentFailures
    : [];
  const concurrentFailures = [
    ...priorConcurrent,
    ...leaves.slice(1).map((leaf) => {
      const secondary = projectThrownFailureLeaf(leaf);
      return {
        ...(secondary.cause === undefined ? {} : { cause: secondary.cause }),
        diagnostic: secondary.diagnostic,
        ...(secondary.identity === undefined ? {} : { identity: secondary.identity }),
        ...(secondary.details === undefined ? {} : { details: secondary.details }),
      };
    }),
  ];
  return {
    ...(primary.cause === undefined ? {} : { cause: primary.cause }),
    diagnostic: primary.diagnostic,
    ...(primary.identity === undefined ? {} : { identity: primary.identity }),
    details: {
      ...(primary.details ?? {}),
      concurrentFailures,
    },
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
  if (knownDetails === undefined) {
    return facts === undefined ? failure : { ...failure, packageFact: facts };
  }
  const { timedOut: _knownTimedOut, ...rest } = knownDetails;
  return {
    ...failure,
    ...(facts === undefined ? {} : { packageFact: facts }),
    details: {
      ...rest,
      ...(failure.details ?? {}),
    },
  };
}

/**
 * Classify a controlled post-admission failure without washing original identities.
 * Cause classes are closed; diagnostic text retains the original identity when known.
 *
 * Order: thrown → knownCause → timeout → activation (nonzero) → session → output.
 * knownCause precedes timeout so a co-present typed provider/session identity is not
 * washed when the child also timed out. Cause is never inferred from stderr wording.
 * AggregateError concurrent leaves keep primary identity and secondary facts in details.
 */
/** This call's package-side facts, or undefined when there are none. */
function packageFactsOf(input: {
  readonly sidecarReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
  readonly packageFact?: PackageSideFact;
}): PackageSideFact | undefined {
  const facts: PackageSideFact = {
    ...(input.packageFact ?? {}),
    ...(input.sidecarReadFailure === undefined
      ? {}
      : { sidecarReadFailure: input.sidecarReadFailure }),
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
  session?: SessionReadiness;
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
  /** This package's own auxiliary read failure; recorded, never a cause. */
  sidecarReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
  /** Further package-side facts merged under `packageFact`, never the cause. */
  packageFact?: PackageSideFact;
}): ControlledFailure {
  // Own-key presence, not value: `throw undefined` is a real caught exception.
  // An exception caught after the host already reported its own failure carries
  // both real facts: the host's report stays the cause, and the later exception
  // is kept beside it (失败诚实宪法：接住可以，洗白不行).
  if (Object.hasOwn(input, "thrown")) {
    const thrown = classifyThrownFailure(input.thrown);
    const hostReported = input.knownCause !== undefined
      || (input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== "")
      || input.knownIdentity !== undefined;
    if (!hostReported) return thrown;
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
        : conciseChildDiagnostic(input.stderr, thrown.diagnostic),
      ...(input.knownIdentity === undefined ? {} : { identity: input.knownIdentity }),
      // The host's details are handed back exactly as given.
      ...(input.knownDetails === undefined ? {} : { details: input.knownDetails }),
      packageFact: { ...input.packageFact, thrown },
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
    const { timedOut: _knownTimedOut, ...knownDetails } = input.knownDetails ?? {};
    const packageFact = packageFactsOf(input);
    return {
      ...(input.knownCause === undefined ? {} : { cause: input.knownCause }),
      diagnostic,
      details: { ...knownDetails, exitCode: input.code, ...(input.timedOut ? { timedOut: true as const } : {}) },
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
  if (input.code !== 0) {
    // A nonzero exit says the run failed, not why. No typed fact confirmed a
    // class, so `cause` stays absent and the CLI's own diagnostic and exit code
    // are what remains (host contract: omit cause, keep the original).
    const fallback = `role run failed with exit ${input.code ?? "null"}`;
    return withKnownDetails(
      {
        diagnostic: conciseChildDiagnostic(input.stderr, fallback),
        details: { exitCode: input.code },
      },
      input.knownDetails,
      packageFactsOf(input),
    );
  }
  if (input.session?.state === "missing") {
    return withKnownDetails(
      {
        cause: "session",
        diagnostic: "role run left no readable session transcript",
        details: { exitCode: input.code, session: "missing" },
      },
      input.knownDetails,
      packageFactsOf(input),
    );
  }
  if (input.session?.state === "unreadable") {
    return withKnownDetails(
      {
        cause: "session",
        diagnostic: input.session.diagnostic,
        details: { exitCode: input.code, session: "unreadable" },
      },
      input.knownDetails,
      packageFactsOf(input),
    );
  }
  return withKnownDetails(
    {
      cause: "output",
      diagnostic: "role run completed without a lawful typed terminal result",
      details: { exitCode: input.code },
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

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Face clear only: path not enterable as a face (ENOENT or file mid-path). */
function isAbsentFacePathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

/**
 * Preserve session-read failure identity as a typed session cause.
 * SyntaxError keeps its name so durable settlement does not wash malformed JSONL
 * into generic output absence.
 */
function sessionReadFailure(
  error: unknown,
  fallbackMessage: string,
): Error & {
  knownCause: ControlledFailureCause;
  failureCode?: string | number;
} {
  if (error instanceof SyntaxError) {
    const failed = new SyntaxError(
      error.message || fallbackMessage,
    ) as SyntaxError & {
      knownCause: ControlledFailureCause;
      failureCode?: string | number;
    };
    failed.knownCause = "session";
    return failed;
  }
  if (error instanceof Error) {
    const failed = new Error(
      error.message || error.name || fallbackMessage,
    ) as Error & {
      knownCause: ControlledFailureCause;
      failureCode?: string | number;
      code?: string | number;
    };
    failed.name = error.name || "Error";
    failed.knownCause = "session";
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      failed.failureCode = code;
      failed.code = code;
    }
    return failed;
  }
  const failed = new Error(String(error)) as Error & {
    knownCause: ControlledFailureCause;
    failureCode?: string | number;
  };
  failed.knownCause = "session";
  return failed;
}

/**
 * Read the exact bound Pi session file principal.
 * Does not scan the session directory for "latest" — resume identity is the file.
 */
export async function readBoundSessionEntries(
  sessionFile: string,
): Promise<SessionEntry[]> {
  const text = await readFile(sessionFile, "utf8");
  const entries: SessionEntry[] = [];
  for (const line of text.trim().split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch (error) {
      throw sessionReadFailure(error, "malformed session JSONL");
    }
  }
  return entries;
}

/**
 * One audited-runner resolution: this call's own reported failure plus the
 * typed-HTTP sidecar outcome from the same read. Callers that also decide v1
 * resume must consume this once — never re-read the sidecar in
 * presentControlledFailure.
 */
export type AuditedRunnerFailureResolution = {
  /** What the host CLI itself reported for this call, presented as it gave it. */
  readonly knownFailure?: RoleTurnKnownFailure;
  /** Successful sidecar read (not absence). */
  readonly typedHttpObservation?: TypedProviderHttpObservation;
  /**
   * True when the sidecar read already happened (success, absence, or a real
   * read failure). False when the call's own report short-circuited before it.
   */
  readonly typedHttpObservationSettled: boolean;
  /** The sidecar could not be read; auxiliary, and never a cause. */
  readonly sidecarReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
};

function resolutionOf(
  knownFailure: RoleTurnKnownFailure | undefined,
  typedHttp: {
    readonly settled: boolean;
    readonly observation?: TypedProviderHttpObservation;
    readonly sidecarReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
  } = { settled: false },
): AuditedRunnerFailureResolution {
  return {
    ...(knownFailure === undefined ? {} : { knownFailure }),
    ...(typedHttp.observation === undefined ? {} : { typedHttpObservation: typedHttp.observation }),
    ...(typedHttp.sidecarReadFailure === undefined
      ? {}
      : { sidecarReadFailure: typedHttp.sidecarReadFailure }),
    typedHttpObservationSettled: typedHttp.settled,
  };
}

/** Sole evidence-priority owner for public runners with Soul auditors. */
export async function resolveAuditedRunnerFailureResolution(input: {
  runner: RoleTurnKnownFailure | undefined;
  sessionFile: string;
  credential: RoleTurnKnownFailure | undefined;
  /** Optional run directory for typed provider HTTP observation (resume/429). */
  runDirectory?: string;
}): Promise<AuditedRunnerFailureResolution> {
  // This turn's outcome and its cause are what the host CLI reported for this
  // call, and nothing else. The Pi host returns only code/stderr/timedOut, so
  // anything richer came from the host's own declared failure; a session
  // transcript, a bound auditor volume, a Sitian-retained stop and the
  // run-level sidecar are history, and none of them is read to decide the cause
  // here (owner ea321c6d: resume报失败为什么要去看历史？).
  //
  // The typed-HTTP sidecar is a separate observation used only for the v1 resume
  // decision. A failure to read it is its own real fact and never replaces what
  // the host reported.
  let httpObservation: TypedProviderHttpObservation | undefined;
  if (input.runDirectory !== undefined) {
    try {
      httpObservation = await readLatestTypedProviderHttpObservation(input.runDirectory);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // The sidecar is auxiliary: failing to read it never becomes this call's
      // cause and never edits the host's report. It is recorded beside them.
      return resolutionOf(
        input.runner,
        {
          settled: true,
          sidecarReadFailure: withErrorCode(failure),
        },
      );
    }
  }
  const typedHttp = {
    settled: input.runDirectory !== undefined,
    ...(httpObservation === undefined ? {} : { observation: httpObservation }),
  };
  // A caller-declared credential failure is this invocation's own fact.
  if (input.credential !== undefined) return resolutionOf(input.credential, typedHttp);
  // The host's report for this call, or nothing: a run whose CLI reported no
  // failure is not given one by reading what earlier turns left behind.
  return resolutionOf(input.runner, typedHttp);
}
/**
 * v1 resume observation for controlled-failure settlement — at most one sidecar read.
 * Prefer the pre-resolved outcome from resolveAuditedRunnerFailureResolution.
 * Non-absence failures never throw: they return observationReadFailure, which
 * rides as a package-side fact on the controlled-failure → error.json chain.
 */
export async function resolveControlledFailureResumeObservation(input: {
  readonly runDirectory: string;
  readonly typedHttpObservationSettled?: boolean;
  readonly typedHttpObservation?: TypedProviderHttpObservation;
}): Promise<{
  readonly typedHttp429?: TypedHttp429Observation;
  /**
   * The sidecar could not be read on this path. This package's own fact: it is
   * never a cause, and it never stands in for what the host reported.
   */
  readonly observationReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
}> {
  if (input.typedHttpObservationSettled === true) {
    const observation = input.typedHttpObservation;
    if (
      observation !== undefined &&
      observation.httpStatus === 429 &&
      isV1ResumableProvider(observation.provider)
    ) {
      return {
        typedHttp429: { httpStatus: 429, provider: observation.provider },
      };
    }
    return {};
  }
  try {
    const typedHttp429 = await readTypedHttp429Observation(input.runDirectory);
    return typedHttp429 === undefined ? {} : { typedHttp429 };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return {
      observationReadFailure: withErrorCode(failure),
    };
  }
}

/** Spread into presentControlledFailure failureInput from one audited resolution. */
export function controlledFailureInputFromResolution(
  resolution: AuditedRunnerFailureResolution,
): {
  knownFailure?: RoleTurnKnownFailure;
  typedHttpObservationSettled?: true;
  typedHttpObservation?: TypedProviderHttpObservation;
  sidecarReadFailure?: { readonly name: string; readonly message: string; readonly code?: string };
} {
  return {
    ...(resolution.knownFailure === undefined ? {} : { knownFailure: resolution.knownFailure }),
    ...(resolution.sidecarReadFailure === undefined
      ? {}
      : { sidecarReadFailure: resolution.sidecarReadFailure }),
    ...(resolution.typedHttpObservationSettled
      ? {
        typedHttpObservationSettled: true as const,
        ...(resolution.typedHttpObservation === undefined
          ? {}
          : { typedHttpObservation: resolution.typedHttpObservation }),
      }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultText(message: SessionMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        !Array.isArray(part) &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
}

type BoundErroredToolCandidate = {
  candidate: unknown;
  diagnostic: string;
  callIndex: number;
};

function boundErroredToolCandidate(
  entries: readonly SessionEntry[],
  resultIndex: number,
  message: SessionMessage,
  toolName: string,
): BoundErroredToolCandidate | undefined {
  if (message.toolName !== toolName || message.isError !== true) return undefined;
  const bound = boundRoleToolCallForResult(entries, resultIndex, message, toolName);
  const diagnostic = toolResultText(message);
  return bound === undefined || diagnostic === ""
    ? undefined
    : { candidate: bound.candidate, diagnostic, callIndex: bound.callIndex };
}

type BoundRoleToolCall = {
  callIndex: number;
  candidate: unknown;
};

function boundRoleToolCallForResult(
  entries: readonly SessionEntry[],
  resultIndex: number,
  message: SessionMessage,
  outputToolName: string,
): BoundRoleToolCall | undefined {
  const callId = message.toolCallId;
  if (typeof callId !== "string" || callId.trim() === "") return undefined;

  const calls: BoundRoleToolCall[] = [];
  let resultCount = 0;
  let matchingResultIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const candidateMessage = entries[index]?.message;
    if (
      candidateMessage?.role === "assistant" &&
      Array.isArray(candidateMessage.content)
    ) {
      for (const part of candidateMessage.content) {
        if (!isRecord(part) || part.type !== "toolCall" || part.id !== callId) {
          continue;
        }
        if (part.name !== outputToolName) return undefined;
        calls.push({ callIndex: index, candidate: part.arguments });
      }
    }
    if (
      candidateMessage?.role === "toolResult" &&
      candidateMessage.toolCallId === callId
    ) {
      resultCount += 1;
      if (candidateMessage.toolName !== outputToolName) return undefined;
      matchingResultIndex = index;
    }
  }

  // A binding is an event-bound one-to-one relation, not a reverse lookup of
  // whichever result happens to be last in the session.
  return calls.length === 1 && resultCount === 1 && matchingResultIndex === resultIndex
    && calls[0]!.callIndex < resultIndex
    ? calls[0]
    : undefined;
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

/** Append the complete attempt to the package ledger before overwriting pointer artifacts (#419). */
export async function appendRunAttemptHistory(
  source: AttemptHistorySource,
  outcome: AttemptHistoryOutcome,
): Promise<void> {
  sitianReport({
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
  const advisoryDiagnostic = typeof details.routePlaybookReadFailure === "string"
    ? { advisoryDiagnostic: details.routePlaybookReadFailure }
    : {};
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
      return {
        disposition: "no-advice",
        ...advisoryDiagnostic,
      };
    }
    return adviceNavigatorFact({
      prose,
      ...advisoryDiagnostic,
    });
  }
  if (disposition === "unavailable") {
    return {
      disposition: "unavailable",
      ...advisoryDiagnostic,
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
    return {
      disposition: "no-advice",
      ...advisoryDiagnostic,
    };
  }
  return {
    disposition: "unavailable",
    source: "unknown",
    reason: "Navigator attendance disposition is unparseable",
  };
}

/**
 * Project direct and historical paired gate rounds onto the public Terminal.
 * actualSeats derive only from accepted receipts, never expected/missing seats.
 */
export function projectTerminalGateFact(
  rounds: readonly AnalystGateCycleRound[],
): TerminalGateFact | undefined {
  if (rounds.length === 0) return undefined;
  const seen = new Set<TerminalGateSeat>();
  for (const round of rounds) {
    if (round.origin.kind === "historical_dispatch") seen.add("gatekeeper");
    seen.add(round.officer);
  }
  const actualSeats = (["gatekeeper", "inspector", "notary"] as const).filter(
    (seat) => seen.has(seat),
  );
  return {
    actualSeats,
    rounds: rounds.map((round) => ({
      roundIndex: round.roundIndex,
      dispatch:
        round.origin.kind === "direct"
          ? { kind: "direct" as const, officer: round.officer }
          : {
              kind: "historical_dispatch" as const,
              officer: round.officer,
              ...(round.origin.reason === undefined
                ? {}
                : { reason: round.origin.reason }),
            },
      officer: {
        seat: round.officer,
        status: round.status,
        findings: round.findings,
      },
    })),
  };
}

/**
 * Read gate facts from the run's session/auditor-roles nest (#446/#478).
 * Missing directories → undefined (no-gate zero change).
 * Damaged discovered volumes propagate — never wash to "no gate".
 */
export async function extractGateFactFromSessionDirectory(
  sessionDirectory: string,
  options: {
    readonly runDirectory?: string;
    readonly parentSessionFile?: string;
  } = {},
): Promise<TerminalGateFact | undefined> {
  const directories = [join(sessionDirectory, "auditor-roles")];
  const parentSessionFile =
    options.parentSessionFile ?? join(sessionDirectory, "session.jsonl");
  const rounds = await readAnalystGateCyclesFromAuditorRoles(directories, {
    parentSessionFile,
  });
  return projectTerminalGateFact(rounds);
}

/**
 * Attach optional gate projection onto a settled Terminal base.
 * Shared by every settle path so auditor-roles is scanned once here only.
 * `runId` is not required — resumable failures omit it by contract.
 * Gate read damage propagates with its real identity (never washed to no-gate
 * or swallowed); callers that already hold a controlled failure still surface the
 * JSONL/session cause rather than pretend the gate was absent.
 */
/**
 * #537: project this-invocation ak_engine_detour usage onto decisiveFacts.
 * Absent when engine is not mounted; callCount 0 when mounted with zero calls.
 * Never mutates role payloads (ADR 0003 / 0042 / 0052).
 * Scope is the public-invocation id bound once per ak-role call — never
 * courtAttemptId and never Pi session.jsonl toolResult join. Session damage
 * therefore cannot replace an already-formed roleOutcome (no_receipt / failure).
 */
async function attachEngineDetourToolUsage<
  T extends { roleOutcome: TerminalRoleOutcome; resume?: TerminalResume },
>(
  base: T,
  sessionDirectory: string,
  gateContext: {
    readonly runDirectory?: string;
    readonly courtAttemptId?: string;
    readonly invocationScopeId?: string;
  } = {},
): Promise<T> {
  const runDirectory =
    typeof gateContext.runDirectory === "string" && gateContext.runDirectory.length > 0
      ? gateContext.runDirectory
      : runDirectoryFromSessionDirectory(sessionDirectory);
  const engineMounted = await readInvocationEngineMounted(runDirectory);
  if (!engineMounted) return base;

  // Public-invocation scope from the shared Host envelope (settlement scope), never
  // courtAttemptId and never a detour sidecar file.
  const invocationScopeId =
    typeof gateContext.invocationScopeId === "string" &&
    gateContext.invocationScopeId.length > 0
      ? gateContext.invocationScopeId
      : undefined;

  const sessionFile = sessionFileFromSessionDirectory(sessionDirectory);
  const usage = await readEngineDetourToolUsage({
    sessionParent: sessionFile,
    engineMounted: true,
    ...(invocationScopeId === undefined ? {} : { invocationScopeId }),
    cwd: runDirectory,
  });
  const projected =
    usage === undefined
      ? undefined
      : projectEngineDetourToolUsageForPublicTerminal(usage, {
          // Resumable Terminal: run ID only in resume.command — relative openable path.
          discloseRecordFile: base.resume === undefined,
        });
  return {
    ...base,
    roleOutcome: withEngineDetourToolUsageFact(base.roleOutcome, projected),
  };
}

/** Gate + detour projection context from admitted run + settlement scope. */
function detourGateContext(
  admitted: { readonly runDirectory: string },
  scope?: SettlementCourtScope,
): {
  readonly runDirectory: string;
  readonly courtAttemptId?: string;
  readonly invocationScopeId?: string;
} {
  return {
    runDirectory: admitted.runDirectory,
    ...(scope?.courtAttemptId === undefined || scope.courtAttemptId.length === 0
      ? {}
      : { courtAttemptId: scope.courtAttemptId }),
    ...(scope?.invocationScopeId === undefined || scope.invocationScopeId.length === 0
      ? {}
      : { invocationScopeId: scope.invocationScopeId }),
  };
}

async function withOptionalGateProjection<
  T extends {
    roleOutcome: TerminalRoleOutcome;
    navigator: TerminalNavigatorFact;
    artifacts: readonly TerminalArtifactRef[];
    resume?: TerminalResume;
  },
>(
  base: T,
  sessionDirectory: string,
  gateContext: {
    readonly runDirectory?: string;
    readonly parentSessionFile?: string;
    readonly courtAttemptId?: string;
    readonly invocationScopeId?: string;
  } = {},
): Promise<T & { gate?: TerminalGateFact }> {
  // A gate transport failure is already represented by typed evidence and has no
  // accepted gate cycle to project. Re-reading that rejected receipt as an
  // accepted cycle would replace the original failure with a projection error.
  const secondaryEvidence = base.roleOutcome.kind === "failure"
    ? base.roleOutcome.decisiveFacts.secondaryEvidence
    : undefined;
  const skipGate =
    isRecord(secondaryEvidence)
    && secondaryEvidence.kind === "role_infrastructure_failure"
    && packagedSkipsGateOnInfrastructureStage(secondaryEvidence.stage);

  let next: T & { gate?: TerminalGateFact } = base;
  if (!skipGate) {
    // Defaults live solely in extractGateFactFromSessionDirectory — do not re-derive.
    const gate = await extractGateFactFromSessionDirectory(sessionDirectory, gateContext);
    if (gate !== undefined) next = { ...base, gate };
  }

  return attachEngineDetourToolUsage(next, sessionDirectory, gateContext);
}

function routePlaybookFailureMessage(entries: readonly SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== NAVIGATOR_ROUTE_PLAYBOOK_FAILURE_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || typeof data.message !== "string" || data.message.trim() === "") return undefined;
    return data.message;
  }
  return undefined;
}

export function extractNavigatorFact(
  entries: readonly SessionEntry[],
): TerminalNavigatorFact {
  const fact = extractNavigatorAttendanceFact(entries);
  if (fact.advisoryDiagnostic !== undefined) return fact;
  const message = routePlaybookFailureMessage(entries);
  return message === undefined ? fact : { ...fact, advisoryDiagnostic: message };
}

function extractNavigatorAttendanceFact(
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
async function extractNavigatorFactFromAdmittedSession(
  sessionFile: string,
): Promise<TerminalNavigatorFact> {
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractNavigatorFact(entries);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        disposition: "unavailable",
        source: "unknown",
        reason: "Navigator attendance is missing from the session",
      };
    }
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is unavailable because the session could not be read",
    };
  }
}

/**
 * Remove one face path (file or directory collision plant).
 * Only missing target is silent — other errno stay loud (失败诚实).
 * recursive: publication may have occupied a face name as a directory (EISDIR plant).
 */
async function removeFaceIfPresent(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    // force:true already ignores ENOENT; ENOTDIR = face path not enterable
    // (artifacts-as-file mid-path) — same absent-face semantics as the reader.
    // Other errno stay loud (失败诚实).
    if (isAbsentFacePathError(error)) return;
    throw error;
  }
}

/**
 * #953: artifact face reflects the current terminal only.
 * Reader contract owns the full adoptable set (conventional trio + fixed
 * fallbacks + seam-owned unique). Clear every seam-owned face before the
 * new current publishes — including the conventional name about to be
 * rewritten. Retaining that name left directory collision plants in place
 * (supported publish input); writer then fell back while the reader stopped
 * at EISDIR on the stale conventional path and never adopted the fallback.
 * report / error / empty share one method (no per-branch face list).
 * empty publishes nothing; does not create a no_receipt-shaped public artifact.
 * Non-terminal materials stay. Face names may be directory collision plants —
 * remove recursively. Unique ownership is listSeamOwnedUniqueErrorFacePaths:
 * parent runs/ faces clear only when body.runId binds; unparseable runId → none.
 * Path absence (ENOENT/ENOTDIR) is silent; other delete failures stay loud.
 */
async function clearOppositeTerminalArtifactFace(
  runDirectory: string,
): Promise<void> {
  const artifactsDir = roleRunArtifactsDirectory(runDirectory);
  for (const file of RUN_TERMINAL_ARTIFACT_FILES) {
    await removeFaceIfPresent(join(artifactsDir, file));
  }
  // Fixed fallbacks + unique clear too; subsequent publish writes the new
  // durable path after this clear (conventional first when writable).
  for (const relative of RUN_TERMINAL_ERROR_FALLBACK_RELATIVE_PATHS) {
    await removeFaceIfPresent(join(runDirectory, relative));
  }
  for (const path of await listSeamOwnedUniqueErrorFacePaths(runDirectory)) {
    await removeFaceIfPresent(path);
  }
}

async function ensureTerminalArtifactFace(
  runDirectory: string,
): Promise<string> {
  const artifactsDir = await ensureRunArtifactsDir(runDirectory);
  await clearOppositeTerminalArtifactFace(runDirectory);
  return artifactsDir;
}

type AcceptedArtifactAttachment = {
  readonly provenancePath: string;
  readonly frozenPath: string;
  readonly sha256: string;
  readonly byteLength: number;
};

function acceptedArtifactAttachmentRefs(
  attachments: readonly AcceptedArtifactAttachment[],
): AcceptedArtifactAttachment[] {
  return attachments.map((a) => ({
    provenancePath: a.provenancePath,
    frozenPath: a.frozenPath,
    sha256: a.sha256,
    byteLength: a.byteLength,
  }));
}

/**
 * Sole success-terminal artifact publisher (#953): append attempt history,
 * refresh the public terminal face, write report/evidence, return refs.
 * Seat-specific structured fields stay in callers; do not fork this flow.
 */
async function publishAcceptedTerminalArtifacts(
  admitted: AdmittedRoleInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  recordAttemptHistory: boolean,
  bodies: {
    readonly report: Record<string, unknown>;
    readonly evidence: Record<string, unknown>;
  },
): Promise<TerminalArtifactRef[]> {
  // #419: a dispatched turn appends before rewriting last-write-wins views;
  // a later projection may refresh views but must not invent another attempt.
  if (recordAttemptHistory) {
    await appendRunAttemptHistory(
      { role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile },
      roleOutcome,
    );
  }
  const artifactsDir = await ensureTerminalArtifactFace(admitted.runDirectory);
  const reportPath = join(artifactsDir, RUN_TERMINAL_REPORT_FILE);
  const evidencePath = join(artifactsDir, RUN_TERMINAL_EVIDENCE_FILE);
  await writeFile(
    reportPath,
    `${JSON.stringify(bodies.report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(bodies.evidence, null, 2)}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/**
 * Read session entries for lawful settlement. Missing path → undefined (absence).
 * Malformed JSONL / other read failures throw with knownCause=session.
 */
async function readLawfulSettlementEntries(
  sessionFile: string,
): Promise<SessionEntry[] | undefined> {
  try {
    return await readBoundSessionEntries(sessionFile);
  } catch (error) {
    // Missing path is absence of a lawful outcome; callers classify via session inspect.
    if (isMissingPathError(error)) return undefined;
    // Malformed JSONL and other read failures keep typed session identity.
    throw error instanceof Error &&
      (error as { knownCause?: unknown }).knownCause === "session"
      ? error
      : sessionReadFailure(error, "session unreadable");
  }
}

async function settleResidualOutputFailure(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
  residual: BoundErroredToolCandidate,
): Promise<TerminalResult> {
  const candidate = residual.candidate;
  return settleFailureTerminalResult(admitted, {
    cause: "output",
    diagnostic: residual.diagnostic,
    details: isRecord(candidate) ? candidate : { candidate },
  }, authority, scope ?? {});
}

/** Sealed and residual seats share one lawful terminal; only residual seats scan failed tools. */
async function settleSealedSeat(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
  options: {
    acceptedOnly: boolean;
    residual?: { tool: string; scan: "current-attempt" | "session" };
  },
): Promise<TerminalResult | undefined> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  // Residual seats read first so malformed session data retains its failure identity
  // even when the ledger has no accepted row. Plain sealed seats read only on success.
  const priorEntries = options.residual === undefined
    ? undefined
    : await readLawfulSettlementEntries(coordinates.sessionFile) ?? [];
  const roleOutcome = await sealedLedgerOutcome(admitted, admitted.role, scope);
  if (options.residual !== undefined && roleOutcome?.kind !== "accepted") {
    const entries = priorEntries!;
    const scanStart = options.residual.scan === "current-attempt" ? currentAttemptStartIndex(entries) : 0;
    for (let index = entries.length - 1; index >= scanStart; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(entries, index, message, options.residual.tool);
      if (residual === undefined) continue;
      const failed = await settleResidualOutputFailure(admitted, authority, scope, residual);
      return attachRecordedSubmissions(admitted, failed, scope);
    }
    return undefined;
  }
  if (roleOutcome === undefined || (options.acceptedOnly && roleOutcome.kind !== "accepted")) {
    // A transcript that cannot be read is a real fact about this run, whatever
    // the ledger holds. It is reported as this run's own session failure; it is
    // never used to attribute a cause the host did not report.
    if (options.residual === undefined) await readLawfulSettlementEntries(coordinates.sessionFile);
    return undefined;
  }
  const entries = priorEntries ?? await readLawfulSettlementEntries(coordinates.sessionFile) ?? [];
  return finishLawfulSeat(admitted, coordinates, entries, roleOutcome, scope);
}

async function finishLawfulSeat(
  admitted: AdmittedRoleInvocation,
  coordinates: DurablePrincipalCoordinates,
  entries: readonly SessionEntry[],
  roleOutcome: TerminalRoleOutcome,
  scope: SettlementCourtScope | undefined,
): Promise<TerminalResult> {
  const artifacts = scope?.previewOnly === true
    ? []
    : await publishDeclaredSeatArtifacts(admitted, roleOutcome, coordinates, entries, scope?.recordAttemptHistory === true);
  const terminal = await withOptionalGateProjection({
    roleOutcome,
    navigator: extractNavigatorFact(entries),
    artifacts,
    runId: admitted.runId,
  }, coordinates.sessionDirectory, detourGateContext(admitted, scope));
  return attachRecordedSubmissions(admitted, terminal, scope);
}

/**
 * One settlement for every registered seat. The registry `settlement` leaf
 * picks sealed ledger, sealed-or-residual, or the accepted-tool scan.
 * Seat evidence stays on the artifact face.
 */
async function settleSeat(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
): Promise<TerminalResult | undefined> {
  const record = packagedRoleMetadata(admitted.role);
  if (record === undefined) {
    throw new Error(`no settlement for ${admitted.role}`);
  }
  if (record.settlement === "accepted") {
    return trySettleAcceptedSeatTerminalResult(admitted, authority, scope);
  }
  return settleSealedSeat(admitted, authority, scope, {
    acceptedOnly: "sealedAcceptedOnly" in record && record.sealedAcceptedOnly === true,
    ...(record.settlement === "residual"
      ? { residual: { tool: record.residualTool, scan: record.residualScan } }
      : {}),
  });
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

const EMPTY_ARTIFACT_FACE: PackagedArtifactFace = { leaves: [] };

/** Artifact face for one seat. Absent means report/evidence carry only shared leaves. */
function seatArtifactFace(role: string): PackagedArtifactFace {
  const record = packagedRoleMetadata(role);
  if (record !== undefined && "artifactFace" in record && record.artifactFace !== undefined) {
    return record.artifactFace;
  }
  return EMPTY_ARTIFACT_FACE;
}

function readAdmittedPath(source: object, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evidenceLeaves(
  admitted: AdmittedRoleInvocation,
  leaves: readonly PackagedArtifactLeaf[],
): Record<string, unknown> {
  const evidence: Record<string, unknown> = {};
  for (const leaf of leaves) {
    if (leaf.callerProvenance === true) {
      if (!admitted.instructionEmpty) evidence[leaf.key] = admitted.instruction;
      continue;
    }
    const value = readAdmittedPath(admitted, leaf.from ?? leaf.key);
    if (value === undefined && leaf.omitUndefined === true) continue;
    evidence[leaf.key] = leaf.copyArray === true && Array.isArray(value) ? [...value] : value;
  }
  return evidence;
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

async function publishDeclaredSeatArtifacts(
  admitted: AdmittedRoleInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  entries: readonly SessionEntry[],
  recordAttemptHistory: boolean,
): Promise<TerminalArtifactRef[]> {
  const face = seatArtifactFace(admitted.role);
  const phase = face.reportPhase === true
    ? { phase: readAdmittedPath(admitted, "phase") }
    : {};
  return publishAcceptedTerminalArtifacts(admitted, roleOutcome, coordinates, recordAttemptHistory, {
    report: {
      role: admitted.role,
      runId: admitted.runId,
      ...phase,
      outcome: roleOutcome,
      ...doctorReportFacts(face, roleOutcome, entries),
    },
    evidence: {
      runId: admitted.runId,
      ...(face.evidenceRole === true ? { role: admitted.role } : {}),
      ...evidenceLeaves(admitted, face.leaves),
      sessionDirectory: coordinates.sessionDirectory,
      sessionFile: coordinates.sessionFile,
      admittedRequestPath: admitted.admittedRequestPath,
      attachments: acceptedArtifactAttachmentRefs(admitted.attachments),
    },
  });
}

/**
 * Shared accepted-settlement skeleton for seats that scan residual tool
 * candidates then project sealed ledger outcome (#502 DRY).
 * #757: sealed receipts pass through full decisiveFacts — one path, no per-seat projector.
 */
type SeatAcceptedSettlementSpec = {
  readonly role: TerminalRoleName;
  readonly toolName: string;
};

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

async function settleLawfulSeatAcceptedTerminalResult(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  spec: SeatAcceptedSettlementSpec,
  scope?: SettlementCourtScope,
): Promise<TerminalResult | undefined> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const entries = await readLawfulSettlementEntries(coordinates.sessionFile) ?? [];
  // #843: collector shape (ledger closed first) plus current user-turn freshness.
  // Only the ledger-owned closure establishes this turn's success. A non-error
  // toolResult may be a candidate whose nested gate continued the conversation.
  // A current-attempt
  // residual without that success is this turn's own failure and must not be
  // masked by run-scoped stale acceptance (bare resume without courtAttemptId).
  // Same-turn accept-then-bounce keeps the success marker: terminal stays
  // accepted; rejection facts remain on payloads/gate (not latest-wins flip).
  const scanStart = currentAttemptStartIndex(entries);
  let thisAttemptHasSeatSuccess = false;
  let residual: BoundErroredToolCandidate | undefined;
  for (let index = entries.length - 1; index >= scanStart; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === "ak-role-submission-closure"
      && isRecord(entry.data) && entry.data.toolName === spec.toolName
      && classifyPackagedRoleTerminalResult(entry.data).kind === "accepted") {
      thisAttemptHasSeatSuccess = true;
    }
    const message = entries[index]?.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== spec.toolName) continue;
    if (message.isError === false) continue;
    if (residual === undefined) {
      residual = boundErroredToolCandidate(
        entries,
        index,
        message,
        spec.toolName,
      );
    }
  }
  const roleOutcome = await sealedLedgerOutcome(admitted, spec.role as TerminalRoleName, scope);
  if (roleOutcome !== undefined && (
    thisAttemptHasSeatSuccess || residual === undefined || (scope?.courtAttemptId !== undefined && scope.courtAttemptId.length > 0)
  )) {
    return finishLawfulSeat(admitted, coordinates, entries, roleOutcome, scope);
  }
  if (residual !== undefined) {
    const failed = await settleResidualOutputFailure(admitted, authority, scope, residual);
    return attachRecordedSubmissions(admitted, failed, scope);
  }
  return undefined;
}

/** Accepted-tool seats: one scan, tool name from the composition-root record. */
async function trySettleAcceptedSeatTerminalResult(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope?: SettlementCourtScope,
): Promise<TerminalResult | undefined> {
  const toolName = packagedRoleAcceptedOutputTool(admitted.role);
  if (toolName === undefined) {
    throw new Error(`accepted-seat settlement is not declared for ${admitted.role}`);
  }
  const settled = await settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: admitted.role,
    toolName,
  }, scope);
  const record = packagedRoleMetadata(admitted.role);
  if (
    settled === undefined
    || record === undefined
    || !("projectCountersignTerminal" in record)
    || record.projectCountersignTerminal !== true
  ) {
    return settled;
  }
  return applySecretariatCountersignTerminal(admitted, authority, settled);
}

/** One settlement dispatch. The registry `settlement` leaf selects the path. */
export async function trySettlePublicSeat(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  scope: SettlementCourtScope | undefined,
): Promise<TerminalResult | undefined> {
  return settleSeat(admitted, authority, scope);
}

/**
 * #969 seat projection sole authority: 给事中 terminal (署|上呈) booked as a
 * durable custom entry (envelope-safe) — ledger accepted stays LLM params (#836).
 * Never scan toolResult rows: those are memory-only on headless/ACP (#617/#959).
 * Receipt bytes stay original; nested runId rides beside them.
 * Caller must only apply this when the terminal-defining submission actually
 * produced the officer entry (gate-bound converged, or 给事中 audit_escalation).
 */
function countersignTerminalFromEntries(
  entries: readonly {
    type?: string;
    customType?: string;
    data?: unknown;
  }[],
): import("../secretariat-contracts.ts").SecretariatCountersignTerminalFact | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom") continue;
    if (entry.customType !== SECRETARIAT_GATE_OFFICER_ENTRY_TYPE) continue;
    const data =
      entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : undefined;
    if (data === undefined || !packagedDurableOfficerEntry(data.officer)) continue;
    if (data.receipt === undefined) continue;
    const runId =
      typeof data.runId === "string" && data.runId.trim() !== ""
        ? data.runId
        : undefined;
    return {
      receipt: data.receipt,
      ...(runId === undefined ? {} : { runId }),
    };
  }
  return undefined;
}

function withCountersignTerminalFact(
  roleOutcome: Extract<
    import("./terminal.ts").TerminalRoleOutcome,
    { kind: "accepted" | "audit_escalation" }
  >,
  officer: import("../secretariat-contracts.ts").SecretariatCountersignTerminalFact,
): typeof roleOutcome {
  const prior =
    roleOutcome.decisiveFacts !== undefined && isRecord(roleOutcome.decisiveFacts)
      ? roleOutcome.decisiveFacts
      : {};
  return {
    ...roleOutcome,
    decisiveFacts: {
      ...prior,
      [SECRETARIAT_COUNTERSIGN_TERMINAL_FACT_KEY]: officer,
    },
  };
}

/**
 * Terminal-defining secretariat submission owns officer projection.
 * Last readable secretariatStatus on accepted payloads decides: only gate-bound
 * converged projects a prior durable officer entry. Parent escalate bypasses the
 * gate and must not inherit a stale pass entry from an earlier turn (#969).
 */
function acceptedSecretariatDefinesOfficerProjection(
  roleOutcome: Extract<
    import("./terminal.ts").TerminalRoleOutcome,
    { kind: "accepted" }
  >,
): boolean {
  const payloads = roleOutcome.payloads ?? [];
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (!isRecord(payload)) continue;
    const status = payload.secretariatStatus;
    if (typeof status !== "string") continue;
    return status === "converged";
  }
  return false;
}

async function applySecretariatCountersignTerminal(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  settled: TerminalResult,
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const entries = await readLawfulSettlementEntries(coordinates.sessionFile) ?? [];
  const officer = countersignTerminalFromEntries(entries);
  if (officer === undefined) return settled;

  // 给事中上呈: public payloads = officer receipt; runId + receipt fact beside.
  // This kind is produced only when beforeAccept booked the officer entry.
  if (settled.roleOutcome.kind === "audit_escalation") {
    return {
      ...settled,
      roleOutcome: withCountersignTerminalFact(
        {
          ...settled.roleOutcome,
          payloads: [officer.receipt],
        },
        officer,
      ),
    };
  }

  // Pass (署): keep 中书省 payloads; present 给事中 判词 + runId via decisiveFacts.
  // Parent escalate accepted terminal must not project a stale prior pass entry.
  if (settled.roleOutcome.kind === "accepted") {
    if (!acceptedSecretariatDefinesOfficerProjection(settled.roleOutcome)) {
      return settled;
    }
    return {
      ...settled,
      roleOutcome: withCountersignTerminalFact(settled.roleOutcome, officer),
    };
  }

  return settled;
}

/**
 * After the audit gate returns, attach gate rounds and the secretariat officer
 * fact onto the terminal this turn already settled. Does not publish again —
 * a second publish would append another attempt-history row for the same attempt.
 */
export async function attachPostAuditProjection(
  admitted: AdmittedRoleInvocation,
  authority: DurablePrincipalAuthority,
  terminal: TerminalResult,
): Promise<TerminalResult> {
  const { sessionDirectory, sessionFile } = coordinatesFromAdmitted(authority, admitted);
  const gate = await extractGateFactFromSessionDirectory(sessionDirectory, {
    runDirectory: admitted.runDirectory,
    parentSessionFile: sessionFile,
  });
  const withGate = gate === undefined ? terminal : { ...terminal, gate };
  if (admitted.role !== "secretariat") return withGate;
  return applySecretariatCountersignTerminal(admitted, authority, withGate);
}

/** One failed attempt to place a durable failure artifact (path is private layout). */
type PublicationAttempt = {
  readonly path: string;
  readonly diagnostic: string;
  readonly identity?: {
    readonly name?: string;
    readonly code?: string | number;
  };
};

function publicationAttemptFromError(
  path: string,
  error: unknown,
): PublicationAttempt {
  if (error instanceof Error) {
    return {
      path,
      diagnostic: error.message || error.name || "write failed",
      identity: thrownIdentity(error),
    };
  }
  return { path, diagnostic: String(error) };
}

/**
 * Directories eligible for open-ended unique failure-artifact placement.
 * Always includes the ledger runs/ parent of the run directory so an
 * unwritable run tree cannot strand the original controlled failure.
 */
function uniqueFailureFallbackDirs(
  runDirectory: string,
  baseDir: string,
): string[] {
  const dirs: string[] = [];
  for (const dir of [baseDir, runDirectory, dirname(runDirectory)]) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Resolve a writable artifacts base directory. If `artifacts/` cannot be created
 * (e.g. a file occupies that name), fall back to the run directory itself.
 */
async function resolveFailureArtifactsBase(
  runDirectory: string,
): Promise<{ baseDir: string; attempt?: PublicationAttempt }> {
  const artifactsDir = roleRunArtifactsDirectory(runDirectory);
  try {
    await ensureRunArtifactsDir(runDirectory);
    return { baseDir: artifactsDir };
  } catch (error) {
    return {
      baseDir: runDirectory,
      attempt: publicationAttemptFromError(artifactsDir, error),
    };
  }
}

/**
 * Write JSON across preferred paths, then unique open-ended fallbacks.
 * Finite fixed names must not be able to exhaust durability and strand the
 * original controlled failure outside settlement.
 */
async function writeFailureJsonRetainingCause(
  preferredCandidates: readonly string[],
  uniqueFallbackDirs: readonly string[],
  stem: string,
  basePayload: Readonly<Record<string, unknown>>,
  priorIssues: readonly PublicationAttempt[],
): Promise<{ path: string; issues: PublicationAttempt[] }> {
  const issues: PublicationAttempt[] = [...priorIssues];
  const candidates: string[] = [
    ...preferredCandidates,
    // One unique name per fallback dir — collisions on fixed names cannot exhaust this.
    ...uniqueFallbackDirs.map((dir) => join(dir, stem === UNIQUE_ERROR_FALLBACK_STEM ? uniqueErrorFallbackName() : `${stem}.${randomUUID()}.json`)),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const path = candidates[i]!;
    const payload =
      issues.length === 0
        ? basePayload
        : { ...basePayload, publicationIssues: issues };
    try {
      await writeFile(
        path,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      return { path, issues };
    } catch (error) {
      issues.push(publicationAttemptFromError(path, error));
    }
  }
  const last = issues.at(-1);
  const error = new Error(
    last?.diagnostic ?? "unable to write durable failure artifact",
  ) as Error & {
    code?: string | number;
    publicationAttempts?: PublicationAttempt[];
  };
  if (last?.identity?.name !== undefined && last.identity.name !== "") {
    error.name = last.identity.name;
  }
  if (last?.identity?.code !== undefined) {
    error.code = last.identity.code;
  }
  error.publicationAttempts = issues;
  throw error;
}

export async function publishFailureArtifacts(
  admitted: AdmittedRoleInvocation,
  failure: ControlledFailure,
  authority: DurablePrincipalAuthority,
  onErrorPublished?: (path: string) => void,
  recordAttemptHistory = false,
): Promise<TerminalArtifactRef[]> {
  const { sessionDirectory, sessionFile } = coordinatesFromAdmitted(authority, admitted);
  const { baseDir, attempt: baseAttempt } = await resolveFailureArtifactsBase(
    admitted.runDirectory,
  );
  const priorIssues: PublicationAttempt[] =
    baseAttempt === undefined ? [] : [baseAttempt];
  // #419: a dispatched failure joins history before fixed-name views change.
  // Re-projecting an existing failure does not append. History write failure
  // rides publicationIssues rather than stranding the controlled failure.
  if (recordAttemptHistory) {
    try {
      await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile }, {
        kind: "failure", role: admitted.role, ...failure,
      });
    } catch (error) {
      priorIssues.push(publicationAttemptFromError(sessionFile, error));
    }
  }
  // #953: clear the prior success face, but a failure here must not strand
  // the original controlled cause; preserve the issue beside the fallback.
  try {
    await clearOppositeTerminalArtifactFace(admitted.runDirectory);
  } catch (error) {
    priorIssues.push(publicationAttemptFromError(
      roleRunArtifactsDirectory(admitted.runDirectory), error,
    ));
  }

  // Prefer conventional names; unique fallback dirs keep colliding fixed paths
  // from stranding the original failure outside settlement. Include the ledger
  // runs/ parent so a locked run directory (EACCES) cannot exhaust durability.
  const underArtifacts = baseDir === roleRunArtifactsDirectory(admitted.runDirectory);
  const uniqueFallbackDirs = uniqueFailureFallbackDirs(
    admitted.runDirectory,
    baseDir,
  );
  const errorCandidates = underArtifacts
    ? [
        join(baseDir, RUN_TERMINAL_ERROR_FILE),
        join(baseDir, RUN_TERMINAL_ERROR_SETTLEMENT_FILE),
        join(admitted.runDirectory, RUN_TERMINAL_ERROR_SETTLEMENT_FILE),
      ]
    : [
        join(baseDir, RUN_TERMINAL_ERROR_SETTLEMENT_FILE),
        join(baseDir, RUN_TERMINAL_ERROR_FILE),
      ];
  const evidenceCandidates = underArtifacts
    ? [
        join(baseDir, RUN_TERMINAL_EVIDENCE_FILE),
        join(baseDir, "evidence.settlement.json"),
        join(admitted.runDirectory, "evidence.settlement.json"),
      ]
    : [
        join(baseDir, "evidence.settlement.json"),
        join(baseDir, RUN_TERMINAL_EVIDENCE_FILE),
      ];

  const errorPayloadBase: Record<string, unknown> = {
    kind: "error",
    role: admitted.role,
    runId: admitted.runId,
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    diagnostic: failure.diagnostic,
    ...(failure.identity === undefined ? {} : { identity: failure.identity }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
    // This package's own facts, kept beside the host's report.
    ...(failure.packageFact === undefined ? {} : { packageFact: failure.packageFact }),
  };

  const errorWrite = await writeFailureJsonRetainingCause(
    errorCandidates,
    uniqueFallbackDirs,
    UNIQUE_ERROR_FALLBACK_STEM,
    errorPayloadBase,
    priorIssues,
  );
  onErrorPublished?.(errorWrite.path);

  const evidencePayload: Record<string, unknown> = {
    runId: admitted.runId,
    sessionDirectory: sessionDirectory,
    sessionFile: sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    attachments: acceptedArtifactAttachmentRefs(admitted.attachments),
    ...(failure.cause === undefined ? {} : { failureCause: failure.cause }),
  };
  const evidenceWrite = await writeFailureJsonRetainingCause(
    evidenceCandidates,
    uniqueFallbackDirs,
    "evidence",
    evidencePayload,
    // Evidence records the same publication collisions observed placing the error body.
    errorWrite.issues,
  );

  return [
    { kind: "error", path: errorWrite.path },
    { kind: "evidence", path: evidenceWrite.path },
  ];
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
    readonly resume?: TerminalResume;
    readonly onErrorPublished?: (path: string) => void;
  } = {},
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  // Exact-session attendance only — never infer no-advice from caller omission.
  const navigator = await extractNavigatorFactFromAdmittedSession(sessionFile);
  // Private durable artifacts retain the original diagnostic identity (including run ID).
  const artifacts = options.previewOnly === true
    ? []
    : await publishFailureArtifacts(admitted, failure, authority, options.onErrorPublished, options.recordAttemptHistory === true);
  const errorPath = artifacts.find((artifact) => artifact.kind === "error")?.path;
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
  const roleOutcome: TerminalRoleOutcome = {
    kind: "failure",
    role: admitted.role,
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    diagnostic: failure.diagnostic,
    decisiveFacts,
  };
  // Resumable failures disclose the run ID only through resume.command (#108).
  const terminal = await withOptionalGateProjection(
    options.resume === undefined
      ? { roleOutcome, navigator, artifacts, runId: admitted.runId }
      : { roleOutcome, navigator, artifacts: [], resume: options.resume },
    sessionDirectory,
    detourGateContext(admitted, options),
  );
  if (options.resume !== undefined && errorPath !== undefined) privateFailureErrorPaths.set(terminal, errorPath);
  return terminal;
}

/**
 * Emit one complete failure Terminal on stdout and one concise stderr diagnostic.
 * Artifacts are already durable on the TerminalResult.
 */
export function presentFailureTerminal(
  terminal: TerminalResult,
  io: { stdout: (text: string) => void; stderr: (text: string) => void; omitFailureStderrDiagnostic?: boolean },
): void {
  if (terminal.roleOutcome.kind !== "failure" && terminal.roleOutcome.kind !== "no_receipt") {
    throw new TypeError("presentFailureTerminal requires a failure or no-receipt role outcome");
  }
  io.stdout(formatTerminalResult(terminal));
  if (terminal.roleOutcome.kind === "failure") {
    if (io.omitFailureStderrDiagnostic) return;
    io.stderr(formatFailureStderrDiagnostic({
      ...(terminal.roleOutcome.cause === undefined ? {} : { cause: terminal.roleOutcome.cause }),
      diagnostic: terminal.roleOutcome.diagnostic,
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
