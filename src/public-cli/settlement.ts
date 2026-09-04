/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #107 / #101).
 * Controlled failures and audit human decisions settle here without washing causes.
 */
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  readAnalystGateCyclesFromAuditorRoles,
  type AnalystGateCycleRound,
} from "../analyst-gate-cycles-read.ts";
import { readSitianRecords, resolveSitianRecordPath, sitianReport } from "../sitian-facade.ts";
import {
  latestUserAttemptId,
  readAuditEscalationSubmission,
  readLatestSubmissionOutcome,
  readSealedSubmission,
} from "../submission-ledger.ts";

import { isAuditEscalationResult } from "../audit-escalation.ts";
import { AUDITOR_SOUL_ROLES } from "../auditor-soul.ts";
import { DOCTOR_AUDIT_TOOL_NAME } from "../doctor-auditor.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../judge-auditor.ts";
import type { RoleTurnKnownFailure } from "../host-contracts.ts";
import { knownFailureFromProviderStop } from "../pi/known-failure.ts";
import { readReviewerDispatchRejection } from "./reviewer-dispatch-rejection.ts";
import {
  RESUME_TRANSPORT_ENVELOPE,
  isV1ResumableProvider,
  readLatestTypedProviderHttpObservation,
  readTypedHttp429Observation,
  type TypedHttp429Observation,
  type TypedProviderHttpObservation,
} from "./run-lifecycle.ts";
import {
  AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE,
  AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE,
  COMPLIANCE_RESPONSE_ENTRY_TYPE,
  readComplianceCandidate,
  type ComplianceDecision,
} from "../compliance-transport.ts";
// COMPLIANCE_RESPONSE_ENTRY_TYPE remains for boundRetainedAuditResponse (call/result
// interval binding on historical session bytes). Provider-stop retain authority is Sitian.
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "../collector-ledger.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../engine-detour.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  type JudgeVerdict,
} from "../package-contracts/judge-output.ts";
import {
  COLLECTOR_OUTPUT_TOOL,
  validateAcceptedCollectorReceipt,
  type CollectorReceipt,
} from "../package-contracts/collector-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  validateAcceptedCoderDetails,
  validateFixerOutput,
  type CoderOutput,
  type FixerOutput,
} from "../package-contracts/worker-output.ts";
import { validateAcceptedDetails } from "../package-contracts/terminating-tools.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
  validateRecordedDoctorOutput,
  type DoctorOutput,
} from "../doctor-contracts.ts";
import {
  REVIEWER_OUTPUT_TOOL_NAME,
  validateRuntimeReviewerReceipt,
  type RuntimeReviewerReceiptV2,
} from "../package-contracts/reviewer-output.ts";
import {
  MERGER_OUTPUT_TOOL_NAME,
  validateMergerOutput,
  type MergerOutput,
} from "../merger-contracts.ts";
import {
  NOTARY_OUTPUT_TOOL_NAME,
  notaryDecisiveFacts,
  validateRecordedNotaryOutput,
  type NotaryOutput,
} from "../notary-contracts.ts";
import {
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  validateRecordedCountersignOutput,
} from "../countersign-contracts.ts";
import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  gleanerLeftDecisiveFacts,
  validateRecordedGleanerLeftOutput,
} from "../gleaner-left-contracts.ts";
import {
  INSPECTOR_OUTPUT_TOOL_NAME,
  inspectorDecisiveFacts,
  validateRecordedInspectorOutput,
} from "../inspector-contracts.ts";
import {
  GATEKEEPER_OUTPUT_TOOL_NAME,
  gatekeeperDecisiveFacts,
  validateRecordedGatekeeperOutput,
} from "../package-contracts/gatekeeper-output.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  navigatorDecisiveFacts,
  validateRecordedNavigatorOutput,
} from "../package-contracts/navigator-output.ts";
import {
  observePackagedMethodSkillInvocation,
  type ObservedPackagedMethodSkillInvocation,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import {
  classifyPackagedRoleTerminalResult,
  findLatestDurablePackagedRoleTerminal,
  hasNavigatorInfrastructureFailureBase,
  isAcceptedPackagedRoleTerminalResult,
  isReceiptSettlementBindingClear,
  NAVIGATOR_INVOCATION_ENTRY,
  parseInvocationMarkerIdentity,
  type InvocationMarkerIdentity,
} from "../navigator-invocation-identity.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";
import { NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, parseNoReceiptLifecycleFacts, type NoReceiptLifecycleFacts } from "../receipt-delivery-policy.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
} from "../host-contracts.ts";
import {
  ensureRunArtifactsDir,
  homeFromRunDirectory,
  type AdmittedCoderInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedDoctorInvocation,
  type AdmittedFixerInvocation,
  type AdmittedJudgeInvocation,
  type AdmittedMergerInvocation,
  type AdmittedCountersignInvocation,
  type AdmittedGleanerLeftInvocation,
  type AdmittedInspectorInvocation,
  type AdmittedGatekeeperInvocation,
  type AdmittedNavigatorInvocation,
  type AdmittedNotaryInvocation,
  type AdmittedReviewerInvocation,
  type AdmittedRoleInvocation,
} from "./invocation.ts";

/** Ledger reads use the run's machine home — not ambient process HOME (child write vs parent settle). */
function sealedLedgerHome(admitted: AdmittedRoleInvocation): string {
  return homeFromRunDirectory(admitted.runDirectory);
}

async function sealedLedgerOutcome(admitted: AdmittedRoleInvocation): Promise<Extract<TerminalRoleOutcome, { kind: "accepted" }> | undefined> {
  return readSealedSubmission(admitted.projectRoot, admitted.runId, sealedLedgerHome(admitted));
}

/**
 * Shared sealed-accepted detection for all resumable adapters (#648).
 * Ledger projection is the sole authority — not optional per-role adapter wiring.
 */
export async function hasSealedAcceptedProjection(
  admitted: AdmittedRoleInvocation,
): Promise<boolean> {
  // Ledger authority must not wash read failure into "unsealed" (#648).
  // Callers treat throw as fail-closed: preserve true cause, never redispatch.
  return (await sealedLedgerOutcome(admitted)) !== undefined;
}

async function auditEscalationLedgerOutcome(
  admitted: AdmittedRoleInvocation,
  role: TerminalRoleName,
  authority: DurablePrincipalAuthority,
): Promise<Extract<TerminalRoleOutcome, { kind: "audit_escalation" }> | undefined> {
  let currentAttemptId: string | undefined;
  if (role === "coder" || role === "fixer") {
    const entries = await readBoundSessionEntries(coordinatesFromAdmitted(authority, admitted).sessionFile);
    currentAttemptId = latestUserAttemptId(entries);
  }
  const projection = await readAuditEscalationSubmission(
    admitted.projectRoot,
    admitted.runId,
    sealedLedgerHome(admitted),
    currentAttemptId,
  );
  if (projection?.role !== role) return undefined;
  return projection;
}

async function closedLedgerOutcome(
  admitted: AdmittedRoleInvocation,
  role: TerminalRoleName,
  authority: DurablePrincipalAuthority,
): Promise<Extract<TerminalRoleOutcome, { kind: "accepted" | "audit_escalation" }> | undefined> {
  const sealed = await sealedLedgerOutcome(admitted);
  return sealed?.role === role
    ? sealed
    : auditEscalationLedgerOutcome(admitted, role, authority);
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
  recommendationNavigatorFact,
  buildResidualIncompleteTerminalOutcome,
  redactExactRunId,
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

/** Preserved post-admission failure cause (not a role Receipt). */
export type ControlledFailure = {
  readonly cause: ControlledFailureCause;
  readonly diagnostic: string;
  readonly identity?: {
    readonly name?: string;
    readonly code?: string | number;
  };
  readonly details?: Readonly<Record<string, unknown>>;
};

/** Presentation bound for one stderr diagnostic line (durable artifact keeps full text). */
export const CONCISE_DIAGNOSTIC_MAX_CHARS = 480;

/**
 * True when a stderr line is observation/event/token/stack flood rather than a diagnostic.
 * Recognizes both `event:` prefixes and real JSONL records with an `event` key
 * (tool_execution_* observation face).
 */
export function isChildDiagnosticFloodLine(line: string): boolean {
  if (/^at\s+/.test(line)) return true;
  if (line.startsWith("event:")) return true;
  if (/\btokens?=/.test(line)) return true;
  if (/\btool_calls?=/.test(line)) return true;
  if (line.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as { event?: unknown }).event === "string"
      ) {
        return true;
      }
    } catch {
      // Not JSON — may still be a real diagnostic.
    }
  }
  return false;
}

/**
 * True when a stderr line is Pi auth/model help scaffolding rather than the failure identity.
 * Real counterexample: multi-line "No API key…" guidance ends with docs/*.md path lines;
 * those footers must not displace the primary diagnostic.
 */
export function isChildDiagnosticHelpFooterLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  // Path-only doc references (indented or bare).
  if (/^\S+\.(md|txt)$/i.test(trimmed)) return true;
  // Auth guidance continuations from Pi formatNoApiKeyFoundMessage / getProviderLoginHelp.
  if (/^Use \//i.test(trimmed)) return true;
  if (/^Then use \//i.test(trimmed)) return true;
  if (/^See:\s*$/i.test(trimmed)) return true;
  return false;
}

/** Bound one diagnostic for human stderr presentation; durable evidence stays full. */
export function boundConciseDiagnostic(
  diagnostic: string,
  maxChars: number = CONCISE_DIAGNOSTIC_MAX_CHARS,
): string {
  if (diagnostic.length <= maxChars) return diagnostic;
  if (maxChars <= 1) return "…";
  return `${diagnostic.slice(0, maxChars - 1)}…`;
}

/**
 * Pick one concise diagnostic line from child stderr without stacks/events/tokens/help footers.
 * Prefers the last nonblank line that is not a frame, observation flood, or docs-path footer.
 * Returns the full selected diagnostic (bound only at presentation).
 */
export function conciseChildDiagnostic(
  stderr: string,
  fallback: string,
): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (isChildDiagnosticFloodLine(line)) continue;
    if (isChildDiagnosticHelpFooterLine(line)) continue;
    // Strip a leading "Error:" label but keep the message identity.
    return line.replace(/^Error:\s*/i, "").trim() || fallback;
  }
  return fallback;
}

export function formatCliDiagnostic(message: string): string {
  return `ak-role: ${message}\n`;
}

/**
 * One concise stderr line for humans. Durable Error Artifact / Terminal keep the
 * full original diagnostic — presentation collapses newlines and flood frames.
 */
export function formatFailureStderrDiagnostic(failure: ControlledFailure): string {
  const selected = conciseChildDiagnostic(failure.diagnostic, "failure");
  // conciseChildDiagnostic already returns one split line; defend fallback paths.
  const oneLine =
    selected
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "failure";
  return formatCliDiagnostic(boundConciseDiagnostic(oneLine));
}

/** Pre-admission structural rejection: stderr only, no run, no Terminal. */
export function presentStructuralRejection(
  error: { message: string },
  io: { stderr: (text: string) => void },
): void {
  io.stderr(formatCliDiagnostic(error.message));
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
  return (
    cause === "provider" ||
    cause === "activation" ||
    cause === "session" ||
    cause === "output" ||
    cause === "timeout" ||
    cause === "unrecognized"
  );
}

/**
 * Classify a controlled post-admission failure without washing unrecognized identities.
 * Cause classes are closed; diagnostic text retains the original identity when known.
 *
 * Order: thrown → knownCause → timeout → activation (nonzero) → session → output.
 * knownCause precedes timeout so a co-present typed provider/session identity is not
 * washed when the child also timed out. Cause is never inferred from stderr wording.
 */
