/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #107 / #101).
 * Controlled failures and audit human decisions settle here without washing causes.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isAuditEscalationResult } from "../audit-escalation.ts";
import { AUDITOR_SOUL_ROLES } from "../auditor-soul.ts";
import { DOCTOR_AUDIT_TOOL_NAME } from "../doctor-auditor.ts";
import { FIXER_AUDIT_TOOL_NAME } from "../fixer-auditor.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../judge-auditor.ts";
import { REVIEWER_AUDIT_TOOL_NAME } from "../reviewer-auditor.ts";
import {
  COMPLIANCE_RESPONSE_ENTRY_TYPE,
  readComplianceCandidate,
  type ComplianceAuditIncomplete,
  type ComplianceDecision,
} from "../compliance-transport.ts";
import { loadCollectorManifest } from "../collector-config.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "../collector-ledger.ts";
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
  observePackagedMethodSkillInvocation,
  type ObservedPackagedMethodSkillInvocation,
  type PackagedMethodSkillProvenance,
} from "../package-resources/method-skill.ts";
import {
  bindCurrentDurableTerminalToMarker,
  isAcceptedPackagedRoleTerminalResult,
  isReceiptSettlementBindingClear,
  markerMatchesExpectedIdentity,
  type ExpectedInvocationIdentity,
  type InvocationMarkerIdentity,
} from "../navigator-invocation-identity.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";
import { packagedRoleMetadata } from "../packaged-role-registry.ts";
import {
  workSubjectKeyFromProjectRoot,
  workSubjectKeysEqual,
} from "../work-subject-identity.ts";
import {
  ensureRunArtifactsDir,
  type AdmittedCoderInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedDoctorInvocation,
  type AdmittedFixerInvocation,
  type AdmittedJudgeInvocation,
  type AdmittedMergerInvocation,
  type AdmittedReviewerInvocation,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  recommendationNavigatorFact,
  buildAuditIncompleteTerminalOutcome,
  buildResidualIncompleteTerminalOutcome,
  redactExactRunId,
  type AuditIncompleteResidual,
  type ControlledFailureCause,
  type TerminalArtifactRef,
  type TerminalNavigatorFact,
  type TerminalResult,
  type TerminalResume,
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
            ? "Judge Role run completed without a lawful typed terminal result"
            : `judge role run failed (${input.knownCause})`;
    const diagnostic =
      input.knownDiagnostic !== undefined && input.knownDiagnostic.trim() !== ""
        ? input.knownDiagnostic
        : conciseChildDiagnostic(input.stderr, fallback);
    return {
      cause: input.knownCause,
      diagnostic,
      details: {
        code: input.code,
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
      diagnostic: "judge role run timed out",
      details: { timedOut: true, code: input.code },
    };
  }
  if (input.code !== 0) {
    const fallback = `judge role run failed with exit ${input.code ?? "null"}`;
    return {
      cause: "activation",
      diagnostic: conciseChildDiagnostic(input.stderr, fallback),
      details: { code: input.code },
    };
  }
  if (input.session?.state === "missing") {
    return {
      cause: "session",
      diagnostic: "Judge Role run left no readable session transcript",
      details: { code: input.code, session: "missing" },
    };
  }
  if (input.session?.state === "unreadable") {
    return {
      cause: "session",
      diagnostic: input.session.diagnostic,
      details: { code: input.code, session: "unreadable" },
    };
  }
  return {
    cause: "output",
    diagnostic: "Judge Role run completed without a lawful typed terminal result",
    details: { code: input.code },
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
};

/** Optional independent identity from admitted/shared lifecycle (not attendance self-fields). */
export type NavigatorAttendanceIdentity = {
  readonly phase?: NavigatorPhase;
  readonly subjectKey?: string;
};

function isMissingPathError(error: unknown): boolean {
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
 * Latest native assistant provider-stop in a session (stopReason === "error").
 * Only the final assistant turn decides terminality — an older error followed by a
 * later non-error stop is not a provider failure (would wash a no-lawful-output path).
 * Typed production source for provider cause — not child stderr prose.
 */
export function extractSessionProviderStop(
  entries: readonly SessionEntry[],
): {
  stopReason: "error";
  errorMessage?: string;
  provider?: string;
  model?: string;
} | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    // Latest assistant only (reviewer-child-executor lastAssistant pattern).
    if (message.stopReason !== "error") return undefined;
    return {
      stopReason: "error",
      ...(typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
        ? { errorMessage: message.errorMessage }
        : {}),
      ...(typeof message.provider === "string" && message.provider.trim() !== ""
        ? { provider: message.provider }
        : {}),
      ...(typeof message.model === "string" && message.model.trim() !== ""
        ? { model: message.model }
        : {}),
    };
  }
  return undefined;
}

/** Read the bound session principal and extract a typed provider-stop, if any. */
export async function readSessionProviderStop(
  sessionFile: string,
): Promise<
  | {
      stopReason: "error";
      errorMessage?: string;
      provider?: string;
      model?: string;
    }
  | undefined
> {
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractSessionProviderStop(entries);
  } catch {
    return undefined;
  }
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

function judgeDecisiveFacts(
  verdict: object,
  judgeStatus: JudgeVerdict["judgeStatus"],
): Record<string, unknown> {
  const facts: Record<string, unknown> = { judgeStatus };
  if (judgeStatus === "continue") {
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
  if (judgeStatus === "escalate") {
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
  const remainingScope = safelyRead(candidate, "remainingScope");
  if (status.readable && status.value === "unfinished" && remainingScope.readable && typeof remainingScope.value === "string") facts.remainingScope = remainingScope.value;
  const report = safelyRead(candidate, "report");
  if (report.readable && typeof report.value === "string") facts.reportPresent = report.value.trim().length > 0;
  return facts;
}

function fixerDecisiveFacts(output: FixerOutput): Record<string, unknown> {
  const candidate = output as unknown as object;
  const status = safelyRead(candidate, "status");
  const facts: Record<string, unknown> = {};
  if (status.readable && typeof status.value === "string") facts.fixerStatus = status.value;
  const remainingScope = safelyRead(candidate, "remainingScope");
  if (status.readable && (status.value === "unfinished" || status.value === "refused") && remainingScope.readable && typeof remainingScope.value === "string") facts.remainingScope = remainingScope.value;
  const blockerRead = safelyRead(candidate, "blocker");
  if (status.readable && status.value === "refused" && blockerRead.readable && isRecord(blockerRead.value)) {
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
  const legs = safelyRead(candidate, "legs");
  if (legs.readable && Array.isArray(legs.value)) {
    try {
      facts.legStatuses = legs.value.map((leg) => {
        if (!isRecord(leg)) throw new Error("unreadable Collector leg");
        const legId = safelyRead(leg, "legId");
        const status = safelyRead(leg, "status");
        if (!legId.readable || !status.readable) throw new Error("unreadable Collector leg");
        return { legId: legId.value, status: status.value };
      });
    } catch { /* omit unreadable optional projection */ }
  }
  return facts;
}

function doctorDecisiveFacts(output: DoctorOutput): Record<string, unknown> {
  const candidate = output as unknown as object;
  const status = safelyRead(candidate, "status");
  const facts: Record<string, unknown> = {};
  if (status.readable && typeof status.value === "string") facts.doctorStatus = status.value;
  if (status.readable && status.value === "refused") {
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
  const axes = reviewerAxes(outcomes.readable ? outcomes.value : undefined);
  const reportAxes = reviewerAxes(reports.readable ? reports.value : undefined);
  const acceptedBatch = safelyRead(candidate, "acceptedBatch");
  const facts: Record<string, unknown> = {
    axes,
    reportAxes,
    acceptedBatchPresent: acceptedBatch.readable && acceptedBatch.value !== undefined,
  };
  if (status.readable && typeof status.value === "string") facts.reviewerStatus = status.value;
  const diagnostic = safelyRead(candidate, "diagnostic");
  if (status.readable && status.value === "refused" && diagnostic.readable) {
    facts.diagnosticPresent = typeof diagnostic.value === "string" && diagnostic.value.trim().length > 0;
  }
  return facts;
}

/**
 * ADR 0037: a shape-valid Collector receipt may still name the wrong live target.
 * Public success binds receipt identity to this admitted repository/PR/manifest/legs
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

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
]);

/**
 * Prefer a real Collector infrastructure tool failure already on the session
 * principal over a later secondary provider-stop (failure-honesty).
 * Observe/request/wait host failures keep their diagnostic identity (e.g. HTTP 404).
 */
export function extractCollectorInfrastructureFailure(
  entries: readonly SessionEntry[],
): ControlledFailure | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.isError !== true) continue;
    if (
      typeof message.toolName !== "string" ||
      !COLLECTOR_INFRASTRUCTURE_TOOLS.has(message.toolName)
    ) {
      continue;
    }
    const diagnostic = toolResultText(message);
    if (diagnostic.length === 0) continue;
    return {
      cause: "activation",
      diagnostic,
      identity: { name: "CollectorInfrastructureError" },
    };
  }
  return undefined;
}

/** Read the bound session principal for a Collector infrastructure tool failure. */
export async function readCollectorInfrastructureFailure(
  sessionFile: string,
): Promise<ControlledFailure | undefined> {
  try {
    const entries = await readBoundSessionEntries(sessionFile);
    return extractCollectorInfrastructureFailure(entries);
  } catch {
    return undefined;
  }
}

/**
 * Compare a validated receipt with the admitted Collector invocation identity.
 * Throws a typed output failure when any identity field mismatches.
 */
export function assertCollectorReceiptMatchesAdmitted(
  receipt: CollectorReceipt,
  admitted: AdmittedCollectorInvocation,
  admittedLegIds: readonly string[],
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
  const receiptLegIds = sortedUniqueStrings(
    receipt.legs.map((leg) => leg.legId),
  );
  const expectedLegIds = sortedUniqueStrings(admittedLegIds);
  if (
    receipt.legs.length !== admittedLegIds.length ||
    receiptLegIds.length !== expectedLegIds.length ||
    receiptLegIds.some((id, index) => id !== expectedLegIds[index])
  ) {
    throw collectorReceiptBindingFailure(
      `Collector receipt leg set [${receiptLegIds.join(",")}] does not match admitted leg set [${expectedLegIds.join(",")}]`,
    );
  }
}

/**
 * Shared audit-incomplete extraction for the four roles with Soul auditors.
 * The role submission and retained auditor response are separate evidence faces;
 * neither is converted into an accepted Receipt.
 */
function isComplianceAuditIncomplete(value: unknown): value is ComplianceAuditIncomplete {
  if (!isRecord(value) || value.status !== "audit-incomplete") return false;
  const observation = value.observation;
  if (!isRecord(observation)) return false;
  if (observation.kind === "object-status-unreadable") {
    return observation.status === "missing" || observation.status === "unknown";
  }
  return observation.kind === "non-object-arguments" && [
    "null",
    "array",
    "undefined",
    "string",
    "number",
    "boolean",
    "bigint",
    "symbol",
    "function",
  ].includes(observation.type as string);
}

function auditToolNameForRole(
  role: (typeof AUDITOR_SOUL_ROLES)[number],
): string {
  switch (role) {
    case "judge":
      return JUDGE_AUDIT_TOOL_NAME;
    case "fixer":
      return FIXER_AUDIT_TOOL_NAME;
    case "reviewer":
      return REVIEWER_AUDIT_TOOL_NAME;
    case "doctor":
      return DOCTOR_AUDIT_TOOL_NAME;
  }
}

function outputToolNameForAuditedRole(
  role: (typeof AUDITOR_SOUL_ROLES)[number],
): string {
  switch (role) {
    case "judge":
      return JUDGE_OUTPUT_TOOL_NAME;
    case "fixer":
      return FIXER_OUTPUT_TOOL_NAME;
    case "reviewer":
      return REVIEWER_OUTPUT_TOOL_NAME;
    case "doctor":
      return DOCTOR_OUTPUT_TOOL_NAME;
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

function auditIncompleteFromCandidate(
  candidate: unknown,
): ComplianceAuditIncomplete | undefined {
  const decision = readComplianceCandidate(candidate);
  return decision.status === "audit-incomplete" ? decision : undefined;
}

function boundRetainedAuditResponse(
  entries: readonly SessionEntry[],
  callIndex: number,
  resultIndex: number,
  auditToolName: string,
): BoundRetainedAuditResponse | undefined {
  const matches: BoundRetainedAuditResponse[] = [];
  let retainedResponseCount = 0;
  for (let index = callIndex + 1; index < resultIndex; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== COMPLIANCE_RESPONSE_ENTRY_TYPE) {
      continue;
    }
    retainedResponseCount += 1;
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
  return retainedResponseCount === 1 && matches.length === 1 ? matches[0] : undefined;
}

export function extractComplianceAuditIncompleteRoleOutcome(
  entries: readonly SessionEntry[],
  role: (typeof AUDITOR_SOUL_ROLES)[number],
  outputToolName: string,
): { outcome: ReturnType<typeof buildAuditIncompleteTerminalOutcome> } | undefined {
  if (outputToolName !== outputToolNameForAuditedRole(role)) return undefined;
  const auditToolName = auditToolNameForRole(role);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (
      entries[index]?.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== outputToolName ||
      message.isError === true ||
      !isComplianceAuditIncomplete(message.details)
    ) {
      continue;
    }
    const roleCall = boundRoleToolCallForResult(
      entries,
      index,
      message,
      outputToolName,
    );
    if (roleCall === undefined) continue;
    const retained = boundRetainedAuditResponse(
      entries,
      roleCall.callIndex,
      index,
      auditToolName,
    );
    if (retained === undefined) continue;
    const audit = auditIncompleteFromCandidate(retained.candidate);
    if (audit === undefined) continue;
    return {
      outcome: buildAuditIncompleteTerminalOutcome({
        role,
        roleCandidate: roleCall.candidate,
        audit,
      }),
    };
  }
  return undefined;
}

function auditArtifactPublicationError(message: string, code: string): Error & {
  code: string;
} {
  const error = new Error(message) as Error & { code: string };
  error.name = "ArtifactPublicationError";
  error.code = code;
  return error;
}

async function ensureAuditEvidenceDirectory(runDirectory: string): Promise<string> {
  const artifactsDir = join(runDirectory, "artifacts");
  const runStat = await lstat(runDirectory);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw auditArtifactPublicationError(
      "audit evidence run directory is not a real directory",
      "ELOOP",
    );
  }
  try {
    const existing = await lstat(artifactsDir);
    if (existing.isSymbolicLink()) {
      throw auditArtifactPublicationError(
        "audit evidence artifacts directory is a symlink",
        "ELOOP",
      );
    }
    if (!existing.isDirectory()) {
      throw auditArtifactPublicationError(
        "audit evidence artifacts path is not a directory",
        "EEXIST",
      );
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(artifactsDir, { recursive: true });
    const created = await lstat(artifactsDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw auditArtifactPublicationError(
        "audit evidence artifacts directory is not a real directory",
        "ELOOP",
      );
    }
  }
  return artifactsDir;
}

/** Publish the retained residual with exclusive, complete-write semantics. */
export async function publishComplianceAuditIncompleteEvidence(
  admitted: AdmittedRoleInvocation,
  outcome: ReturnType<typeof buildAuditIncompleteTerminalOutcome>,
): Promise<TerminalArtifactRef> {
  const artifactsDir = await ensureAuditEvidenceDirectory(admitted.runDirectory);
  const evidencePath = join(artifactsDir, "audit-incomplete.json");
  try {
    const existing = await lstat(evidencePath);
    throw auditArtifactPublicationError(
      existing.isSymbolicLink()
        ? "audit evidence destination is a symlink"
        : "audit evidence destination collision",
      existing.isSymbolicLink() ? "ELOOP" : "EEXIST",
    );
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const handle = await open(evidencePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(outcome, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { kind: "evidence", path: evidencePath };
}

function auditPublicationFailureTerminal(
  admitted: AdmittedRoleInvocation,
  entries: readonly SessionEntry[],
  outcome: ReturnType<typeof buildAuditIncompleteTerminalOutcome>,
  error: unknown,
): TerminalResult {
  const attempt = publicationAttemptFromError(
    join(admitted.runDirectory, "artifacts", "audit-incomplete.json"),
    error,
  );
  const diagnostic = `audit-incomplete evidence publication failed: ${attempt.diagnostic}`;
  const decisiveFacts: Record<string, unknown> = {
    ...outcome.decisiveFacts,
    cause: "unrecognized",
    diagnostic,
    publicationFailure: attempt,
  };
  if (attempt.identity?.name !== undefined) decisiveFacts.errorName = attempt.identity.name;
  if (attempt.identity?.code !== undefined) decisiveFacts.errorCode = attempt.identity.code;
  const auditResidual: AuditIncompleteResidual = {
    roleCandidate: outcome.roleCandidate,
    audit: outcome.audit,
    acceptedReceipt: false,
  };
  return {
    roleOutcome: {
      kind: "failure",
      role: admitted.role,
      cause: "unrecognized",
      diagnostic,
      decisiveFacts,
      auditResidual,
    },
    navigator: extractNavigatorFact(entries),
    artifacts: [],
    runId: admitted.runId,
  };
}

/**
 * Settle the shared audit-incomplete Terminal for Judge/Fixer/Reviewer/Doctor.
 * Callers invoke this only after their ordinary lawful extractor found no result,
 * which preserves the no-other-lawful-result invariant without a second validator.
 */
export async function trySettleComplianceAuditIncompleteTerminalResult(
  admitted: AdmittedRoleInvocation,
): Promise<TerminalResult | undefined> {
  if (!(AUDITOR_SOUL_ROLES as readonly string[]).includes(admitted.role)) {
    return undefined;
  }
  const outputToolName =
    admitted.role === "judge"
      ? JUDGE_OUTPUT_TOOL_NAME
      : admitted.role === "fixer"
        ? FIXER_OUTPUT_TOOL_NAME
        : admitted.role === "reviewer"
          ? REVIEWER_OUTPUT_TOOL_NAME
          : DOCTOR_OUTPUT_TOOL_NAME;
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractComplianceAuditIncompleteRoleOutcome(
    entries,
    admitted.role as (typeof AUDITOR_SOUL_ROLES)[number],
    outputToolName,
  );
  if (extracted === undefined) return undefined;
  try {
    const evidence = await publishComplianceAuditIncompleteEvidence(
      admitted,
      extracted.outcome,
    );
    return {
      roleOutcome: extracted.outcome,
      navigator: extractNavigatorFact(entries),
      artifacts: [evidence],
      runId: admitted.runId,
    };
  } catch (error) {
    // Publication failure is a non-lawful terminal, never an accepted audit result.
    return auditPublicationFailureTerminal(admitted, entries, extracted.outcome, error);
  }
}

/** Lawful Judge outcomes extracted from session (never a fabricated failure Receipt). */
export type LawfulJudgeRoleOutcome = Extract<
  TerminalRoleOutcome,
  { kind: "accepted" } | { kind: "audit_escalation" }
>;

export function extractJudgeRoleOutcome(
  entries: readonly SessionEntry[],
): LawfulJudgeRoleOutcome | undefined {
  // Singleton marker↔terminal cardinality — ambiguous multi-terminal fails closed.
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== JUDGE_OUTPUT_TOOL_NAME) continue;
    // Shared classifier owns accepted/human vs non-Receipt terminal discriminant.
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const details = message.details;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "judge",
      JUDGE_OUTPUT_TOOL_NAME,
    );
    if (escalation !== undefined) {
      return {
        kind: "audit_escalation",
        role: "judge",
        status: "audit_escalation",
        decisiveFacts: { ...escalation.details },
      };
    }
    if (isUnboundAuditEscalationFace(details)) continue;
    // The known discriminator selects the branch; optional presentation material
    // must not become a second verdict-shape gate (ADR 0040).
    if (!isRecord(details)) continue;
    const statusRead = safelyRead(details, "judgeStatus");
    if (!statusRead.readable) continue;
    const judgeStatus = statusRead.value;
    if (judgeStatus !== "converged" && judgeStatus !== "continue" && judgeStatus !== "escalate") continue;
    return {
      kind: "accepted",
      role: "judge",
      status: judgeStatus,
      decisiveFacts: judgeDecisiveFacts(details, judgeStatus),
    };
  }
  return undefined;
}

function navigatorPhaseValue(value: unknown): NavigatorPhase {
  if (value === "plan" || value === "apply") return value;
  return null;
}

function attendanceIdentityFromAdmitted(
  admitted: AdmittedRoleInvocation,
): NavigatorAttendanceIdentity {
  // Public CLI sessions live under the machine ledger; Navigator derives subject from
  // the project/cwd work identity, not the per-run session directory spelling.
  const subjectKey = workSubjectKeyFromProjectRoot(admitted.projectRoot);
  if (admitted.role === "coder" || admitted.role === "fixer") {
    return { phase: admitted.phase, subjectKey };
  }
  return { phase: null, subjectKey };
}

/**
 * Independent expected role/phase/subject for marker correlation.
 * Role comes from the durable packaged terminal tool; phase/subject from admitted
 * lifecycle, Developer session cwd, or registry — never attendance self-fields.
 */
function independentExpectedIdentity(
  entries: readonly SessionEntry[],
  terminalRole: string,
  supplied?: NavigatorAttendanceIdentity,
): ExpectedInvocationIdentity {
  let subjectKey: string | undefined;
  for (const entry of entries) {
    if (entry?.type !== "session") continue;
    if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") {
      subjectKey = workSubjectKeyFromProjectRoot(entry.cwd);
    }
    break;
  }
  if (typeof supplied?.subjectKey === "string") {
    subjectKey = supplied.subjectKey;
  }

  let phase: NavigatorPhase | undefined;
  let allowedPhases: readonly NavigatorPhase[] | undefined;
  // null is a real phase fact (Judge/Reviewer/…); only omit when not independently known.
  if (supplied !== undefined && Object.hasOwn(supplied, "phase")) {
    phase = supplied.phase ?? null;
  } else {
    const meta = packagedRoleMetadata(terminalRole);
    if (meta !== undefined) {
      if (meta.phases.length === 1) {
        phase = meta.phases[0] as NavigatorPhase;
      } else {
        allowedPhases = meta.phases as readonly NavigatorPhase[];
      }
    }
  }

  return {
    role: terminalRole,
    ...(phase !== undefined ? { phase } : {}),
    ...(allowedPhases !== undefined ? { allowedPhases } : {}),
    ...(subjectKey !== undefined ? { subjectKey } : {}),
  };
}

/**
 * Attendance must match the bound marker identity and current durable terminal role.
 * Self-shape of attendance fields is not correlation. Marker already matched the
 * independent expected identity before this check runs.
 */
function navigatorAttendanceCorrelatedWithBoundMarker(
  details: Record<string, unknown>,
  attendanceIndex: number,
  terminal: { index: number; role: string },
  marker: InvocationMarkerIdentity,
): boolean {
  if (attendanceIndex <= terminal.index) return false;
  if (details.version !== 1) return false;

  // Role comes from the packaged terminal tool — compare, do not self-validate.
  if (details.role !== terminal.role) return false;
  // Marker role must already equal terminal role (checked by caller); attendance follows marker.
  if (details.role !== marker.role) return false;

  // Exact current invocation token is the bound marker principal.
  if (details.invocationId !== marker.invocationId) return false;

  // Phase and subject ride the same marker identity truth table.
  if (details.phase !== marker.phase) return false;
  if (typeof details.subjectKey !== "string") return false;
  if (!workSubjectKeysEqual(details.subjectKey, marker.subjectKey)) return false;

  return true;
}

function parseNavigatorAttendanceDetails(
  details: Record<string, unknown>,
): TerminalNavigatorFact {
  const disposition = details.disposition;
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

export function extractNavigatorFact(
  entries: readonly SessionEntry[],
  identity?: NavigatorAttendanceIdentity,
): TerminalNavigatorFact {
  // Affirmative attendance only. Missing / uncorrelated / unparseable is never no-advice.
  // One truth table: durable classifier + singleton marker binding + marker identity match.
  const binding = bindCurrentDurableTerminalToMarker(entries);
  if (binding.kind === "absent") {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance has no durable packaged role terminal",
    };
  }
  if (binding.kind === "ambiguous") {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is ambiguous across multiple durable role terminals",
    };
  }
  if (binding.kind === "unbound") {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts",
    };
  }

  const { terminal, marker } = binding;
  // Marker role must match the durable terminal tool's role.
  if (marker.role !== terminal.role) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: "Navigator attendance is uncorrelated with session invocation facts",
    };
  }
  // Marker phase/subject (and role) must match independently admitted expected identity.
  const expected = independentExpectedIdentity(entries, terminal.role, identity);
  if (!markerMatchesExpectedIdentity(marker, expected)) {
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
          { index: terminal.index, role: terminal.role },
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
  admitted: AdmittedRoleInvocation,
): Promise<TerminalNavigatorFact> {
  try {
    const entries = await readBoundSessionEntries(admitted.sessionFile);
    return extractNavigatorFact(entries, attendanceIdentityFromAdmitted(admitted));
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
  sessionDirectory: string,
): Promise<TerminalArtifactRef[]> {
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
        sessionDirectory,
        sessionFile: admitted.sessionFile,
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
  sessionDirectory: string,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
    readonly coderOutput?: CoderOutput;
  } = {},
): Promise<TerminalArtifactRef[]> {
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
        sessionDirectory,
        sessionFile: admitted.sessionFile,
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

export function extractCoderRoleOutcome(
  entries: readonly SessionEntry[],
): { outcome: LawfulCoderRoleOutcome; output: CoderOutput } | undefined {
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== CODER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    try {
      validateAcceptedDetails(CODER_OUTPUT_TOOL_NAME, message.details);
      const output = validateAcceptedCoderDetails(message.details);
      const outcome: LawfulCoderRoleOutcome = {
        kind: "accepted",
        role: "coder",
        status: output.status,
        decisiveFacts: coderDecisiveFacts(output),
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Read session entries for lawful settlement. Missing path → undefined (absence).
 * Malformed JSONL / other read failures throw with knownCause=session.
 */
async function readLawfulSettlementEntries(
  admitted: AdmittedRoleInvocation,
): Promise<SessionEntry[] | undefined> {
  try {
    return await readBoundSessionEntries(admitted.sessionFile);
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
): Promise<LawfulJudgeRoleOutcome | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  return extractJudgeRoleOutcome(entries);
}

/**
 * Independent confirmation that a lawful Judge terminal result is present in session.
 * Used for resume qualification — must not depend on artifact publication success.
 * Unreadable sessions are not a confirmed lawful result (returns false).
 */
export async function hasLawfulJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
): Promise<boolean> {
  try {
    const outcome = await readLawfulJudgeRoleOutcome(admitted);
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
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const roleOutcome = extractJudgeRoleOutcome(entries);
  if (roleOutcome === undefined) {
    return undefined;
  }
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  // Lawful outcome exists — artifact publication keeps original errno/name.
  const artifacts = await publishJudgeArtifacts(
    admitted,
    roleOutcome,
    admitted.sessionDirectory,
  );
  return {
    roleOutcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/**
 * Settle a lawful typed terminal result from the admitted session.
 * Throws when no lawful outcome is present (tests/callers that require success).
 * Session-read and publication failures retain their typed identity.
 */
export async function settleJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
): Promise<TerminalResult> {
  const settled = await settleLawfulJudgeTerminalResult(admitted);
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
): Promise<TerminalResult | undefined> {
  return settleLawfulJudgeTerminalResult(admitted);
}

async function settleLawfulCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
  } = {},
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractCoderRoleOutcome(entries);
  if (extracted === undefined) return undefined;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  const artifacts = await publishCoderArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      coderOutput: extracted.output,
      ...(options.methodProvenance === undefined
        ? {}
        : { methodProvenance: options.methodProvenance }),
    },
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Settle a lawful Coder Terminal from the admitted session (shared #106 success interface). */
export async function settleCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
  } = {},
): Promise<TerminalResult> {
  const settled = await settleLawfulCoderTerminalResult(admitted, options);
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
  sessionDirectory: string,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodInvocations?: readonly ObservedPackagedMethodSkillInvocation[];
    readonly fixerOutput?: FixerOutput;
  },
): Promise<TerminalArtifactRef[]> {
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
        sessionDirectory,
        sessionFile: admitted.sessionFile,
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

/** Lawful Fixer accepted / audit_escalation outcome extracted from session. */
export type LawfulFixerRoleOutcome =
  | {
      kind: "accepted";
      role: "fixer";
      status: string;
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "audit_escalation";
      role: "fixer";
      status: "audit_escalation";
      decisiveFacts: Readonly<Record<string, unknown>>;
    };

export function extractFixerRoleOutcome(
  entries: readonly SessionEntry[],
): { outcome: LawfulFixerRoleOutcome; output?: FixerOutput } | undefined {
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== FIXER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const details = message.details;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "fixer",
      FIXER_OUTPUT_TOOL_NAME,
    );
    // #107 owns generic audit presentation; hand off only a bound escalation.
    if (escalation !== undefined) {
      return {
        outcome: {
          kind: "audit_escalation",
          role: "fixer",
          status: "audit_escalation",
          decisiveFacts: { ...escalation.details },
        },
      };
    }
    if (isUnboundAuditEscalationFace(details)) continue;
    try {
      validateAcceptedDetails(FIXER_OUTPUT_TOOL_NAME, details);
      const output = validateFixerOutput(details);
      const outcome: LawfulFixerRoleOutcome = {
        kind: "accepted",
        role: "fixer",
        status: output.status,
        decisiveFacts: fixerDecisiveFacts(output),
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function settleLawfulFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractFixerRoleOutcome(entries);
  if (extracted === undefined) return undefined;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  const methodInvocations = extractFixerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath,
    ],
  });
  const artifacts = await publishFixerArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      ...(extracted.output === undefined ? {} : { fixerOutput: extracted.output }),
      methodProvenance: options.methodProvenance,
      methodInvocations,
    },
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Settle a lawful Fixer Terminal from the admitted session (shared #106 success interface). */
export async function settleFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult> {
  const settled = await settleLawfulFixerTerminalResult(admitted, options);
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
  sessionDirectory: string,
  options: {
    readonly collectorReceipt?: CollectorReceipt;
  } = {},
): Promise<TerminalArtifactRef[]> {
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
        legsPath: admitted.legsPath,
        manifestDigest: admitted.manifestDigest,
        sessionDirectory,
        sessionFile: admitted.sessionFile,
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
  /** Collector has no status leaf — synthesize a stable collected marker. */
  status: "collected";
  decisiveFacts: Readonly<Record<string, unknown>>;
};

export function extractCollectorRoleOutcome(
  entries: readonly SessionEntry[],
): { outcome: LawfulCollectorRoleOutcome; receipt: CollectorReceipt } | undefined {
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== COLLECTOR_OUTPUT_TOOL) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    try {
      const receipt = validateAcceptedCollectorReceipt(message.details);
      const outcome: LawfulCollectorRoleOutcome = {
        kind: "accepted",
        role: "collector",
        status: "collected",
        decisiveFacts: collectorDecisiveFacts(receipt),
      };
      return { receipt, outcome };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function settleLawfulCollectorTerminalResult(
  admitted: AdmittedCollectorInvocation,
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractCollectorRoleOutcome(entries);
  if (extracted === undefined) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
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
  // Re-load legs.json and bind its digest to admission before using its IDs (ADR 0037/0022).
  // A post-admission mutation that keeps receipt digest=A while legs become B must fail closed.
  const admittedManifest = await loadCollectorManifest(admitted.legsPath);
  if (admittedManifest.digest !== admitted.manifestDigest) {
    throw collectorReceiptBindingFailure(
      `Collector legs at settlement digest does not match admitted manifestDigest`,
    );
  }
  assertCollectorReceiptMatchesAdmitted(
    extracted.receipt,
    admitted,
    admittedManifest.legs.map((leg) => leg.id),
  );
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  const artifacts = await publishCollectorArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    { collectorReceipt: extracted.receipt },
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Settle a lawful Collector Terminal from the admitted session. */
export async function settleCollectorTerminalResult(
  admitted: AdmittedCollectorInvocation,
): Promise<TerminalResult> {
  const settled = await settleLawfulCollectorTerminalResult(admitted);
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
): Promise<TerminalResult | undefined> {
  return settleLawfulCollectorTerminalResult(admitted);
}

export async function publishDoctorArtifacts(
  admitted: AdmittedDoctorInvocation,
  roleOutcome: TerminalRoleOutcome,
  sessionDirectory: string,
  options: {
    readonly doctorOutput?: DoctorOutput;
  } = {},
): Promise<TerminalArtifactRef[]> {
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
        sessionDirectory,
        sessionFile: admitted.sessionFile,
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

export function extractDoctorRoleOutcome(
  entries: readonly SessionEntry[],
): { outcome: LawfulDoctorRoleOutcome; output?: DoctorOutput } | undefined {
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== DOCTOR_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const details = message.details;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "doctor",
      DOCTOR_OUTPUT_TOOL_NAME,
    );
    if (escalation !== undefined) {
      return {
        outcome: {
          kind: "audit_escalation",
          role: "doctor",
          status: "audit_escalation",
          decisiveFacts: { ...escalation.details },
        },
      };
    }
    if (isUnboundAuditEscalationFace(details)) continue;
    try {
      const output = validateRecordedDoctorOutput(details);
      const outcome: LawfulDoctorRoleOutcome = {
        kind: "accepted",
        role: "doctor",
        status: output.status,
        decisiveFacts: doctorDecisiveFacts(output),
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function settleLawfulDoctorTerminalResult(
  admitted: AdmittedDoctorInvocation,
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractDoctorRoleOutcome(entries);
  if (extracted === undefined) return undefined;
  // Bind completed receipt case identity to the admitted Issue evidence case.
  if (
    extracted.output !== undefined &&
    extracted.output.status === "completed"
  ) {
    if (
      extracted.output.case.issueNumber !== admitted.caseIdentity.issueNumber ||
      extracted.output.case.runsPath !== admitted.caseIdentity.runsPath
    ) {
      const error = new Error(
        "Doctor receipt case identity does not match admitted case identity",
      ) as Error & { knownCause: ControlledFailureCause };
      error.name = "DoctorReceiptBindingError";
      error.knownCause = "output";
      throw error;
    }
  }
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  const artifacts = await publishDoctorArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    extracted.output === undefined ? {} : { doctorOutput: extracted.output },
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Settle a lawful Doctor Terminal from the admitted session. */
export async function settleDoctorTerminalResult(
  admitted: AdmittedDoctorInvocation,
): Promise<TerminalResult> {
  const settled = await settleLawfulDoctorTerminalResult(admitted);
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
): Promise<TerminalResult | undefined> {
  return settleLawfulDoctorTerminalResult(admitted);
}

/** Try to settle a lawful Coder Terminal; undefined only for genuine absence. */
export async function trySettleCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
  options: {
    readonly methodProvenance?: PackagedMethodSkillProvenance;
  } = {},
): Promise<TerminalResult | undefined> {
  return settleLawfulCoderTerminalResult(admitted, options);
}

export async function hasLawfulCoderTerminalResult(
  admitted: AdmittedCoderInvocation,
): Promise<boolean> {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === undefined) return false;
    const extracted = extractCoderRoleOutcome(entries);
    return extracted !== undefined && isLawfulTypedTerminalOutcome(extracted.outcome);
  } catch {
    return false;
  }
}

/** Try to settle a lawful Fixer Terminal; undefined only for genuine absence. */
export async function trySettleFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  return settleLawfulFixerTerminalResult(admitted, options);
}

export async function hasLawfulFixerTerminalResult(
  admitted: AdmittedFixerInvocation,
): Promise<boolean> {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === undefined) return false;
    const extracted = extractFixerRoleOutcome(entries);
    return extracted !== undefined && isLawfulTypedTerminalOutcome(extracted.outcome);
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
 * Evidence records package code-review provenance, adapter-derived capabilities,
 * and typed expansion observation without ambient home Skill paths.
 */
export async function publishReviewerArtifacts(
  admitted: AdmittedReviewerInvocation,
  roleOutcome: TerminalRoleOutcome,
  sessionDirectory: string,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodInvocations?: readonly ObservedPackagedMethodSkillInvocation[];
    readonly reviewerReceipt?: RuntimeReviewerReceiptV2;
  },
): Promise<TerminalArtifactRef[]> {
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
        sessionDirectory,
        sessionFile: admitted.sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
        taskPath: admitted.taskPath,
        capabilitiesPath: admitted.capabilitiesPath,
        taskSha256: admitted.taskSha256,
        ...(admitted.baseRevision === undefined
          ? {}
          : { baseRevision: admitted.baseRevision }),
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

/** Lawful Reviewer accepted outcome extracted from session (shared success interface). */
export type LawfulReviewerRoleOutcome =
  | {
      kind: "accepted";
      role: "reviewer";
      status: string;
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "audit_escalation";
      role: "reviewer";
      status: "audit_escalation";
      decisiveFacts: Readonly<Record<string, unknown>>;
    };

export function extractReviewerRoleOutcome(
  entries: readonly SessionEntry[],
): { outcome: LawfulReviewerRoleOutcome; receipt?: RuntimeReviewerReceiptV2 } | undefined {
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== REVIEWER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    const escalation = boundAuditEscalationForResult(
      entries,
      i,
      message,
      "reviewer",
      REVIEWER_OUTPUT_TOOL_NAME,
    );
    if (escalation !== undefined) {
      return {
        outcome: {
          kind: "audit_escalation",
          role: "reviewer",
          status: "audit_escalation",
          decisiveFacts: { ...escalation.details },
        },
      };
    }
    if (isUnboundAuditEscalationFace(message.details)) continue;
    try {
      const receipt = validateRuntimeReviewerReceipt(message.details);
      const outcome: LawfulReviewerRoleOutcome = {
        kind: "accepted",
        role: "reviewer",
        status: receipt.status,
        decisiveFacts: reviewerDecisiveFacts(receipt),
      };
      return { receipt, outcome };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function settleLawfulReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractReviewerRoleOutcome(entries);
  if (extracted === undefined) return undefined;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  const methodInvocations = extractReviewerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath,
    ],
  });
  const artifacts = await publishReviewerArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      ...(extracted.receipt === undefined ? {} : { reviewerReceipt: extracted.receipt }),
      methodProvenance: options.methodProvenance,
      methodInvocations,
    },
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Settle a lawful Reviewer Terminal from the admitted session (shared #106 success interface). */
export async function settleReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult> {
  const settled = await settleLawfulReviewerTerminalResult(admitted, options);
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
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  return settleLawfulReviewerTerminalResult(admitted, options);
}

export async function hasLawfulReviewerTerminalResult(
  admitted: AdmittedReviewerInvocation,
): Promise<boolean> {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === undefined) return false;
    const extracted = extractReviewerRoleOutcome(entries);
    return extracted !== undefined && isLawfulTypedTerminalOutcome(extracted.outcome);
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
  const decisiveKey = status.readable && status.value === "completed" ? "mergeCommitId" : "diagnosis";
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
  sessionDirectory: string,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodInvocations?: readonly ObservedPackagedMethodSkillInvocation[];
    readonly mergerOutput?: MergerOutput;
  },
): Promise<TerminalArtifactRef[]> {
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
        sessionDirectory,
        sessionFile: admitted.sessionFile,
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

export function extractMergerRoleOutcome(
  entries: readonly SessionEntry[],
): { outcome: LawfulMergerRoleOutcome; output: MergerOutput } | undefined {
  if (!isReceiptSettlementBindingClear(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== MERGER_OUTPUT_TOOL_NAME) continue;
    if (!isAcceptedPackagedRoleTerminalResult(message)) continue;
    try {
      const output = validateMergerOutput(message.details);
      const outcome: LawfulMergerRoleOutcome = {
        kind: "accepted",
        role: "merger",
        status: output.status,
        decisiveFacts: mergerDecisiveFacts(output),
      };
      return { output, outcome };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function settleLawfulMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  const entries = await readLawfulSettlementEntries(admitted);
  if (entries === undefined) return undefined;
  const extracted = extractMergerRoleOutcome(entries);
  if (extracted === undefined) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index]?.message;
      if (message?.role !== "toolResult") continue;
      const residual = boundErroredToolCandidate(entries, index, message, MERGER_OUTPUT_TOOL_NAME);
      if (residual === undefined) continue;
      const callMessage = entries[residual.callIndex]?.message;
      const calls = callMessage?.role === "assistant" && Array.isArray(callMessage.content)
        ? callMessage.content.filter((part) => isRecord(part) && part.type === "toolCall")
        : [];
      const attemptId = isRecord(residual.candidate)
        ? safelyRead(residual.candidate, "attemptId")
        : { readable: true as const, value: undefined };
      // Mirror the execution boundary's established precedence: ADR 0041 sole-final,
      // then ADR 0037 admitted-attempt identity, and only then output shape.
      if (
        calls.length !== 1 ||
        calls[0]?.name !== MERGER_OUTPUT_TOOL_NAME ||
        !attemptId.readable ||
        attemptId.value !== admitted.runId
      ) {
        continue;
      }
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
  const methodInvocations = extractMergerMethodInvocations(entries, {
    allowedLocations: [
      options.methodSkillPath,
      options.methodSkillConfiguredPath,
    ],
  });
  // Every invocation must expand the merge-only method before conflict work.
  if (methodInvocations.length === 0) return undefined;
  const navigator = extractNavigatorFact(
    entries,
    attendanceIdentityFromAdmitted(admitted),
  );
  const artifacts = await publishMergerArtifacts(
    admitted,
    extracted.outcome,
    admitted.sessionDirectory,
    {
      mergerOutput: extracted.output,
      methodProvenance: options.methodProvenance,
      methodInvocations,
    },
  );
  return {
    roleOutcome: extracted.outcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Settle a lawful Merger Terminal from the admitted session (shared #106 success interface). */
export async function settleMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult> {
  const settled = await settleLawfulMergerTerminalResult(admitted, options);
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
  options: {
    readonly methodProvenance: PackagedMethodSkillProvenance;
    readonly methodSkillPath: string;
    readonly methodSkillConfiguredPath: string;
  },
): Promise<TerminalResult | undefined> {
  return settleLawfulMergerTerminalResult(admitted, options);
}

export async function hasLawfulMergerTerminalResult(
  admitted: AdmittedMergerInvocation,
): Promise<boolean> {
  try {
    const entries = await readLawfulSettlementEntries(admitted);
    if (entries === undefined) return false;
    const extracted = extractMergerRoleOutcome(entries);
    return extracted !== undefined && isLawfulTypedTerminalOutcome(extracted.outcome);
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
): Promise<TerminalArtifactRef[]> {
  const { baseDir, attempt: baseAttempt } = await resolveFailureArtifactsBase(
    admitted.runDirectory,
  );
  const priorIssues: PublicationAttempt[] =
    baseAttempt === undefined ? [] : [baseAttempt];

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
    sessionDirectory: admitted.sessionDirectory,
    sessionFile: admitted.sessionFile,
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
  if (navigator.disposition === "recommendation") {
    return {
      ...navigator,
      reason: redactExactRunId(navigator.reason, runId),
    };
  }
  if (navigator.disposition === "unavailable") {
    return {
      ...navigator,
      reason: redactExactRunId(navigator.reason, runId),
    };
  }
  return navigator;
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
  options: { readonly resume?: TerminalResume } = {},
): Promise<TerminalResult> {
  // Exact-session attendance only — never infer no-advice from caller omission.
  const navigator = await extractNavigatorFactFromAdmittedSession(admitted);
  // Private durable artifacts retain the original diagnostic identity (including run ID).
  const artifacts = await publishFailureArtifacts(admitted, failure);
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
    return {
      roleOutcome,
      navigator: redactNavigatorFactForPublicTerminal(navigator, admitted.runId),
      artifacts: [],
      resume: options.resume,
    };
  }
  const roleOutcome: TerminalRoleOutcome = {
    kind: "failure",
    role: admitted.role,
    cause: failure.cause,
    diagnostic: failure.diagnostic,
    decisiveFacts,
  };
  return {
    roleOutcome,
    navigator,
    artifacts,
    runId: admitted.runId,
  };
}

/** Judge-named alias retained for #107 call sites. */
export async function settleJudgeFailureTerminalResult(
  admitted: AdmittedJudgeInvocation,
  failure: ControlledFailure,
  options: { readonly resume?: TerminalResume } = {},
): Promise<TerminalResult> {
  return settleFailureTerminalResult(admitted, failure, options);
}

/**
 * Emit one complete failure Terminal on stdout and one concise stderr diagnostic.
 * Artifacts are already durable on the TerminalResult.
 */
export function presentFailureTerminal(
  terminal: TerminalResult,
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): void {
  if (terminal.roleOutcome.kind !== "failure") {
    throw new TypeError("presentFailureTerminal requires a failure role outcome");
  }
  io.stdout(formatTerminalResult(terminal));
  io.stderr(
    formatFailureStderrDiagnostic({
      cause: terminal.roleOutcome.cause,
      diagnostic: terminal.roleOutcome.diagnostic,
    }),
  );
}

/**
 * Race a promise against the post-role Navigator grace.
 * On timeout, returns the timeout sentinel; the caller records unavailable and
 * ignores or disposes late completion.
 */
export function raceNavigatorGrace<T>(
  work: Promise<T>,
  graceMs: number = NAVIGATOR_POST_ROLE_GRACE_MS,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ status: "done"; value: T } | { status: "timeout" }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    void work.then(
      (value) => {
        if (settled) return;
        settled = true;
        resolve({ status: "done", value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
    void sleep(graceMs).then(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timeout" });
    });
  });
}