export function classifyPostAdmissionFailure(input: {
  timedOut: boolean;
  code: number | null;
  stderr: string;
  /**
   * Caught post-admission exception. Presence (own key) is distinct from value:
   * JavaScript permits `throw undefined`, which must stay unrecognized rather than
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
}): ControlledFailure {
  // Own-key presence, not value: `throw undefined` is a real caught exception.
  if (Object.hasOwn(input, "thrown")) {
    const error = input.thrown;
    if (isTypedActivationError(error)) {
      const identity = thrownIdentity(error);
      if (error.failureCode !== undefined && identity.code === undefined) {
        identity.code = error.failureCode;
      }
      return {
        cause: error.knownCause,
        diagnostic: error.message || error.name || "unrecognized exception",
        identity,
      };
    }
    if (error instanceof Error) {
      const identity = thrownIdentity(error);
      return {
        cause: "unrecognized",
        diagnostic: error.message || error.name || "unrecognized exception",
        identity,
      };
    }
    return {
      cause: "unrecognized",
      diagnostic: String(error),
    };
  }
  if (input.knownCause !== undefined) {
    const fallback =
      input.knownCause === "provider"
        ? "provider failure"
        : input.knownCause === "session"
          ? "session unreadable"
          : input.knownCause === "output"
            ? "role run completed without a lawful typed terminal result"
            : `role run failed (${input.knownCause})`;
    const diagnostic =
      input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== ""
        ? input.knownDiagnostic
        : conciseChildDiagnostic(input.stderr, fallback);
    const { timedOut: _knownTimedOut, ...knownDetails } =
      input.knownDetails ?? {};
    const remoteCode = knownDetails.code;
    return {
      cause: input.knownCause,
      diagnostic,
      details: {
        ...knownDetails,
        ...(remoteCode === undefined ? {} : { code: remoteCode }),
        exitCode: input.code,
        ...(input.timedOut ? { timedOut: true as const } : {}),
      },
      ...(input.knownIdentity === undefined
        ? {}
        : { identity: input.knownIdentity }),
    };
  }
  if (input.timedOut) {
    return {
      cause: "timeout",
      diagnostic: "role run timed out",
      details: { timedOut: true, exitCode: input.code },
    };
  }
  if (input.code !== 0) {
    const fallback = `role run failed with exit ${input.code ?? "null"}`;
    return {
      cause: "activation",
      diagnostic: conciseChildDiagnostic(input.stderr, fallback),
      details: { exitCode: input.code },
    };
  }
  if (input.session?.state === "missing") {
    return {
      cause: "session",
      diagnostic: "role run left no readable session transcript",
      details: { exitCode: input.code, session: "missing" },
    };
  }
  if (input.session?.state === "unreadable") {
    return {
      cause: "session",
      diagnostic: input.session.diagnostic,
      details: { exitCode: input.code, session: "unreadable" },
    };
  }
  return {
    cause: "output",
    diagnostic: "role run completed without a lawful typed terminal result",
    details: { exitCode: input.code },
  };
}

/** One projection owner for the four audited public runners. */
export function explicitInternalKnownFailureClassificationInput(
  failure: RoleTurnKnownFailure | undefined,
) {
  if (failure === undefined) return {};
  return {
    knownCause: failure.cause,
    ...(failure.identity === undefined ? {} : { knownIdentity: failure.identity }),
    ...(failure.diagnostic === undefined ? {} : { knownDiagnostic: failure.diagnostic }),
    ...(failure.details === undefined ? {} : { knownDetails: failure.details }),
  };
}

/** Post-role Navigator delivery grace (Issue #11 / #101 / #106 / #159). */
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
async function readBoundSessionEntries(
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
 * Latest native assistant provider-stop in a session (stopReason error|aborted).
 * Only the final assistant turn decides terminality — an older error followed by a
 * later non-error stop is not a provider failure (would wash a no-lawful-output path).
 * Typed production source for provider cause — not child stderr prose.
 */
type SessionProviderStop = {
  stopReason: "error" | "aborted";
  errorMessage?: string;
  provider?: string;
  model?: string;
  api?: string;
  rawStopReason?: string;
  diagnostics?: unknown;
  httpStatus?: number;
  body?: unknown;
  code?: unknown;
  errno?: unknown;
};

function typedHttpStatusFromMessage(message: SessionMessage): number | undefined {
  for (const candidate of [message.httpStatus, message.statusCode, message.status]) {
    if (typeof candidate === "number" && (candidate < 200 || candidate >= 300)) return candidate;
  }
  return undefined;
}

function sessionProviderStopFromAssistant(message: SessionMessage | undefined): SessionProviderStop | undefined {
  if (message?.role !== "assistant") return undefined;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  const httpStatus = typedHttpStatusFromMessage(message);
  return {
    stopReason: message.stopReason,
    // Preserve held errorMessage bytes — emptiness check must not rewrite.
    ...(typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
      ? { errorMessage: message.errorMessage }
      : {}),
    ...(typeof message.provider === "string" && message.provider.trim() !== ""
      ? { provider: message.provider }
      : {}),
    ...(typeof message.model === "string" && message.model.trim() !== ""
      ? { model: message.model }
      : {}),
    ...(typeof message.api === "string" && message.api.trim() !== ""
      ? { api: message.api }
      : {}),
    ...(typeof message.rawStopReason === "string" && message.rawStopReason.trim() !== ""
      ? { rawStopReason: message.rawStopReason }
      : {}),
    ...(message.diagnostics === undefined ? {} : { diagnostics: message.diagnostics }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(message.body === undefined ? {} : { body: message.body }),
    ...(message.code === undefined ? {} : { code: message.code }),
    ...(message.errno === undefined ? {} : { errno: message.errno }),
  };
}

export function extractSessionProviderStop(
  entries: readonly SessionEntry[],
): SessionProviderStop | undefined {
  // A resumed dispatch appends a typed top-level user turn to the same session.
  // Older attempt native stops must not replace the newer attempt's stop.
  // Sessions without a user turn are the initial attempt.
  // Auditor retained responses live in Sitian (kind=auditor); see readSessionProviderStop.
  let attemptStart = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      attemptStart = i;
      break;
    }
  }

  for (let i = entries.length - 1; i >= attemptStart; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    // Latest assistant in the current attempt only (reviewer-child-executor lastAssistant pattern).
    return sessionProviderStopFromAssistant(message);
  }
  return undefined;
}

/**
 * Latest Sitian-retained auditor response stop for this parent session principal.
 * Writer: retainComplianceResponse → sitianReport(kind=auditor, payload={version,response}).
 * Payload stopReason is preserved as retained — aborted stays aborted; no 500/error wash here.
 */
async function readSitianRetainedAuditorProviderStop(
  sessionFile: string,
): Promise<SessionProviderStop | undefined> {
  try {
    const { recordFile } = resolveSitianRecordPath({
      level: "event",
      kind: "auditor",
      sessionParent: sessionFile,
      // Path is driven by sessionParent when under ledger home; cwd is a fallback only.
      cwd: dirname(sessionFile),
    });
    const { records } = await readSitianRecords(recordFile);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const payload = records[i]?.payload;
      if (!isRecord(payload) || !isRecord(payload.response)) continue;
      // Lifecycle events carry `type` (binding / compliance_failure); retain does not.
      if (typeof payload.type === "string") continue;
      const stop = sessionProviderStopFromAssistant(payload.response as SessionMessage);
      if (stop !== undefined) return stop;
      // Latest retain exists but is not a provider-stop — do not scan older retains
      // (mirrors former session COMPLIANCE_RESPONSE preference break).
      break;
    }
  } catch {
    // Missing volume or unreadable path is absence, not a settlement failure.
  }
  return undefined;
}

/** Read retained auditor stop (Sitian) then native session assistant stop, if any. */
export async function readSessionProviderStop(
  sessionFile: string,
): Promise<SessionProviderStop | undefined> {
  const retained = await readSitianRetainedAuditorProviderStop(sessionFile);
  if (retained !== undefined) return retained;
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractSessionProviderStop(entries);
  } catch {
    return undefined;
  }
}

/**
 * Recover a provider stop from Reviewer fixed-axis evidence children bound to this parent.
 * Dispatch runs during activation before the parent model turn; leg failures leave durable
 * stops under session/evidence-children/ and must not wash into generic activation.
 */
export async function readBoundEvidenceChildKnownFailure(
  sessionFile: string,
): Promise<RoleTurnKnownFailure | undefined> {
  const childDirectory = join(dirname(sessionFile), "evidence-children");
  let names: string[];
  try {
    names = await readdir(childDirectory);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw sessionReadFailure(error, "failed to read bound evidence-child session directory");
  }
  for (const file of names.filter((name) => name.endsWith(".jsonl")).sort().reverse()) {
    let entries: SessionEntry[];
    try {
      entries = await readBoundSessionEntries(join(childDirectory, file));
    } catch (error) {
      throw sessionReadFailure(error, "failed to read discovered evidence-child session");
    }
    const header = entries.find((entry) => entry.type === "session");
    if (!isRecord(header) || header.parentSession !== sessionFile) continue;
    const stop = extractSessionProviderStop(entries);
    if (stop === undefined) continue;
    const primary = knownFailureFromProviderStop(stop)!;
    return {
      ...primary,
      details: {
        ...(primary.details ?? {}),
        secondaryEvidence: "evidence-child",
      },
    };
  }
  return undefined;
}

type BoundAuditorVolume = {
  readonly entries: SessionEntry[];
  readonly attemptEntryId?: string;
  readonly parentId: string;
  readonly sessionFile: string;
};

async function loadBoundAuditorVolumes(
  sessionFile: string,
): Promise<readonly BoundAuditorVolume[] | undefined> {
  let parentEntries: SessionEntry[];
  try {
    parentEntries = await readBoundSessionEntries(sessionFile);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw sessionReadFailure(error, "failed to read parent session for auditor binding");
  }
  const parentId = parentEntries.find((entry) => entry.type === "session")?.id;
  if (parentId === undefined) return undefined;
  const RESUME_ENVELOPE = RESUME_TRANSPORT_ENVELOPE;
  // Keyed prefix on the transport token line only (#600 / 8e767152). Resume may
  // append engine handbook presentation after the token; settlement must not
  // treat those prose lines as a real user turn or key on their shape.
  const isResumeEnvelopeBytes = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const nl = value.indexOf("\n");
    const firstLine = nl === -1 ? value : value.slice(0, nl);
    return firstLine === RESUME_ENVELOPE;
  };
  const isResumeEnvelope = (msg: unknown): boolean => {
    if (!isRecord(msg) || msg.role !== "user") return false;
    const text = typeof msg.text === "string" ? msg.text : typeof (msg as { content?: unknown }).content === "string" ? (msg as { content: string }).content : undefined;
    if (isResumeEnvelopeBytes(text)) return true;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content.some((p) => isRecord(p) && (isResumeEnvelopeBytes(p.text) || isResumeEnvelopeBytes(p.content)));
    }
    return false;
  };
  let latestParentUserIndex = -1;
  for (let i = parentEntries.length - 1; i >= 0; i -= 1) {
    const entry = parentEntries[i];
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    if (isResumeEnvelope(entry.message)) continue;
    latestParentUserIndex = i;
    break;
  }
  const childDirectory = join(dirname(sessionFile), "auditor-roles");
  let names: string[];
  try {
    names = await readdir(childDirectory);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw sessionReadFailure(error, "failed to read bound auditor session directory");
  }
  // Auto-resume seam (owner A): stale check must ignore resume envelope and
  // prioritize retention. Previous `attemptEntryIndex < latest` discarded the
  // first attempt's child after resume advanced latest, losing retentionFailure
  // when retry had no compliance entry. Fix: ignore envelope for staleness and
  // prefer any valid compliance failure before falling back to primary.
  const valid: BoundAuditorVolume[] = [];
  for (const file of names.filter((name) => name.endsWith(".jsonl")).sort().reverse()) {
    let entries: SessionEntry[];
    try {
      entries = await readBoundSessionEntries(join(childDirectory, file));
    } catch (error) {
      throw sessionReadFailure(error, "failed to read discovered auditor session");
    }
    const header = entries.find((entry) => entry.type === "session");
    if (!isRecord(header) || header.parentSession !== sessionFile) continue;
    const bindingEntry = entries.find((entry) => entry.type === "custom" && entry.customType === AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE);
    const bindingParent = isRecord(bindingEntry?.data) && isRecord(bindingEntry.data.parent) ? bindingEntry.data.parent : undefined;
    const attemptEntryId = typeof bindingParent?.attemptEntryId === "string" ? bindingParent.attemptEntryId : undefined;
    const attemptEntryIndex = attemptEntryId === undefined ? -1 : parentEntries.findIndex((entry) => entry.id === attemptEntryId);
    if (bindingParent?.sessionId !== parentId || bindingParent.sessionFile !== sessionFile || attemptEntryIndex < latestParentUserIndex) continue;
    valid.push({
      entries,
      parentId,
      sessionFile,
      ...(attemptEntryId === undefined ? {} : { attemptEntryId }),
    });
  }
  return valid;
}

function complianceFailureFromAuditorVolumes(
  volumes: readonly BoundAuditorVolume[],
): RoleTurnKnownFailure | undefined {
  for (const { entries, attemptEntryId, parentId, sessionFile } of volumes) {
    const stop = extractSessionProviderStop(entries);
    if (stop === undefined) continue;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry.customType !== AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE || !isRecord(entry.data)) continue;
      const parent = isRecord(entry.data.parent) ? entry.data.parent : undefined;
      const failure = isRecord(entry.data.failure) ? entry.data.failure : undefined;
      if (parent?.sessionId !== parentId || parent.sessionFile !== sessionFile || parent.attemptEntryId !== attemptEntryId || (failure?.cause !== "provider" && failure?.cause !== "unrecognized")) continue;
      const identity = isRecord(failure.identity) ? failure.identity : undefined;
      return {
        cause: failure.cause === "provider" ? "provider" : "unrecognized",
        ...(identity === undefined ? {} : { identity: {
          ...(typeof identity.name === "string" ? { name: identity.name } : {}),
          ...(typeof identity.code === "string" || typeof identity.code === "number" ? { code: identity.code } : {}),
        } }),
        ...(typeof failure.diagnostic === "string" ? { diagnostic: failure.diagnostic } : {}),
        ...(isRecord(failure.details) ? { details: failure.details } : {}),
      };
    }
  }
  return undefined;
}

function providerStopFallbackFromAuditorVolumes(
  volumes: readonly BoundAuditorVolume[],
): RoleTurnKnownFailure | undefined {
  for (const { entries } of volumes) {
    const stop = extractSessionProviderStop(entries);
    if (stop === undefined) continue;
    const primary = knownFailureFromProviderStop(stop)!;
    return {
      ...primary,
      details: {
        ...(primary.details ?? {}),
        secondaryEvidence: "unavailable",
      },
    };
  }
  return undefined;
}

/** Recover a provider stop from the auditor child bound to the current parent attempt. */
export async function readBoundAuditorKnownFailure(
  sessionFile: string,
): Promise<RoleTurnKnownFailure | undefined> {
  const volumes = await loadBoundAuditorVolumes(sessionFile);
  if (volumes === undefined) return undefined;
  return complianceFailureFromAuditorVolumes(volumes)
    ?? providerStopFallbackFromAuditorVolumes(volumes);
}

/** Strong auditor tier only — retained compliance-failure entries, no provider-stop fallback. */
async function readBoundAuditorComplianceFailure(
  sessionFile: string,
): Promise<RoleTurnKnownFailure | undefined> {
  const volumes = await loadBoundAuditorVolumes(sessionFile);
  if (volumes === undefined) return undefined;
  return complianceFailureFromAuditorVolumes(volumes);
}

/** Weaker auditor tier: provider stop without a retained compliance-failure entry. */
async function readBoundAuditorProviderStopFallback(
  sessionFile: string,
): Promise<RoleTurnKnownFailure | undefined> {
  const volumes = await loadBoundAuditorVolumes(sessionFile);
  if (volumes === undefined) return undefined;
  return providerStopFallbackFromAuditorVolumes(volumes);
}

function typedFailedTerminatingToolKnownFailure(
  entries: readonly SessionEntry[],
): RoleTurnKnownFailure | undefined {
  let attemptStart = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === "message" && entries[i]?.message?.role === "user") {
      attemptStart = i;
      break;
    }
  }
  const attemptEntries = entries.slice(attemptStart);
  for (let i = attemptEntries.length - 1; i >= 0; i -= 1) {
    const message = attemptEntries[i]?.message;
    if (attemptEntries[i]?.type !== "message" || message?.role !== "toolResult") continue;
    const classification = classifyPackagedRoleTerminalResult(message);
    if (classification.kind !== "infrastructure") continue;
    if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;
    if (boundRoleToolCallForResult(attemptEntries, i, message, message.toolName) === undefined) continue;
    const textPart = Array.isArray(message.content)
      ? message.content.find((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
      : undefined;
    const diagnostic = isRecord(textPart) ? textPart.text : undefined;
    // Durable details already carry fact + typed evidence from envelope one-shot projection (#475).
    // Do not re-parse retained compliance responses here.
    const details = isRecord(message.details) ? message.details : classification.fact;
    return {
      cause: "output",
      identity: { name: message.toolName, code: message.toolCallId },
      ...(typeof diagnostic === "string" && diagnostic.trim() !== "" ? { diagnostic } : {}),
      details,
    };
  }
  return undefined;
}

/**
 * One audited-runner resolution: knownFailure plus the typed-HTTP sidecar outcome
 * from the same read. Callers that also decide v1 resume must consume this once —
 * never re-read the sidecar in presentControlledFailure.
 */
export type AuditedRunnerFailureResolution = {
  readonly knownFailure?: RoleTurnKnownFailure;
  /** Successful sidecar read (not absence). */
  readonly typedHttpObservation?: TypedProviderHttpObservation;
  /**
   * True when this resolution already performed the typed-HTTP sidecar read
   * (success, absence, or non-absence failure folded into knownFailure).
   * False when an earlier evidence tier short-circuited before the sidecar.
   */
  readonly typedHttpObservationSettled: boolean;
};

function resolutionOf(
  knownFailure: RoleTurnKnownFailure | undefined,
  typedHttp: {
    readonly settled: boolean;
    readonly observation?: TypedProviderHttpObservation;
  } = { settled: false },
): AuditedRunnerFailureResolution {
  return {
    ...(knownFailure === undefined ? {} : { knownFailure }),
    ...(typedHttp.observation === undefined ? {} : { typedHttpObservation: typedHttp.observation }),
    typedHttpObservationSettled: typedHttp.settled,
  };
}

/** Sole evidence-priority owner for public runners with Soul auditors. */
export async function resolveAuditedRunnerFailureResolution(input: {
  runner: RoleTurnKnownFailure | undefined;
  sessionFile: string;
  credential: RoleTurnKnownFailure | undefined;
  /** Reviewer only: recover child-written rejection page into knownFailure.details. */
  runDirectory?: string;
}): Promise<AuditedRunnerFailureResolution> {
  if (input.runner !== undefined) return resolutionOf(input.runner);
  if (input.runDirectory !== undefined) {
    try {
      const rejection = await readReviewerDispatchRejection(input.runDirectory);
      if (rejection !== undefined) return resolutionOf(rejection);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return resolutionOf({
        cause: "activation",
        identity: thrownIdentity(failure),
        diagnostic: failure.message || failure.name,
      });
    }
  }
  // Bound auditor compliance-failure retention outranks a parent failure that the
  // auditor path itself caused (retention EISDIR race). A typed terminating-tool
  // host failure is next — it outranks weaker auditor provider-stop fallback so
  // parent failInfrastructure abort pollution cannot wash a real diagnostic (#475).
  try {
    const auditorCompliance = await readBoundAuditorComplianceFailure(input.sessionFile);
    if (auditorCompliance !== undefined) return resolutionOf(auditorCompliance);
  } catch (error) {
    const failure = sessionReadFailure(error, "failed to recover bound auditor failure");
    return resolutionOf({
      cause: "session",
      identity: thrownIdentity(failure),
      diagnostic: failure.message || failure.name,
    });
  }
  try {
    const terminatingFailure = typedFailedTerminatingToolKnownFailure(
      await readBoundSessionEntries(input.sessionFile),
    );
    if (terminatingFailure !== undefined) return resolutionOf(terminatingFailure);
  } catch (error) {
    if (!isMissingPathError(error)) {
      const failure = sessionReadFailure(error, "failed to recover typed terminating-tool failure");
      return resolutionOf({
        cause: "session",
        identity: thrownIdentity(failure),
        diagnostic: failure.message || failure.name,
      });
    }
  }
  try {
    const auditorStop = await readBoundAuditorProviderStopFallback(input.sessionFile);
    if (auditorStop !== undefined) return resolutionOf(auditorStop);
  } catch (error) {
    const failure = sessionReadFailure(error, "failed to recover bound auditor provider stop");
    return resolutionOf({
      cause: "session",
      identity: thrownIdentity(failure),
      diagnostic: failure.message || failure.name,
    });
  }
  // Reviewer axis evidence-children are next: fixed two-axis dispatch fails
  // during activation with only child stops durable. Parent stop remains the
  // fallback; credential is last.
  try {
    const evidenceChildFailure = await readBoundEvidenceChildKnownFailure(input.sessionFile);
    if (evidenceChildFailure !== undefined) return resolutionOf(evidenceChildFailure);
  } catch (error) {
    const failure = sessionReadFailure(error, "failed to recover bound evidence-child failure");
    return resolutionOf({
      cause: "session",
      identity: thrownIdentity(failure),
      diagnostic: failure.message || failure.name,
    });
  }
  const parentStop = await readSessionProviderStop(input.sessionFile);
  // Typed HTTP observation: ENOENT=absence; other read/parse/shape failures keep real cause.
  // This is the single sidecar read for both knownFailure projection and v1 resume.
  let httpObservation: TypedProviderHttpObservation | undefined;
  if (input.runDirectory !== undefined) {
    try {
      httpObservation = await readLatestTypedProviderHttpObservation(input.runDirectory);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return resolutionOf(
        {
          cause: "session",
          identity: thrownIdentity(failure),
          diagnostic: failure.message || failure.name,
        },
        { settled: true },
      );
    }
  }
  const typedHttp = {
    settled: input.runDirectory !== undefined,
    ...(httpObservation === undefined ? {} : { observation: httpObservation }),
  };
  if (parentStop === undefined) {
    if (input.credential !== undefined) return resolutionOf(input.credential, typedHttp);
    if (httpObservation === undefined) return resolutionOf(undefined, typedHttp);
    // Project the HTTP observation's status + provider/source association.
    return resolutionOf(
      knownFailureFromProviderStop({
        stopReason: "error",
        httpStatus: httpObservation.httpStatus,
        provider: httpObservation.provider,
      }),
      typedHttp,
    );
  }
  return resolutionOf(
    knownFailureFromProviderStop({
      ...parentStop,
      ...(httpObservation === undefined
        ? {}
        : {
          httpStatus: httpObservation.httpStatus,
          // Observation association outranks session-configured provider name alone.
          provider: httpObservation.provider,
        }),
    }),
    typedHttp,
  );
}

/** Sole evidence-priority owner for public runners with Soul auditors. */
export async function resolveAuditedRunnerKnownFailure(input: {
  runner: RoleTurnKnownFailure | undefined;
  sessionFile: string;
  credential: RoleTurnKnownFailure | undefined;
  /** Reviewer only: recover child-written rejection page into knownFailure.details. */
  runDirectory?: string;
}): Promise<RoleTurnKnownFailure | undefined> {
  return (await resolveAuditedRunnerFailureResolution(input)).knownFailure;
}

/**
 * v1 resume observation for controlled-failure settlement — at most one sidecar read.
 * Prefer the pre-resolved outcome from resolveAuditedRunnerFailureResolution.
 * Non-absence failures never throw: they return observationReadFailure for the
 * existing controlled-failure → error.json chain.
 */
export async function resolveControlledFailureResumeObservation(input: {
  readonly runDirectory: string;
  readonly typedHttpObservationSettled?: boolean;
  readonly typedHttpObservation?: TypedProviderHttpObservation;
}): Promise<{
  readonly typedHttp429?: TypedHttp429Observation;
  readonly observationReadFailure?: RoleTurnKnownFailure;
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
      observationReadFailure: {
        cause: "session",
        identity: thrownIdentity(failure),
        diagnostic: failure.message || failure.name,
      },
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
} {
  return {
    ...(resolution.knownFailure === undefined ? {} : { knownFailure: resolution.knownFailure }),
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

function safelyRead(object: object, key: string): { readable: true; value: unknown } | { readable: false } {
  try {
    return { readable: true, value: (object as Record<string, unknown>)[key] };
  } catch {
    return { readable: false };
  }
}

function auditNoReceiptDecisiveFact(candidate: object): Record<string, unknown> {
  const projected = safelyRead(candidate, "auditNoReceipt");
  if (!projected.readable || projected.value === undefined) return {};
  try {
    return { auditNoReceipt: parseNoReceiptLifecycleFacts(projected.value) };
  } catch {
    return {};
  }
}

/** Countersign terminal projection — escalate keeps decisionGate; continue keeps fix (#572 / ADR 0074). */
function countersignDecisiveFacts(
  verdict: object,
  countersignStatus: string,
): Record<string, unknown> {
  const facts: Record<string, unknown> = { countersignStatus };
  if (countersignStatus === "continue") {
    const fix = safelyRead(verdict, "fix");
    if (fix.readable && isRecord(fix.value)) {
      const summary = safelyRead(fix.value, "summary");
      if (summary.readable && typeof summary.value === "string") {
        facts.fixSummary = summary.value;
      }
    }
  }
  if (countersignStatus === "escalate") {
    const gate = safelyRead(verdict, "decisionGate");
    if (gate.readable && isRecord(gate.value)) {
      const question = safelyRead(gate.value, "question");
      const options = safelyRead(gate.value, "options");
      if (question.readable && typeof question.value === "string") {
        facts.decisionQuestion = question.value;
      }
      if (options.readable && Array.isArray(options.value)) {
        facts.decisionOptions = [...options.value];
      }
    }
  }
  const note = safelyRead(verdict, "note");
  if (note.readable && note.value !== undefined) facts.note = note.value;
  const evidence = safelyRead(verdict, "evidence");
  if (evidence.readable && evidence.value !== undefined) facts.evidence = evidence.value;
  return facts;
}

function judgeDecisiveFacts(
  verdict: object,
  judgeStatus: string,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {
    judgeStatus,
    ...auditNoReceiptDecisiveFact(verdict),
  };
  const statusBase = judgeStatus;
  if (statusBase === "continue") {
    const fix = safelyRead(verdict, "fix");
    if (fix.readable && isRecord(fix.value)) {
      const summary = safelyRead(fix.value, "summary");
      if (summary.readable && typeof summary.value === "string") {
        facts.fixSummary = summary.value;
      }
    }
    const classes = safelyRead(verdict, "classes");
    if (classes.readable && Array.isArray(classes.value)) {
      try {
        facts.classes = classes.value.map((entry) => {
          if (!isRecord(entry)) throw new Error("unreadable Judge class");
          return {
            name: entry.name,
            owner: entry.owner,
            boundary: entry.boundary,
            disposition: entry.disposition,
          };
        });
        facts.classCount = classes.value.length;
      } catch {
        // Optional class material is omitted as a unit when any row is unreadable.
      }
    }
  }
  if (statusBase === "escalate") {
    const gate = safelyRead(verdict, "decisionGate");
    if (gate.readable && isRecord(gate.value)) {
      const question = safelyRead(gate.value, "question");
      const options = safelyRead(gate.value, "options");
      if (question.readable && typeof question.value === "string") {
        facts.decisionQuestion = question.value;
      }
      if (options.readable && Array.isArray(options.value)) {
        facts.decisionOptions = [...options.value];
      }
    }
  }
  const note = safelyRead(verdict, "note");
  if (note.readable && note.value !== undefined) facts.note = note.value;
  const evidence = safelyRead(verdict, "evidence");
  if (evidence.readable && evidence.value !== undefined) facts.evidence = evidence.value;
  return facts;
}

function coderDecisiveFacts(output: CoderOutput): Record<string, unknown> {
  const candidate = output as unknown as object;
  const status = safelyRead(candidate, "status");
  const facts: Record<string, unknown> = {};
  if (status.readable && typeof status.value === "string") facts.coderStatus = status.value;
  const statusBase =
    status.readable && typeof status.value === "string"
      ? (status.value)
      : undefined;
  const remainingScope = safelyRead(candidate, "remainingScope");
  if (statusBase === "unfinished" && remainingScope.readable && typeof remainingScope.value === "string") facts.remainingScope = remainingScope.value;
  const reason = safelyRead(candidate, "reason");
  if (statusBase === "unfinished" && reason.readable && typeof reason.value === "string" && reason.value.trim().length > 0) {
    facts.reason = reason.value;
  }
  const report = safelyRead(candidate, "report");
  if (report.readable && typeof report.value === "string") facts.reportPresent = report.value.trim().length > 0;
  return facts;
}

function fixerDecisiveFacts(output: FixerOutput): Record<string, unknown> {
  const candidate = output as unknown as object;
  const status = safelyRead(candidate, "status");
  const facts: Record<string, unknown> = {};
  if (status.readable && typeof status.value === "string") facts.fixerStatus = status.value;
  const statusBase =
    status.readable && typeof status.value === "string"
      ? (status.value)
      : undefined;
  const remainingScope = safelyRead(candidate, "remainingScope");
  if ((statusBase === "unfinished" || statusBase === "refused") && remainingScope.readable && typeof remainingScope.value === "string") facts.remainingScope = remainingScope.value;
  const reason = safelyRead(candidate, "reason");
  if (statusBase === "unfinished" && reason.readable && typeof reason.value === "string" && reason.value.trim().length > 0) {
    facts.reason = reason.value;
  }
  const blockerRead = safelyRead(candidate, "blocker");
  if (statusBase === "refused" && blockerRead.readable && isRecord(blockerRead.value)) {
    const cause = safelyRead(blockerRead.value, "cause");
    if (cause.readable && typeof cause.value === "string") facts.blockerCause = cause.value;
    const prerequisiteId = safelyRead(blockerRead.value, "prerequisiteId");
    if (cause.readable && cause.value === "prerequisite_unmet" && prerequisiteId.readable && typeof prerequisiteId.value === "string") facts.prerequisiteId = prerequisiteId.value;
  }
  const classResults = safelyRead(candidate, "classResults");
  if (classResults.readable && Array.isArray(classResults.value)) {
    const rows: Array<{ name: unknown; disposition: unknown }> = [];
    const blockers: Record<string, unknown>[] = [];
    try {
      for (const entry of classResults.value) {
        if (!isRecord(entry)) throw new Error("unreadable class result");
        const name = safelyRead(entry, "name");
        const disposition = safelyRead(entry, "disposition");
        if (!name.readable || !disposition.readable) throw new Error("unreadable class result");
        rows.push({ name: name.value, disposition: disposition.value });
        const blocker = safelyRead(entry, "blocker");
        if (disposition.value === "refused" && blocker.readable && isRecord(blocker.value)) blockers.push(blocker.value);
      }
      facts.classResultCount = rows.length;
      facts.classDispositions = rows;
      const causes = blockers.flatMap((blocker) => {
        const cause = safelyRead(blocker, "cause");
        return cause.readable && typeof cause.value === "string" ? [cause.value] : [];
      });
      if (causes.length > 0) facts.blockerCauses = causes;
      const prerequisiteIds = blockers.flatMap((blocker) => {
        const cause = safelyRead(blocker, "cause");
        const id = safelyRead(blocker, "prerequisiteId");
        return cause.readable && cause.value === "prerequisite_unmet" && id.readable && typeof id.value === "string" ? [id.value] : [];
      });
      if (prerequisiteIds.length > 0) facts.prerequisiteIds = prerequisiteIds;
    } catch {
      // Optional class projection is omitted as a unit when any row is unreadable.
    }
  }
  const report = safelyRead(candidate, "report");
  if (report.readable && typeof report.value === "string") facts.reportPresent = report.value.trim().length > 0;
  return facts;
}

function collectorDecisiveFacts(
  receipt: CollectorReceipt,
): Record<string, unknown> {
  const candidate = receipt as unknown as object;
  const facts: Record<string, unknown> = {};
  for (const key of ["repository", "prNumber", "targetHead", "manifestDigest"] as const) {
    const value = safelyRead(candidate, key);
    if (value.readable && value.value !== undefined) facts[key] = value.value;
  }
  const groups = safelyRead(candidate, "groups");
  if (groups.readable && Array.isArray(groups.value)) {
    try {
      facts.groups = groups.value.map((group) => {
        if (!isRecord(group)) throw new Error("unreadable Collector group");
        const identity = safelyRead(group, "identity");
        const attendance = safelyRead(group, "attendance");
        const materials = safelyRead(group, "materials");
        const findings = safelyRead(group, "findings");
        if (!identity.readable || !attendance.readable ||
          !materials.readable || !Array.isArray(materials.value) ||
          !findings.readable || !Array.isArray(findings.value)) {
          throw new Error("unreadable Collector group");
        }
        return {
          identity: identity.value,
          attendance: attendance.value,
          materialCount: materials.value.length,
          findingCount: findings.value.length,
        };
      });
    } catch { /* omit unreadable optional projection */ }
  }
  return facts;
}

function doctorDecisiveFacts(output: DoctorOutput): Record<string, unknown> {
  const candidate = output as unknown as object;
  const status = safelyRead(candidate, "status");
  const facts: Record<string, unknown> = { ...auditNoReceiptDecisiveFact(candidate) };
  if (status.readable && typeof status.value === "string") facts.doctorStatus = status.value;
  const statusBase =
    status.readable && typeof status.value === "string"
      ? (status.value)
      : undefined;
  if (statusBase === "refused") {
    const reason = safelyRead(candidate, "reason");
    if (reason.readable && reason.value !== undefined) facts.reason = reason.value;
    const missing = safelyRead(candidate, "missingEvidence");
    if (missing.readable && Array.isArray(missing.value)) facts.missingEvidenceCount = missing.value.length;
    return facts;
  }
  const caseValue = safelyRead(candidate, "case");
  if (caseValue.readable && isRecord(caseValue.value)) {
    const issueNumber = safelyRead(caseValue.value, "issueNumber");
    const runsPath = safelyRead(caseValue.value, "runsPath");
    if (issueNumber.readable && issueNumber.value !== undefined) facts.issueNumber = issueNumber.value;
    if (runsPath.readable && runsPath.value !== undefined) facts.runsPath = runsPath.value;
  }
  const findings = safelyRead(candidate, "findings");
  if (findings.readable && Array.isArray(findings.value)) facts.findingsCount = findings.value.length;
  return facts;
}

function reviewerAxes(value: unknown): readonly ("standards" | "spec")[] {
  if (!isRecord(value)) return [];
  return (["standards", "spec"] as const).filter((axis) => {
    const projected = safelyRead(value, axis);
    return projected.readable && projected.value !== undefined;
  });
}

function reviewerDecisiveFacts(
  output: RuntimeReviewerReceiptV2,
): Record<string, unknown> {
  const candidate = output as unknown as object;
  const status = safelyRead(candidate, "status");
  const outcomes = safelyRead(candidate, "outcomes");
  const reports = safelyRead(candidate, "reports");
  const amendments = safelyRead(candidate, "amendments");
  const axes = reviewerAxes(outcomes.readable ? outcomes.value : undefined);
  const reportAxes = reviewerAxes(reports.readable ? reports.value : undefined);
  // Typed presence only — never copy amendment prose into public facts.
  const amendmentAxes = reviewerAxes(amendments.readable ? amendments.value : undefined);
  const acceptedBatch = safelyRead(candidate, "acceptedBatch");
  const specDisposition = safelyRead(candidate, "specDisposition");
  const facts: Record<string, unknown> = {
    axes,
    reportAxes,
    amendmentAxes,
    acceptedBatchPresent: acceptedBatch.readable && acceptedBatch.value !== undefined,
    ...auditNoReceiptDecisiveFact(candidate),
  };
  if (status.readable && typeof status.value === "string") facts.reviewerStatus = status.value;
  if (
    specDisposition.readable &&
    (specDisposition.value === "launched" || specDisposition.value === "skipped-missing")
  ) {
    facts.specDisposition = specDisposition.value;
  }
  const diagnostic = safelyRead(candidate, "diagnostic");
  const statusBase =
    status.readable && typeof status.value === "string"
      ? (status.value)
      : undefined;
  if (statusBase === "refused" && diagnostic.readable) {
    facts.diagnosticPresent = typeof diagnostic.value === "string" && diagnostic.value.trim().length > 0;
  }
  return facts;
}

/**
 * ADR 0037: a shape-valid Collector receipt may still name the wrong live target.
 * Public success binds receipt identity to this admitted repository/PR/request manifest
 * at the existing settlement seam — not a second receipt factory or validator.
 */
function collectorReceiptBindingFailure(
  diagnostic: string,
): Error & { knownCause: ControlledFailureCause } {
  const error = new Error(diagnostic) as Error & {
    knownCause: ControlledFailureCause;
  };
  error.name = "CollectorReceiptBindingError";
  error.knownCause = "output";
  return error;
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

/** Collector operational tools that fail closed via host infrastructure abort. */
const COLLECTOR_INFRASTRUCTURE_TOOLS = new Set<string>([
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
]);

/** Shared match/cause/identity knobs for session-principal infrastructure failures. */
type InfrastructureFailureSpec = Readonly<{
  matchTool: (toolName: string) => boolean;
  cause: ControlledFailureCause;
  identityName: string;
  /**
   * Errored results only count as infrastructure when the durable details carry
   * the typed navigator fact. ak_collector_read also rejects known correctable
   * misuses (CollectorUnknownEvidenceError pointer bounces) as errored tool
   * results — those must not surface as CollectorInfrastructureError.
   */
  requireInfrastructureFact?: (toolName: string) => boolean;
}>;

const COLLECTOR_INFRASTRUCTURE_FAILURE_SPEC: InfrastructureFailureSpec = {
  matchTool: (toolName) => COLLECTOR_INFRASTRUCTURE_TOOLS.has(toolName),
  cause: "activation",
  identityName: "CollectorInfrastructureError",
  // read alone has a correctable rejection mode (unknown/non-openable pointers);
  // only its typed infrastructure-failure fact counts as a real host failure.
  requireInfrastructureFact: (toolName) => toolName === COLLECTOR_READ_TOOL,
};

const ENGINE_DETOUR_INFRASTRUCTURE_FAILURE_SPEC: InfrastructureFailureSpec = {
  matchTool: (toolName) => toolName === ENGINE_DETOUR_TOOL_NAME,
  cause: "output",
  identityName: "EngineDetourInfrastructureError",
};

/**
 * Prefer a real infrastructure tool failure already on the session principal
 * over a later secondary provider-stop (failure-honesty).
 * Tool match + cause + identity are call-site parameters — one extraction body.
 */
function extractInfrastructureToolFailure(
  entries: readonly SessionEntry[],
  spec: InfrastructureFailureSpec,
): ControlledFailure | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.isError !== true) continue;
    if (
      typeof message.toolName !== "string" ||
      !spec.matchTool(message.toolName)
    ) {
      continue;
    }
    if (spec.requireInfrastructureFact?.(message.toolName) === true) {
      if (!hasNavigatorInfrastructureFailureBase(message.details)) continue;
    }
    const diagnostic = toolResultText(message);
    if (diagnostic.length === 0) continue;
    return {
      cause: spec.cause,
      diagnostic,
      identity: { name: spec.identityName },
    };
  }
  return undefined;
}

/**
 * Read the bound session principal for a parameterized infrastructure tool failure.
 * `currentAttemptOnly` bounds the reverse scan to the latest top-level user turn
 * so a prior attempt's residual cannot mask the current failure (#633).
 */
async function readInfrastructureToolFailure(
  sessionFile: string,
  spec: InfrastructureFailureSpec,
  options: { readonly currentAttemptOnly?: boolean } = {},
): Promise<ControlledFailure | undefined> {
  try {
    let entries = await readBoundSessionEntries(sessionFile);
    if (options.currentAttemptOnly === true) {
      entries = entries.slice(currentAttemptStartIndex(entries));
    }
    return extractInfrastructureToolFailure(entries, spec);
  } catch {
    return undefined;
  }
}

/**
 * Prefer a real Collector infrastructure tool failure already on the session
 * principal over a later secondary provider-stop (failure-honesty).
 * Observe/request/wait host failures keep their diagnostic identity (e.g. HTTP 404).
 */
export function extractCollectorInfrastructureFailure(
  entries: readonly SessionEntry[],
): ControlledFailure | undefined {
  return extractInfrastructureToolFailure(
    entries,
    COLLECTOR_INFRASTRUCTURE_FAILURE_SPEC,
  );
}

/** Read the bound session principal for a Collector infrastructure tool failure. */
export async function readCollectorInfrastructureFailure(
  sessionFile: string,
): Promise<ControlledFailure | undefined> {
  return readInfrastructureToolFailure(
    sessionFile,
    COLLECTOR_INFRASTRUCTURE_FAILURE_SPEC,
    // Multi-attempt resume: only a current-attempt infrastructure failure
    // may preempt the current failure cause (#633).
    { currentAttemptOnly: true },
  );
}

/**
 * Prefer a real engine-detour infrastructure tool failure already on the session
 * principal over a later secondary provider-stop (failure-honesty / #357 T2).
 * Cause stays `output` — labor leg failed before accepted typed Receipt.
 */
export function extractEngineDetourInfrastructureFailure(
  entries: readonly SessionEntry[],
): ControlledFailure | undefined {
  return extractInfrastructureToolFailure(
    entries,
    ENGINE_DETOUR_INFRASTRUCTURE_FAILURE_SPEC,
  );
}

/** Read the bound session principal for an engine-detour infrastructure failure. */
export async function readEngineDetourInfrastructureFailure(
  sessionFile: string,
): Promise<ControlledFailure | undefined> {
  return readInfrastructureToolFailure(
    sessionFile,
    ENGINE_DETOUR_INFRASTRUCTURE_FAILURE_SPEC,
  );
}

/**
 * Compare a validated receipt with the admitted Collector invocation identity.
 * Throws a typed output failure when any identity field mismatches.
 */
export function assertCollectorReceiptMatchesAdmitted(
  receipt: CollectorReceipt,
  admitted: AdmittedCollectorInvocation,
): void {
  if (receipt.repository !== admitted.repository.canonical) {
    throw collectorReceiptBindingFailure(
      `Collector receipt repository "${receipt.repository}" does not match admitted repository "${admitted.repository.canonical}"`,
    );
  }
  if (receipt.prNumber !== admitted.prNumber) {
    throw collectorReceiptBindingFailure(
      `Collector receipt prNumber ${receipt.prNumber} does not match admitted prNumber ${admitted.prNumber}`,
    );
  }
  if (receipt.manifestDigest !== admitted.manifestDigest) {
    throw collectorReceiptBindingFailure(
      `Collector receipt manifestDigest does not match admitted manifestDigest`,
    );
  }
}

function auditToolNameForRole(
  role: (typeof AUDITOR_SOUL_ROLES)[number],
): string {
  switch (role) {
    case "judge":
      return JUDGE_AUDIT_TOOL_NAME;
    case "doctor":
      return DOCTOR_AUDIT_TOOL_NAME;
  }
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

type BoundRetainedAuditResponse = {
  candidate: unknown;
};

type BoundAuditEscalation = {
  decision: Extract<ComplianceDecision, { status: "escalate" }>;
  details: Record<string, unknown>;
};

function sameAuditValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) =>
      sameAuditValue(value, right[index]),
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && sameAuditValue(left[key], right[key]));
  }
  return false;
}

/** Snapshot the exact enumerable string face that final Terminal projection uses. */
function snapshotAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(details)) {
    Object.defineProperty(snapshot, key, {
      value: details[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return snapshot;
}

/**
 * Bind the public escalation face to the one retained response that sits inside
 * the same role output call/result interval. A `kind` field alone is never a
 * terminal identity; the retained response must be this seat's real escalate
 * decision and its projected audit-owned fields must agree with it.
 */
function boundAuditEscalationForResult(
  entries: readonly SessionEntry[],
  resultIndex: number,
  message: SessionMessage,
  role: (typeof AUDITOR_SOUL_ROLES)[number],
  outputToolName: string,
): BoundAuditEscalation | undefined {
  const roleCall = boundRoleToolCallForResult(
    entries,
    resultIndex,
    message,
    outputToolName,
  );
  if (roleCall === undefined) return undefined;
  const retained = boundRetainedAuditResponse(
    entries,
    roleCall.callIndex,
    resultIndex,
    auditToolNameForRole(role),
  );
  if (retained === undefined) return undefined;
  try {
    const decision = readComplianceCandidate(retained.candidate);
    if (decision.status !== "escalate") return undefined;
    const details = message.details;
    if (!isAuditEscalationResult(details) || !isRecord(details)) return undefined;

    // Read the public face exactly once. Besides making key enumeration and
    // getters fail closed, this prevents a stateful accessor from authenticating
    // one value and yielding another during final Terminal projection.
    const projectedDetails = snapshotAuditDetails(details);
    const hasDecisionConflicts = Object.hasOwn(decision, "conflicts");
    const hasDetailsConflicts = Object.hasOwn(projectedDetails, "conflicts");
    if (hasDecisionConflicts !== hasDetailsConflicts) return undefined;
    if (hasDecisionConflicts && !sameAuditValue(projectedDetails.conflicts, decision.conflicts)) return undefined;
    const hasDecisionGate = Object.hasOwn(decision, "decisionGate");
    const hasDetailsGate = Object.hasOwn(projectedDetails, "auditDecisionGate");
    if (hasDecisionGate !== hasDetailsGate) return undefined;
    if (hasDecisionGate && !sameAuditValue(projectedDetails.auditDecisionGate, decision.decisionGate)) return undefined;
    return { decision, details: projectedDetails };
  } catch {
    // Retained/public own-key enumeration, property reads, recursive equality,
    // and projection are all untrusted session evidence.
    return undefined;
  }
}

function isUnboundAuditEscalationFace(details: unknown): boolean {
  try {
    if (isAuditEscalationResult(details)) return true;
  } catch {
    // Hostile access is not authentic escalation evidence.
  }
  if (!isRecord(details)) return false;
  const kind = safelyRead(details, "kind");
  return kind.readable && kind.value === "audit_escalation";
}

function boundRetainedAuditResponse(
  entries: readonly SessionEntry[],
  callIndex: number,
  resultIndex: number,
  auditToolName: string,
): BoundRetainedAuditResponse | undefined {
  const matches: BoundRetainedAuditResponse[] = [];
  for (let index = callIndex + 1; index < resultIndex; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== COMPLIANCE_RESPONSE_ENTRY_TYPE) {
      continue;
    }
    if (!isRecord(entry.data) || !isRecord(entry.data.response)) continue;
    const response = entry.data.response;
    if (!Array.isArray(response.content)) continue;
    const calls = response.content.filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "toolCall",
    );
    if (calls.length !== 1 || calls[0]?.name !== auditToolName) continue;
    matches.push({ candidate: calls[0]?.arguments });
  }
  // Unique seat-bound match binds even when multi-turn investigation retained
  // intermediate non-decision responses in the same call/result interval.
  return matches.length === 1 ? matches[0] : undefined;
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

/**
 * Append one attempt's complete result to the run's session principal.
 * Append failure throws — callers must not overwrite a pointer artifact when
 * the history entry backing the overwrite did not land (fail closed).
 */
export async function appendRunAttemptHistory(
  source: AttemptHistorySource,
  outcome: AttemptHistoryOutcome,
): Promise<void> {
  const entries = await readBoundSessionEntries(source.sessionFile);
  let parentId: string | null = null;
  let priorEntries = 0;
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.type !== "session") parentId = entry.id;
    if (
      entry.type === "custom" &&
      entry.customType === ATTEMPT_HISTORY_ENTRY_TYPE
    ) {
      priorEntries += 1;
    }
  }
  const timestamp = new Date().toISOString();
  const attemptData = {
    sequence: priorEntries + 1,
    role: source.role,
    runId: source.runId,
    recordedAt: timestamp,
    outcome,
  };
  const line = `${JSON.stringify({
    type: "custom",
    customType: ATTEMPT_HISTORY_ENTRY_TYPE,
    data: attemptData,
    id: randomUUID(),
    parentId,
    timestamp,
  })}\n`;
  await appendFile(source.sessionFile, line, "utf8");
  try {
    sitianReport({
      level: "event",
      kind: "attempt-history",
      subject: { runId: source.runId },
      sessionParent: source.sessionFile,
      payload: {
        type: ATTEMPT_HISTORY_ENTRY_TYPE,
        ...attemptData,
      },
      source: "settlement",
    });
  } catch {}
}

/** Lawful Judge outcomes extracted from session (never a fabricated failure Receipt). */
export type LawfulJudgeRoleOutcome = Extract<
  TerminalRoleOutcome,
  { kind: "accepted" } | { kind: "audit_escalation" }
>;
function navigatorPhaseValue(value: unknown): NavigatorPhase {
  if (value === "plan" || value === "apply") return value;
  return null;
}

/**
 * Minimal attendance provenance against the bound marker (ADR 0043).
 * Keep only invocationId + post-terminal ordering. Runtime-self-produced
 * role/phase/subject/version are not re-reconciled here (ADR 0042).
 */
function navigatorAttendanceCorrelatedWithBoundMarker(
  details: Record<string, unknown>,
  attendanceIndex: number,
  terminalIndex: number,
  marker: InvocationMarkerIdentity,
): boolean {
  if (attendanceIndex <= terminalIndex) return false;
  // Exact current invocation token is the bound marker principal.
  if (details.invocationId !== marker.invocationId) return false;
  return true;
}

function parseNavigatorAttendanceDetails(
  details: Record<string, unknown>,
): TerminalNavigatorFact {
  const disposition = details.disposition;
  const advisoryDiagnostic = typeof details.routePlaybookReadFailure === "string"
    ? { advisoryDiagnostic: details.routePlaybookReadFailure }
    : {};
  if (disposition === "recommendation") {
    const next = details.next;
    if (!isRecord(next) || typeof next.role !== "string") {
      return {
        disposition: "unavailable",
        source: "unknown",
        reason: "navigator recommendation missing typed next role",
      };
    }
    const reason = typeof details.reason === "string" ? details.reason : "";
    const route = Array.isArray(details.route)
      ? details.route
          .filter(isRecord)
          .map((target) => ({
            role: String(target.role),
            phase: navigatorPhaseValue(target.phase),
          }))
      : undefined;
    return recommendationNavigatorFact({
      ...advisoryDiagnostic,
      next: {
        role: next.role,
        phase: navigatorPhaseValue(next.phase),
      },
      reason,
      ...(route === undefined ? {} : { route }),
      ...(typeof details.command === "string"
        ? { modelCommand: details.command }
        : {}),
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
 * Read gate facts from the run's session/auditor-roles nest via the sole
 * nested-volume reader (#446/#478). Missing directory → undefined (no-gate
 * zero change). Damaged discovered volumes propagate — never wash to "no gate".
 */
export async function extractGateFactFromSessionDirectory(
  sessionDirectory: string,
): Promise<TerminalGateFact | undefined> {
  const rounds = await readAnalystGateCyclesFromAuditorRoles(
    join(sessionDirectory, "auditor-roles"),
  );
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
async function withOptionalGateProjection<
  T extends {
    roleOutcome: TerminalRoleOutcome;
    navigator: TerminalNavigatorFact;
    artifacts: readonly TerminalArtifactRef[];
  },
>(base: T, sessionDirectory: string): Promise<T & { gate?: TerminalGateFact }> {
  // A gate transport failure is already represented by typed evidence and has no
  // accepted gate cycle to project. Re-reading that rejected receipt as an
  // accepted cycle would replace the original failure with a projection error.
  const secondaryEvidence = base.roleOutcome.kind === "failure"
    ? base.roleOutcome.decisiveFacts.secondaryEvidence
    : undefined;
  if (
    isRecord(secondaryEvidence)
    && secondaryEvidence.kind === "role_infrastructure_failure"
    && (
      secondaryEvidence.stage === "gatekeeper"
      || secondaryEvidence.stage === "inspector"
      || secondaryEvidence.stage === "notary"
    )
  ) return base;
  const gate = await extractGateFactFromSessionDirectory(sessionDirectory);
  return gate === undefined ? base : { ...base, gate };
}

export function extractNavigatorFact(
  entries: readonly SessionEntry[],
): TerminalNavigatorFact {
  // Affirmative attendance only. Missing / uncorrelated / unparseable is never no-advice.
  // Minimal provenance: latest durable terminal + nearest preceding marker +
  // invocationId + post-terminal order. Marker↔terminal cardinality belongs to
  // receipt settlement (isReceiptSettlementBindingClear), not attendance extraction.
  const terminal = findLatestDurablePackagedRoleTerminal(entries);
  if (terminal === undefined) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance has no durable packaged role terminal",
    };
  }

  let markerIndex = -1;
  for (let i = terminal.index - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex < 0) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts",
    };
  }
  const marker = parseInvocationMarkerIdentity(entries[markerIndex]?.data);
  if (marker === undefined) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts",
    };
  }

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom_message" && entry.customType === "ak-navigator-attendance") {
      const details = entry.message?.details ?? (entry as { details?: unknown }).details;
      if (!isRecord(details)) {
        return {
          disposition: "unavailable",
          source: "unknown",
          reason: "Navigator attendance is unparseable",
        };
      }
      if (
        !navigatorAttendanceCorrelatedWithBoundMarker(
          details,
          i,
          terminal.index,
          marker,
        )
      ) {
        return {
          disposition: "unavailable",
          source: "unknown",
          reason: "Navigator attendance is uncorrelated with session invocation facts",
        };
      }
      return parseNavigatorAttendanceDetails(details);
    }
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

export async function publishJudgeArtifacts(
  admitted: AdmittedJudgeInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
): Promise<TerminalArtifactRef[]> {
  // #419: history first — report/evidence stay last-write-wins views only
  // because every attempt's complete result has already been appended.
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "judge",
        runId: admitted.runId,
        outcome: roleOutcome,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/**
 * Publish lawful Coder success Artifacts on the shared #106 success interface.
 * Evidence records package method provenance without ambient home Skill paths.
 */
export async function publishCoderArtifacts(
  admitted: AdmittedCoderInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
    readonly coderOutput?: CoderOutput;
  } = {},
): Promise<TerminalArtifactRef[]> {
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "coder",
        runId: admitted.runId,
        phase: admitted.phase,
        outcome: roleOutcome,
        ...(options.coderOutput === undefined
          ? {}
          : { receipt: options.coderOutput }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "coder",
        phase: admitted.phase,
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        taskPath: admitted.taskPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
        ...(options.methodProvenance === undefined
          ? {}
          : { methodProvenance: options.methodProvenance }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/** Lawful Coder accepted outcome extracted from session (shared success interface). */
export type LawfulCoderRoleOutcome = {
  kind: "accepted";
  role: "coder";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};
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

/**
 * Lawful Judge outcome presence only — no artifact publication.
 * Returns undefined for genuine absence (missing path / no lawful verdict).
 * Session-read failures propagate with typed identity.
 */
export async function readLawfulJudgeRoleOutcome(
  admitted: AdmittedJudgeInvocation,
  authority: DurablePrincipalAuthority,
): Promise<LawfulJudgeRoleOutcome | undefined> {
  const sealed = await sealedLedgerOutcome(admitted);
  if (sealed?.role === "judge") {
    const details = sealed.decisiveFacts as Record<string, unknown>;
    // sealed.status is the sole authority (written by acceptedFacts at seal).
    return {
      kind: "accepted",
      role: "judge",
      status: sealed.status,
      decisiveFacts: judgeDecisiveFacts(details, sealed.status),
    };
  }
  // Non-final: consume ledger audit-escalation projection (no JSONL accepted rebuild).
  return auditEscalationLedgerOutcome(admitted, "judge", authority);
}

/**
 * Independent confirmation that a lawful Judge terminal result is present in session.
 * Used for resume qualification — must not depend on artifact publication success.
 * Unreadable sessions are not a confirmed lawful result (returns false).
 */
export async function hasLawfulJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
  authority: DurablePrincipalAuthority,
): Promise<boolean> {
  try {
    const outcome = await readLawfulJudgeRoleOutcome(admitted, authority);
    return outcome !== undefined && isLawfulTypedTerminalOutcome(outcome);
  } catch {
    return false;
  }
}

/**
 * Single lawful-settlement implementation (session → outcome/Navigator/artifacts).
 *
 * - Returns undefined only for genuine absence (missing session path, or no
 *   lawful verdict in an otherwise readable session).
 * - Malformed JSONL / other session-read failures throw with knownCause=session
 *   and original identity (SyntaxError name retained).
 * - Artifact publication failures propagate with their original typed identity.
 * - Lawful outcome presence is decided before publication so a later write error
 *   cannot erase the fact that a lawful result already exists.
 */
async function settleLawfulJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  const roleOutcome = await readLawfulJudgeRoleOutcome(admitted, authority);
  if (roleOutcome === undefined) return undefined;
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const entries = await readLawfulSettlementEntries(coordinates.sessionFile) ?? [];
  const navigator = extractNavigatorFact(entries);
  // Lawful outcome exists — artifact publication keeps original errno/name.
  const artifacts = await publishJudgeArtifacts(
    admitted,
    roleOutcome,
    coordinates,
  );
  return withOptionalGateProjection(
    {
      roleOutcome,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    coordinates.sessionDirectory,
  );
}

/**
 * Settle a lawful typed terminal result from the admitted session.
 * Throws when no lawful outcome is present (tests/callers that require success).
 * Session-read and publication failures retain their typed identity.
 */
export async function settleJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult> {
  const settled = await settleLawfulJudgeTerminalResult(admitted, authority);
  if (settled === undefined) {
    throw new Error(
      "Judge Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/**
 * Try to settle a lawful typed terminal result from the admitted session.
 * Returns undefined only for genuine absence (no lawful verdict / missing path).
 * Session malformation and publication exceptions propagate with typed identity.
 */
export async function trySettleJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulJudgeTerminalResult(admitted, authority);
}

async function settleLawfulCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
  } = {},
): Promise<TerminalResult | undefined> {
  const ledgerOutcome = await closedLedgerOutcome(admitted, "coder", authority);
  if (ledgerOutcome === undefined) return undefined;
  let roleOutcome: TerminalRoleOutcome = ledgerOutcome;
  let output: CoderOutput | undefined;
  if (ledgerOutcome.kind === "accepted") {
    output = validateAcceptedCoderDetails(ledgerOutcome.decisiveFacts);
    roleOutcome = {
      kind: "accepted",
      role: "coder",
      status: ledgerOutcome.status,
      decisiveFacts: coderDecisiveFacts(output),
    };
  }
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const entries = await readLawfulSettlementEntries(coordinates.sessionFile) ?? [];
  const navigator = extractNavigatorFact(entries);
  const artifacts = await publishCoderArtifacts(
    admitted,
    roleOutcome,
    coordinates,
    {
      ...(output === undefined ? {} : { coderOutput: output }),
      ...(options.methodProvenance === undefined
        ? {}
        : { methodProvenance: options.methodProvenance }),
    },
  );
  return withOptionalGateProjection(
    {
      roleOutcome,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    coordinates.sessionDirectory,
  );
}

/** Settle a lawful Coder Terminal from the admitted session (shared #106 success interface). */
export async function settleCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
  } = {},
): Promise<TerminalResult> {
  const settled = await settleLawfulCoderTerminalResult(admitted, authority, options);
  if (settled === undefined) {
    throw new Error(
      "Coder Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

function sessionMessageText(message: SessionMessage | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      !Array.isArray(part) &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Observe optional Fixer diagnosing-bugs Skill expansions from the session.
 * Availability is always package-bound; invocation is recorded only when observed.
 */
export function extractFixerMethodInvocations(
  entries: readonly SessionEntry[],
  options: {
    readonly allowedLocations: readonly string[];
  },
): readonly ObservedPackagedMethodSkillInvocation[] {
  const observed: ObservedPackagedMethodSkillInvocation[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const text = sessionMessageText(message);
    if (text.length === 0) continue;
    const hit = observePackagedMethodSkillInvocation(text, {
      name: "diagnosing-bugs",
      allowedLocations: options.allowedLocations,
    });
    if (hit !== undefined) observed.push(hit);
  }
  return Object.freeze(observed);
}

/**
 * Publish lawful Fixer success Artifacts on the shared #106 success interface.
 * Evidence records package diagnosis provenance and optional observed invocation.
 */
export async function publishFixerArtifacts(
  admitted: AdmittedFixerInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodInvocations?: readonly ObservedPackagedMethodSkillInvocation[];
    readonly fixerOutput?: FixerOutput;
  },
): Promise<TerminalArtifactRef[]> {
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "fixer",
        runId: admitted.runId,
        phase: admitted.phase,
        outcome: roleOutcome,
        ...(options.fixerOutput === undefined
          ? {}
          : { receipt: options.fixerOutput }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "fixer",
        phase: admitted.phase,
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        packetPath: admitted.packetPath,
        ...(admitted.prerequisitesPath === undefined
          ? {}
          : { prerequisitesPath: admitted.prerequisitesPath }),
        prerequisites: admitted.prerequisites,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
        methodProvenance: options.methodProvenance,
        // Optional diagnosis: availability is package-bound; invocation only when observed.
        methodInvocationObserved: (options.methodInvocations ?? []).length > 0,
        methodInvocations: options.methodInvocations ?? [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/** Lawful Fixer accepted outcome extracted from session (no LLM auditor after #242). */
export type LawfulFixerRoleOutcome = {
  kind: "accepted";
  role: "fixer";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};
async function settleLawfulFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  const ledgerOutcome = await closedLedgerOutcome(admitted, "fixer", authority);
  if (ledgerOutcome === undefined) return undefined;
  let roleOutcome: TerminalRoleOutcome = ledgerOutcome;
  let output: FixerOutput | undefined;
  if (ledgerOutcome.kind === "accepted") {
    output = validateFixerOutput(ledgerOutcome.decisiveFacts);
    roleOutcome = {
      kind: "accepted",
      role: "fixer",
      status: ledgerOutcome.status,
      decisiveFacts: fixerDecisiveFacts(output),
    };
  }
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  const entries = await readLawfulSettlementEntries(sessionFile) ?? [];
  const navigator = extractNavigatorFact(entries);
  const methodInvocations = extractFixerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath,
    ],
  });
  const artifacts = await publishFixerArtifacts(
    admitted,
    roleOutcome,
    coordinates,
    {
      ...(output === undefined ? {} : { fixerOutput: output }),
      methodProvenance: options.methodProvenance,
      methodInvocations,
    },
  );
  return withOptionalGateProjection(
    {
      roleOutcome,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

/** Settle a lawful Fixer Terminal from the admitted session (shared #106 success interface). */
export async function settleFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult> {
  const settled = await settleLawfulFixerTerminalResult(admitted, authority, options);
  if (settled === undefined) {
    throw new Error(
      "Fixer Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

export async function publishCollectorArtifacts(
  admitted: AdmittedCollectorInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  options: {
    readonly collectorReceipt?: CollectorReceipt;
  } = {},
): Promise<TerminalArtifactRef[]> {
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "collector",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...(options.collectorReceipt === undefined
          ? {}
          : { receipt: options.collectorReceipt }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "collector",
        prNumber: admitted.prNumber,
        repository: admitted.repository.canonical,
        manifestDigest: admitted.manifestDigest,
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/** Lawful Collector accepted outcome extracted from session. */
export type LawfulCollectorRoleOutcome = {
  kind: "accepted";
  role: "collector";
  /** Collector has no status leaf — sealed projection carries acceptedFacts collected. */
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};
async function settleLawfulCollectorTerminalResult(
  admitted: AdmittedCollectorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  const entries = await readLawfulSettlementEntries(sessionFile) ?? [];
  const roleOutcome = await sealedLedgerOutcome(admitted);
  if (roleOutcome?.role !== "collector") {
    // Bounded to the current attempt so multi-attempt resume timeout/no-output
    // is not masked by a prior wait-tool residual (#633).
    const scanStart = currentAttemptStartIndex(entries);
    for (let index = entries.length - 1; index >= scanStart; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(entries, index, message, COLLECTOR_WAIT_TOOL);
      if (residual === undefined) continue;
      const candidate = residual.candidate;
      const duration = isRecord(candidate) ? candidate.durationMs : undefined;
      if (Number.isSafeInteger(duration) && (duration as number) >= 1 && (duration as number) <= 900_000) {
        continue;
      }
      return {
        roleOutcome: buildResidualIncompleteTerminalOutcome({
          role: "collector",
          candidate,
          diagnostic: residual.diagnostic,
        }),
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: admitted.runId,
      };
    }
    return undefined;
  }
  const receipt = validateAcceptedCollectorReceipt(roleOutcome.decisiveFacts);
  assertCollectorReceiptMatchesAdmitted(receipt, admitted);
  const accepted: LawfulCollectorRoleOutcome = {
    kind: "accepted",
    role: "collector",
    status: roleOutcome.status,
    decisiveFacts: collectorDecisiveFacts(receipt),
  };
  const navigator = extractNavigatorFact(entries);
  const artifacts = await publishCollectorArtifacts(
    admitted,
    accepted,
    coordinates,
    { collectorReceipt: receipt },
  );
  return withOptionalGateProjection(
    {
      roleOutcome: accepted,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

/** Settle a lawful Collector Terminal from the admitted session. */
export async function settleCollectorTerminalResult(
  admitted: AdmittedCollectorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult> {
  const settled = await settleLawfulCollectorTerminalResult(admitted, authority);
  if (settled === undefined) {
    throw new Error(
      "Collector Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Collector Terminal; undefined only for genuine absence. */
export async function trySettleCollectorTerminalResult(
  admitted: AdmittedCollectorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulCollectorTerminalResult(admitted, authority);
}

export async function publishDoctorArtifacts(
  admitted: AdmittedDoctorInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  options: {
    readonly doctorOutput?: DoctorOutput;
  } = {},
): Promise<TerminalArtifactRef[]> {
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "doctor",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...(options.doctorOutput === undefined
          ? {}
          : { receipt: options.doctorOutput }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "doctor",
        issueNumber: admitted.issueNumber,
        caseRunsPath: admitted.caseRunsPath,
        caseIdentity: admitted.caseIdentity,
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/** Lawful Doctor accepted/refused/audit_escalation outcome extracted from session. */
export type LawfulDoctorRoleOutcome =
  | {
      kind: "accepted";
      role: "doctor";
      status: string;
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "audit_escalation";
      role: "doctor";
      status: "audit_escalation";
      decisiveFacts: Readonly<Record<string, unknown>>;
    };
async function settleLawfulDoctorTerminalResult(
  admitted: AdmittedDoctorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  const sealed = await sealedLedgerOutcome(admitted);
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  const entries = await readLawfulSettlementEntries(sessionFile) ?? [];
  if (sealed?.role !== "doctor") {
    const escalation = await auditEscalationLedgerOutcome(admitted, "doctor", authority);
    if (escalation === undefined) return undefined;
    const artifacts = await publishDoctorArtifacts(admitted, escalation, coordinates);
    return withOptionalGateProjection(
      {
        roleOutcome: escalation,
        navigator: extractNavigatorFact(entries),
        artifacts,
        runId: admitted.runId,
      },
      sessionDirectory,
    );
  }
  const output = validateRecordedDoctorOutput(sealed.decisiveFacts);
  const roleOutcome: Extract<LawfulDoctorRoleOutcome, { kind: "accepted" }> = {
    kind: "accepted",
    role: "doctor",
    status: sealed.status,
    decisiveFacts: doctorDecisiveFacts(output),
  };
  // Bind completed receipt case identity to the admitted Issue evidence case.
  if (String(output.status) === "completed") {
    const completedCase = (
      output as {
        case: { issueNumber: number; runsPath: string };
      }
    ).case;
    if (
      completedCase.issueNumber !== admitted.caseIdentity.issueNumber ||
      completedCase.runsPath !== admitted.caseIdentity.runsPath
    ) {
      const error = new Error(
        "Doctor receipt case identity does not match admitted case identity",
      ) as Error & { knownCause: ControlledFailureCause };
      error.name = "DoctorReceiptBindingError";
      error.knownCause = "output";
      throw error;
    }
  }
  const navigator = extractNavigatorFact(entries);
  const artifacts = await publishDoctorArtifacts(
    admitted,
    roleOutcome,
    coordinates,
    { doctorOutput: output },
  );
  return withOptionalGateProjection(
    {
      roleOutcome,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

/** Settle a lawful Doctor Terminal from the admitted session. */
export async function settleDoctorTerminalResult(
  admitted: AdmittedDoctorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult> {
  const settled = await settleLawfulDoctorTerminalResult(admitted, authority);
  if (settled === undefined) {
    throw new Error(
      "Doctor Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Doctor Terminal; undefined only for genuine absence. */
export async function trySettleDoctorTerminalResult(
  admitted: AdmittedDoctorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulDoctorTerminalResult(admitted, authority);
}

/**
 * Shared accepted-settlement skeleton for seats that scan residual tool
 * candidates then project sealed ledger outcome (#502 DRY).
 * Role-specific validator / decisiveFacts / diagnostics stay on the seat.
 */
type SeatAcceptedSettlementSpec = {
  readonly role:
    | "notary"
    | "countersign"
    | "gleaner-left"
    | "inspector"
    | "gatekeeper"
    | "navigator";
  readonly toolName: string;
  readonly nonUsableDiagnostic: string;
  readonly projectAccepted: (
    sealed: Extract<TerminalRoleOutcome, { kind: "accepted" }>,
  ) => Extract<TerminalRoleOutcome, { kind: "accepted" }>;
  readonly tryAcceptDetails: (details: unknown) => boolean;
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
  admitted:
    | AdmittedNotaryInvocation
    | AdmittedCountersignInvocation
    | AdmittedGleanerLeftInvocation
    | AdmittedInspectorInvocation
    | AdmittedGatekeeperInvocation
    | AdmittedNavigatorInvocation,
  authority: DurablePrincipalAuthority,
  spec: SeatAcceptedSettlementSpec,
): Promise<TerminalResult | undefined> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  const entries = await readLawfulSettlementEntries(sessionFile) ?? [];
  const roleOutcome = await closedLedgerOutcome(admitted, spec.role as TerminalRoleName, authority);
  if (roleOutcome?.kind === "audit_escalation") {
    const navigator = extractNavigatorFact(entries);
    return withOptionalGateProjection(
      {
        roleOutcome,
        navigator,
        artifacts: [],
        runId: admitted.runId,
      },
      sessionDirectory,
    );
  }
  if (roleOutcome?.role !== spec.role) {
    // No usable release → existing non-zero failure channel with candidate (#475 / ADR 0055).
    // One reverse pass: prefer errored residual; else latest accepted-once non-usable details.
    // Bounded to the current attempt so multi-attempt resume timeout/no-output
    // is not masked by a prior residual (#599 / #633).
    const scanStart = currentAttemptStartIndex(entries);
    let acceptedNonUsable: unknown | undefined;
    for (let index = entries.length - 1; index >= scanStart; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(
        entries,
        index,
        message,
        spec.toolName,
      );
      if (residual !== undefined) {
        return settleFailureTerminalResult(admitted, {
          cause: "output",
          diagnostic: residual.diagnostic,
          details: { candidate: residual.candidate, acceptedReceipt: false },
        }, authority);
      }
      if (
        acceptedNonUsable === undefined &&
        message.toolName === spec.toolName &&
        isAcceptedPackagedRoleTerminalResult(message)
      ) {
        // Accepted once but not a lawful seat release — hold as fallback.
        if (!spec.tryAcceptDetails(message.details)) {
          acceptedNonUsable = message.details;
        }
      }
    }
    if (acceptedNonUsable !== undefined) {
      return settleFailureTerminalResult(admitted, {
        cause: "output",
        diagnostic: spec.nonUsableDiagnostic,
        details: { candidate: acceptedNonUsable, acceptedReceipt: false },
      }, authority);
    }
    return undefined;
  }
  if (!spec.tryAcceptDetails(roleOutcome.decisiveFacts)) {
    return settleFailureTerminalResult(
      admitted,
      {
        cause: "output",
        diagnostic: spec.nonUsableDiagnostic,
        details: { candidate: roleOutcome.decisiveFacts, acceptedReceipt: false },
      },
      authority,
    );
  }
  const acceptedOutcome = spec.projectAccepted(roleOutcome);
  const navigator = extractNavigatorFact(entries);
  return withOptionalGateProjection(
    {
      roleOutcome: acceptedOutcome,
      navigator,
      artifacts: [],
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

function tryAcceptWithValidator(validate: (details: unknown) => unknown): (details: unknown) => boolean {
  return (details) => {
    try {
      validate(details);
      return true;
    } catch {
      return false;
    }
  };
}

/** Lawful Notary accepted outcome (pass/bounce/escalate). */
export type LawfulNotaryRoleOutcome = {
  kind: "accepted";
  role: "notary";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

async function settleLawfulNotaryTerminalResult(
  admitted: AdmittedNotaryInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: "notary",
    toolName: NOTARY_OUTPUT_TOOL_NAME,
    nonUsableDiagnostic: "符宝郎回执无显式 pass/bounce/escalate",
    tryAcceptDetails: tryAcceptWithValidator(validateRecordedNotaryOutput),
    projectAccepted: (sealed) => {
      const output = validateRecordedNotaryOutput(sealed.decisiveFacts);
      const accepted: LawfulNotaryRoleOutcome = {
        kind: "accepted",
        role: "notary",
        status: sealed.status,
        decisiveFacts: notaryDecisiveFacts(output),
      };
      return accepted;
    },
  });
}

/** Settle a lawful Notary Terminal from the admitted session. */
export async function settleNotaryTerminalResult(
  admitted: AdmittedNotaryInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult> {
  const settled = await settleLawfulNotaryTerminalResult(admitted, authority);
  if (settled === undefined) {
    throw new Error(
      "Notary Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Notary Terminal; undefined only for genuine absence. */
export async function trySettleNotaryTerminalResult(
  admitted: AdmittedNotaryInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulNotaryTerminalResult(admitted, authority);
}

/** Lawful Countersign accepted outcome (署/封驳/上呈, #572 / ADR 0074). */
export type LawfulCountersignRoleOutcome = {
  kind: "accepted";
  role: "countersign";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

async function settleLawfulCountersignTerminalResult(
  admitted: AdmittedCountersignInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: "countersign",
    toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
    nonUsableDiagnostic: "给事中回执无显式 署/封驳/上呈",
    tryAcceptDetails: tryAcceptWithValidator(validateRecordedCountersignOutput),
    projectAccepted: (sealed) => {
      const verdict = validateRecordedCountersignOutput(sealed.decisiveFacts);
      const accepted: LawfulCountersignRoleOutcome = {
        kind: "accepted",
        role: "countersign",
        status: sealed.status,
        decisiveFacts: countersignDecisiveFacts(verdict as object, sealed.status),
      };
      return accepted;
    },
  });
}

/** Settle a lawful Countersign Terminal from the admitted session. */
export async function settleCountersignTerminalResult(
  admitted: AdmittedCountersignInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult> {
  const settled = await settleLawfulCountersignTerminalResult(admitted, authority);
  if (settled === undefined) {
    throw new Error(
      "Countersign Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Countersign Terminal; undefined only for genuine absence. */
export async function trySettleCountersignTerminalResult(
  admitted: AdmittedCountersignInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulCountersignTerminalResult(admitted, authority);
}

/** Lawful Gleaner-Left accepted outcome (completed 弹章, #502). */
export type LawfulGleanerLeftRoleOutcome = {
  kind: "accepted";
  role: "gleaner-left";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

async function settleLawfulGleanerLeftTerminalResult(
  admitted: AdmittedGleanerLeftInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: "gleaner-left",
    toolName: GLEANER_LEFT_OUTPUT_TOOL_NAME,
    nonUsableDiagnostic: "左拾遗回执无显式 completed",
    tryAcceptDetails: tryAcceptWithValidator(validateRecordedGleanerLeftOutput),
    projectAccepted: (sealed) => {
      const output = validateRecordedGleanerLeftOutput(sealed.decisiveFacts);
      const accepted: LawfulGleanerLeftRoleOutcome = {
        kind: "accepted",
        role: "gleaner-left",
        status: sealed.status,
        decisiveFacts: gleanerLeftDecisiveFacts(output),
      };
      return accepted;
    },
  });
}

/** Settle a lawful Gleaner-Left Terminal from the admitted session. */
export async function settleGleanerLeftTerminalResult(
  admitted: AdmittedGleanerLeftInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult> {
  const settled = await settleLawfulGleanerLeftTerminalResult(admitted, authority);
  if (settled === undefined) {
    throw new Error(
      "Gleaner-Left Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Gleaner-Left Terminal; undefined only for genuine absence. */
export async function trySettleGleanerLeftTerminalResult(
  admitted: AdmittedGleanerLeftInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulGleanerLeftTerminalResult(admitted, authority);
}

/** Lawful Inspector accepted outcome (pass/bounce/escalate). */
export type LawfulInspectorRoleOutcome = {
  kind: "accepted";
  role: "inspector";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

async function settleLawfulInspectorTerminalResult(
  admitted: AdmittedInspectorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: "inspector",
    toolName: INSPECTOR_OUTPUT_TOOL_NAME,
    nonUsableDiagnostic: "察院回执无显式 pass/bounce/escalate",
    tryAcceptDetails: tryAcceptWithValidator(validateRecordedInspectorOutput),
    projectAccepted: (sealed) => {
      const output = validateRecordedInspectorOutput(sealed.decisiveFacts);
      const accepted: LawfulInspectorRoleOutcome = {
        kind: "accepted",
        role: "inspector",
        status: sealed.status,
        decisiveFacts: inspectorDecisiveFacts(output),
      };
      return accepted;
    },
  });
}

export async function trySettleInspectorTerminalResult(
  admitted: AdmittedInspectorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulInspectorTerminalResult(admitted, authority);
}

/** Lawful Gatekeeper accepted outcome (dispatch | pass, #639). */
export type LawfulGatekeeperRoleOutcome = {
  kind: "accepted";
  role: "gatekeeper";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

async function settleLawfulGatekeeperTerminalResult(
  admitted: AdmittedGatekeeperInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: "gatekeeper",
    toolName: GATEKEEPER_OUTPUT_TOOL_NAME,
    nonUsableDiagnostic: "门下省决议无显式 dispatch/pass",
    tryAcceptDetails: tryAcceptWithValidator(validateRecordedGatekeeperOutput),
    projectAccepted: (sealed) => {
      const output = validateRecordedGatekeeperOutput(sealed.decisiveFacts);
      const accepted: LawfulGatekeeperRoleOutcome = {
        kind: "accepted",
        role: "gatekeeper",
        status: output.status,
        decisiveFacts: gatekeeperDecisiveFacts(output),
      };
      return accepted;
    },
  });
}

/** Try to settle a lawful Gatekeeper Terminal; undefined only for genuine absence. */
export async function trySettleGatekeeperTerminalResult(
  admitted: AdmittedGatekeeperInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulGatekeeperTerminalResult(admitted, authority);
}

/** Lawful Navigator accepted outcome (route advice, #639). */
export type LawfulNavigatorRoleOutcome = {
  kind: "accepted";
  role: "navigator";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

async function settleLawfulNavigatorTerminalResult(
  admitted: AdmittedNavigatorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulSeatAcceptedTerminalResult(admitted, authority, {
    role: "navigator",
    toolName: NAVIGATOR_OUTPUT_TOOL_NAME,
    nonUsableDiagnostic: "游奕使回执无显式路线建议",
    tryAcceptDetails: tryAcceptWithValidator(validateRecordedNavigatorOutput),
    projectAccepted: (sealed) => {
      const output = validateRecordedNavigatorOutput(sealed.decisiveFacts);
      const accepted: LawfulNavigatorRoleOutcome = {
        kind: "accepted",
        role: "navigator",
        status: "advice",
        decisiveFacts: navigatorDecisiveFacts(output),
      };
      return accepted;
    },
  });
}

/** Try to settle a lawful Navigator Terminal; undefined only for genuine absence. */
export async function trySettleNavigatorTerminalResult(
  admitted: AdmittedNavigatorInvocation,
  authority: DurablePrincipalAuthority,
): Promise<TerminalResult | undefined> {
  return settleLawfulNavigatorTerminalResult(admitted, authority);
}

/** Try to settle a lawful Coder Terminal; undefined only for genuine absence. */
export async function trySettleCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
  } = {},
): Promise<TerminalResult | undefined> {
  return settleLawfulCoderTerminalResult(admitted, authority, options);
}

export async function hasLawfulCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  authority: DurablePrincipalAuthority,
): Promise<boolean> {
  try {
    const outcome = await sealedLedgerOutcome(admitted);
    return outcome?.role === "coder";
  } catch {
    return false;
  }
}

/** Try to settle a lawful Fixer Terminal; undefined only for genuine absence. */
export async function trySettleFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  return settleLawfulFixerTerminalResult(admitted, authority, options);
}

export async function hasLawfulFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  authority: DurablePrincipalAuthority,
): Promise<boolean> {
  try {
    const outcome = await sealedLedgerOutcome(admitted);
    return outcome?.role === "fixer";
  } catch {
    return false;
  }
}

/**
 * Observe forced Reviewer code-review Skill expansions from the session.
 * Expansion evidence is package-path only; ambient home locations never count.
 */
export function extractReviewerMethodInvocations(
  entries: readonly SessionEntry[],
  options: {
    readonly allowedLocations: readonly string[];
  },
): readonly ObservedPackagedMethodSkillInvocation[] {
  const observed: ObservedPackagedMethodSkillInvocation[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const text = sessionMessageText(message);
    if (text.length === 0) continue;
    const hit = observePackagedMethodSkillInvocation(text, {
      name: "code-review",
      allowedLocations: options.allowedLocations,
    });
    if (hit !== undefined) observed.push(hit);
  }
  return Object.freeze(observed);
}

/**
 * Publish lawful Reviewer success Artifacts on the shared #106 success interface.
 * Evidence records package code-review provenance and typed expansion
 * observation without ambient home Skill paths.
 */
export async function publishReviewerArtifacts(
  admitted: AdmittedReviewerInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodInvocations?: readonly ObservedPackagedMethodSkillInvocation[];
    readonly reviewerReceipt?: RuntimeReviewerReceiptV2;
  },
): Promise<TerminalArtifactRef[]> {
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "reviewer",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...(options.reviewerReceipt === undefined
          ? {}
          : { receipt: options.reviewerReceipt }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "reviewer",
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        baseRevision: admitted.baseRevision,
        authorityRefs: [...admitted.authorityRefs],
        ...(admitted.instructionEmpty
          ? {}
          : { callerProvenance: admitted.instruction }),
        // Self-fetch Spec bytes + source annotation when primary path produced material (#343).
        ...(options.reviewerReceipt?.specFetchedMaterial === undefined
          ? {}
          : { specFetchedMaterial: options.reviewerReceipt.specFetchedMaterial }),
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
        methodProvenance: options.methodProvenance,
        // Forced package method: availability is package-bound; expansion only when observed.
        methodInvocationObserved: (options.methodInvocations ?? []).length > 0,
        methodInvocations: options.methodInvocations ?? [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/** Lawful Reviewer accepted outcome extracted from session (no LLM auditor after #495 S6). */
export type LawfulReviewerRoleOutcome = {
  kind: "accepted";
  role: "reviewer";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};
async function settleLawfulReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  const sealed = await sealedLedgerOutcome(admitted);
  if (sealed?.role !== "reviewer") return undefined;
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  const entries = await readLawfulSettlementEntries(sessionFile) ?? [];
  const receipt = validateRuntimeReviewerReceipt(sealed.decisiveFacts);
  const roleOutcome: LawfulReviewerRoleOutcome = {
    kind: "accepted",
    role: "reviewer",
    status: sealed.status,
    decisiveFacts: reviewerDecisiveFacts(receipt),
  };
  const navigator = extractNavigatorFact(entries);
  const methodInvocations = extractReviewerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath,
    ],
  });
  const artifacts = await publishReviewerArtifacts(
    admitted,
    roleOutcome,
    coordinates,
    {
      reviewerReceipt: receipt,
      methodProvenance: options.methodProvenance,
      methodInvocations,
    },
  );
  return withOptionalGateProjection(
    {
      roleOutcome,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

/** Settle a lawful Reviewer Terminal from the admitted session (shared #106 success interface). */
export async function settleReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult> {
  const settled = await settleLawfulReviewerTerminalResult(admitted, authority, options);
  if (settled === undefined) {
    throw new Error(
      "Reviewer Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Reviewer Terminal; undefined only for genuine absence. */
export async function trySettleReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  return settleLawfulReviewerTerminalResult(admitted, authority, options);
}

export async function hasLawfulReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
  authority: DurablePrincipalAuthority,
): Promise<boolean> {
  try {
    const outcome = await sealedLedgerOutcome(admitted);
    return outcome?.role === "reviewer";
  } catch {
    return false;
  }
}

function mergerDecisiveFacts(output: MergerOutput): Record<string, unknown> {
  const candidate = output as unknown as object;
  const facts: Record<string, unknown> = {};
  const status = safelyRead(candidate, "status");
  const attemptId = safelyRead(candidate, "attemptId");
  if (status.readable && typeof status.value === "string") facts.mergerStatus = status.value;
  if (attemptId.readable && attemptId.value !== undefined) facts.attemptId = attemptId.value;
  const statusBase =
    status.readable && typeof status.value === "string"
      ? (status.value)
      : undefined;
  const decisiveKey = statusBase === "completed" ? "mergeCommitId" : "diagnosis";
  const decisive = safelyRead(candidate, decisiveKey);
  if (decisive.readable && decisive.value !== undefined) facts[decisiveKey] = decisive.value;
  return facts;
}

/**
 * Observe forced Merger resolving-merge-conflicts Skill expansions from the session.
 * Expansion evidence is package-path only; ambient home locations never count.
 */
export function extractMergerMethodInvocations(
  entries: readonly SessionEntry[],
  options: {
    readonly allowedLocations: readonly string[];
  },
): readonly ObservedPackagedMethodSkillInvocation[] {
  const observed: ObservedPackagedMethodSkillInvocation[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const text = sessionMessageText(message);
    if (text.length === 0) continue;
    const hit = observePackagedMethodSkillInvocation(text, {
      name: "resolving-merge-conflicts",
      allowedLocations: options.allowedLocations,
    });
    if (hit !== undefined) observed.push(hit);
  }
  return Object.freeze(observed);
}

/**
 * Publish lawful Merger success Artifacts on the shared #106 success interface.
 * Evidence records package method provenance, forced expansion observation, and
 * adapter-derived mechanical envelope facts without ambient home Skill paths.
 */
export async function publishMergerArtifacts(
  admitted: AdmittedMergerInvocation,
  roleOutcome: TerminalRoleOutcome,
  coordinates: DurablePrincipalCoordinates,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodInvocations?: readonly ObservedPackagedMethodSkillInvocation[];
    readonly mergerOutput?: MergerOutput;
  },
): Promise<TerminalArtifactRef[]> {
  await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile: coordinates.sessionFile }, roleOutcome);
  const artifactsDir = await ensureRunArtifactsDir(admitted.runDirectory);
  const reportPath = join(artifactsDir, "report.json");
  const evidencePath = join(artifactsDir, "evidence.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        role: "merger",
        runId: admitted.runId,
        outcome: roleOutcome,
        ...(options.mergerOutput === undefined
          ? {}
          : { receipt: options.mergerOutput }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        runId: admitted.runId,
        role: "merger",
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        mergerInputPath: admitted.mergerInputPath,
        derived: admitted.derived,
        attachments: admitted.attachments.map((a) => ({
          provenancePath: a.provenancePath,
          frozenPath: a.frozenPath,
          sha256: a.sha256,
          byteLength: a.byteLength,
        })),
        methodProvenance: options.methodProvenance,
        methodInvocationObserved: (options.methodInvocations ?? []).length > 0,
        methodInvocations: options.methodInvocations ?? [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return [
    { kind: "report", path: reportPath },
    { kind: "evidence", path: evidencePath },
  ];
}

/** Lawful Merger accepted outcome extracted from session (shared success interface). */
export type LawfulMergerRoleOutcome = {
  kind: "accepted";
  role: "merger";
  status: string;
  decisiveFacts: Readonly<Record<string, unknown>>;
};
async function settleLawfulMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  const entries = await readLawfulSettlementEntries(sessionFile) ?? [];
  const roleOutcome = await sealedLedgerOutcome(admitted);
  if (roleOutcome?.role !== "merger") {
    // Ledger owns 0041: a non-sole closed round is not residual-incomplete material.
    const latestOutcome = await readLatestSubmissionOutcome(
      admitted.projectRoot,
      admitted.runId,
      sealedLedgerHome(admitted),
    );
    if (latestOutcome?.outcome === "correctable-rejection" && latestOutcome.code === "non-sole-round") {
      return undefined;
    }
    // Residual incomplete: shape/identity fail after the sole-round barrier passed (ledger typed).
    // Settlement does not re-judge calls.length.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(entries, index, message, MERGER_OUTPUT_TOOL_NAME);
      if (residual === undefined) continue;
      const attemptId = isRecord(residual.candidate)
        ? safelyRead(residual.candidate, "attemptId")
        : { readable: true as const, value: undefined };
      // Admitted-attempt identity binding only (ADR 0037) — not sole-final cardinality.
      if (!attemptId.readable || attemptId.value !== admitted.runId) continue;
      try {
        validateMergerOutput(residual.candidate, admitted.runId);
      } catch {
        return {
          roleOutcome: buildResidualIncompleteTerminalOutcome({
            role: "merger",
            candidate: residual.candidate,
            diagnostic: residual.diagnostic,
          }),
          navigator: { disposition: "no-advice" },
          artifacts: [],
          runId: admitted.runId,
        };
      }
    }
    return undefined;
  }
  const output = validateMergerOutput(roleOutcome.decisiveFacts, admitted.runId);
  const accepted: LawfulMergerRoleOutcome = {
    kind: "accepted",
    role: "merger",
    status: roleOutcome.status,
    decisiveFacts: mergerDecisiveFacts(output),
  };
  const methodInvocations = extractMergerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath,
    ],
  });
  // Every invocation must expand the merge-only method before conflict work.
  if (methodInvocations.length === 0) return undefined;
  const navigator = extractNavigatorFact(entries);
  const artifacts = await publishMergerArtifacts(
    admitted,
    accepted,
    coordinates,
    {
      mergerOutput: output,
      methodProvenance: options.methodProvenance,
      methodInvocations,
    },
  );
  return withOptionalGateProjection(
    {
      roleOutcome: accepted,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

/** Settle a lawful Merger Terminal from the admitted session (shared #106 success interface). */
export async function settleMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult> {
  const settled = await settleLawfulMergerTerminalResult(admitted, authority, options);
  if (settled === undefined) {
    throw new Error(
      "Merger Role run completed without a lawful typed terminal result",
    );
  }
  return settled;
}

/** Try to settle a lawful Merger Terminal; undefined only for genuine absence. */
export async function trySettleMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
  authority: DurablePrincipalAuthority,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  return settleLawfulMergerTerminalResult(admitted, authority, options);
}

export async function hasLawfulMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
  authority: DurablePrincipalAuthority,
): Promise<boolean> {
  try {
    const outcome = await sealedLedgerOutcome(admitted);
    return outcome?.role === "merger";
  } catch {
    return false;
  }
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
    const identity: { name?: string; code?: string | number } = {
      name: error.name,
    };
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      identity.code = code;
    }
    return {
      path,
      diagnostic: error.message || error.name || "write failed",
      identity,
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
  const artifactsDir = join(runDirectory, "artifacts");
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
    ...uniqueFallbackDirs.map((dir) => join(dir, `${stem}.${randomUUID()}.json`)),
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
): Promise<TerminalArtifactRef[]> {
  const { sessionDirectory, sessionFile } = coordinatesFromAdmitted(authority, admitted);
  const { baseDir, attempt: baseAttempt } = await resolveFailureArtifactsBase(
    admitted.runDirectory,
  );
  const priorIssues: PublicationAttempt[] =
    baseAttempt === undefined ? [] : [baseAttempt];
  // #419: each attempt's complete failure result joins the appended history
  // before any fixed-name artifact view is rewritten. History failure must not
  // strand the original controlled failure outside settlement — it rides
  // publicationIssues instead of aborting durability.
  try {
    await appendRunAttemptHistory({ role: admitted.role, runId: admitted.runId, sessionFile }, {
      kind: "failure",
      role: admitted.role,
      ...failure,
    });
  } catch (error) {
    priorIssues.push(publicationAttemptFromError(sessionFile, error));
  }

  // Prefer conventional names; unique fallback dirs keep colliding fixed paths
  // from stranding the original failure outside settlement. Include the ledger
  // runs/ parent so a locked run directory (EACCES) cannot exhaust durability.
  const underArtifacts = baseDir === join(admitted.runDirectory, "artifacts");
  const uniqueFallbackDirs = uniqueFailureFallbackDirs(
    admitted.runDirectory,
    baseDir,
  );
  const errorCandidates = underArtifacts
    ? [
        join(baseDir, "error.json"),
        join(baseDir, "error.settlement.json"),
        join(admitted.runDirectory, "error.settlement.json"),
      ]
    : [
        join(baseDir, "error.settlement.json"),
        join(baseDir, "error.json"),
      ];
  const evidenceCandidates = underArtifacts
    ? [
        join(baseDir, "evidence.json"),
        join(baseDir, "evidence.settlement.json"),
        join(admitted.runDirectory, "evidence.settlement.json"),
      ]
    : [
        join(baseDir, "evidence.settlement.json"),
        join(baseDir, "evidence.json"),
      ];

  const errorPayloadBase: Record<string, unknown> = {
    kind: "error",
    role: admitted.role,
    runId: admitted.runId,
    cause: failure.cause,
    diagnostic: failure.diagnostic,
    ...(failure.identity === undefined ? {} : { identity: failure.identity }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
  };

  const errorWrite = await writeFailureJsonRetainingCause(
    errorCandidates,
    uniqueFallbackDirs,
    "error",
    errorPayloadBase,
    priorIssues,
  );

  const evidencePayload: Record<string, unknown> = {
    runId: admitted.runId,
    sessionDirectory: sessionDirectory,
    sessionFile: sessionFile,
    admittedRequestPath: admitted.admittedRequestPath,
    attachments: admitted.attachments.map((a) => ({
      provenancePath: a.provenancePath,
      frozenPath: a.frozenPath,
      sha256: a.sha256,
      byteLength: a.byteLength,
    })),
    failureCause: failure.cause,
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
 * Durably record a controlled failure (Error Artifact first), then return the
 * Terminal aggregate. Presentation must happen only after this resolves.
 */
/** Redact exact run ID from any string leaves inside decisive facts (arrays/objects included). */
function redactDecisiveFactValue(value: unknown, runId: string): unknown {
  if (typeof value === "string") return redactExactRunId(value, runId);
  if (Array.isArray(value)) {
    return value.map((entry) => redactDecisiveFactValue(entry, runId));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDecisiveFactValue(child, runId);
    }
    return out;
  }
  return value;
}

/** Redact exact run ID from decisive facts at the public Terminal boundary. */
function redactDecisiveFactsForPublicTerminal(
  facts: Readonly<Record<string, unknown>>,
  runId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    out[key] = redactDecisiveFactValue(value, runId);
  }
  return out;
}

/** Redact exact run ID from navigator free-text fields (reason only; commands are registry-owned). */
function redactNavigatorFactForPublicTerminal(
  navigator: TerminalNavigatorFact,
  runId: string,
): TerminalNavigatorFact {
  const advisoryDiagnostic = navigator.advisoryDiagnostic === undefined
    ? {}
    : { advisoryDiagnostic: redactExactRunId(navigator.advisoryDiagnostic, runId) };
  if (navigator.disposition === "recommendation") {
    return {
      ...navigator,
      ...advisoryDiagnostic,
      reason: redactExactRunId(navigator.reason, runId),
    };
  }
  if (navigator.disposition === "unavailable") {
    return {
      ...navigator,
      ...advisoryDiagnostic,
      reason: redactExactRunId(navigator.reason, runId),
    };
  }
  return { ...navigator, ...advisoryDiagnostic };
}

/**
 * Durably record a controlled failure (Error Artifact first), then return the
 * Terminal aggregate. Presentation must happen only after this resolves.
 */
/**
 * Shared controlled-failure Terminal settlement (#107 ownership).
 * Role identity comes from the admitted run; no new failure classes are introduced here.
 */
export async function settleFailureTerminalResult(
  admitted: AdmittedRoleInvocation,
  failure: ControlledFailure,
  authority: DurablePrincipalAuthority,
  options: { readonly resume?: TerminalResume } = {},
): Promise<TerminalResult> {
  const coordinates = coordinatesFromAdmitted(authority, admitted);
  const { sessionDirectory, sessionFile } = coordinates;
  // #288 is lawful only when the lifecycle owner persisted an exhausted,
  // current-attempt fact. Transcript reconstruction must not turn arbitrary output
  // failures (or bytes retained from a prior resume attempt) into exit zero.
  if (failure.cause === "output") {
    const entries = await readBoundSessionEntries(sessionFile).catch(() => undefined);
    if (entries !== undefined) {
      let attemptStart = 0;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.type === "message" && entries[index]?.message?.role === "user") { attemptStart = index; break; }
      }
      const lifecycleEntry = entries.slice(attemptStart).reverse().find((entry: SessionEntry) =>
        entry.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE || entry.message?.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE);
      const raw = lifecycleEntry?.data ?? lifecycleEntry?.message?.details;
      if (raw !== undefined) {
        try {
          const facts = parseNoReceiptLifecycleFacts(raw);
          if (facts.runPointer === admitted.runDirectory && facts.attemptPointer === `current:${admitted.runDirectory}`) {
            const decisiveFacts: NoReceiptLifecycleFacts = facts;
            // #478: no_receipt is still a public Terminal — project accepted gate facts.
            return withOptionalGateProjection(
              {
                roleOutcome: { kind: "no_receipt", role: admitted.role, status: "no-accepted-receipt", ...facts, decisiveFacts },
                navigator: await extractNavigatorFactFromAdmittedSession(sessionFile),
                artifacts: [],
                runId: admitted.runId,
              },
              sessionDirectory,
            );
          }
        } catch { /* malformed lifecycle bytes remain the existing nonzero output failure */ }
      }
    }
  }
  // Exact-session attendance only — never infer no-advice from caller omission.
  const navigator = await extractNavigatorFactFromAdmittedSession(sessionFile);
  // Private durable artifacts retain the original diagnostic identity (including run ID).
  const artifacts = await publishFailureArtifacts(admitted, failure, authority);
  const decisiveFacts: Record<string, unknown> = {
    cause: failure.cause,
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
  // Resumable failures: durable artifacts still land under the run directory, but
  // the public Terminal must not re-disclose the run ID via top-level runId,
  // path components, or untrusted free text — only resume.command may carry it
  // (AC2 / #108).
  if (options.resume !== undefined) {
    const publicDiagnostic = redactExactRunId(failure.diagnostic, admitted.runId);
    const publicFacts = redactDecisiveFactsForPublicTerminal(
      { ...decisiveFacts, diagnostic: publicDiagnostic },
      admitted.runId,
    );
    const roleOutcome: TerminalRoleOutcome = {
      kind: "failure",
      role: admitted.role,
      cause: failure.cause,
      diagnostic: publicDiagnostic,
      decisiveFacts: publicFacts,
    };
    // #478: resume desensitization stays; gate is additive typed fact only.
    return withOptionalGateProjection(
      {
        roleOutcome,
        navigator: redactNavigatorFactForPublicTerminal(navigator, admitted.runId),
        artifacts: [],
        resume: options.resume,
      },
      sessionDirectory,
    );
  }
  const roleOutcome: TerminalRoleOutcome = {
    kind: "failure",
    role: admitted.role,
    cause: failure.cause,
    diagnostic: failure.diagnostic,
    decisiveFacts,
  };
  // #478: ordinary controlled failure still surfaces accepted gate facts.
  return withOptionalGateProjection(
    {
      roleOutcome,
      navigator,
      artifacts,
      runId: admitted.runId,
    },
    sessionDirectory,
  );
}

/** Judge-named alias retained for #107 call sites. */
export async function settleJudgeFailureTerminalResult(
  admitted: AdmittedJudgeInvocation,
  failure: ControlledFailure,
  authority: DurablePrincipalAuthority,
  options: { readonly resume?: TerminalResume } = {},
): Promise<TerminalResult> {
  return settleFailureTerminalResult(admitted, failure, authority, options);
}

/**
 * Emit one complete failure Terminal on stdout and one concise stderr diagnostic.
 * Artifacts are already durable on the TerminalResult.
 */
export function presentFailureTerminal(
  terminal: TerminalResult,
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): void {
  if (terminal.roleOutcome.kind !== "failure" && terminal.roleOutcome.kind !== "no_receipt") {
    throw new TypeError("presentFailureTerminal requires a failure or no-receipt role outcome");
  }
  io.stdout(formatTerminalResult(terminal));
  if (terminal.roleOutcome.kind === "failure") {
    io.stderr(formatFailureStderrDiagnostic({
      cause: terminal.roleOutcome.cause,
      diagnostic: terminal.roleOutcome.diagnostic,
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
