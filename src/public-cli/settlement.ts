/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #107 / #101).
 * Controlled failures and audit human decisions settle here without washing causes.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isAuditEscalationResult } from "../audit-escalation.ts";
import { loadCollectorManifest } from "../collector-config.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "../collector-ledger.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "../package-contracts/judge-output.ts";
import {
  COLLECTOR_OUTPUT_TOOL,
  validateAcceptedCollectorReceipt,
  type CollectorReceipt,
} from "../package-contracts/collector-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  validateAcceptedCoderDetails,
  type CoderOutput,
} from "../package-contracts/worker-output.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
  validateRecordedDoctorOutput,
  type DoctorOutput,
} from "../doctor-contracts.ts";
import type { PackagedMethodSkillProvenance } from "../package-resources/method-skill.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";
import {
  ensureRunArtifactsDir,
  type AdmittedCoderInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedDoctorInvocation,
  type AdmittedJudgeInvocation,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  recommendationNavigatorFact,
  redactExactRunId,
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
  timestamp?: string;
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

function judgeDecisiveFacts(verdict: JudgeVerdict): Record<string, unknown> {
  const facts: Record<string, unknown> = {
    judgeStatus: verdict.judgeStatus,
  };
  if (verdict.judgeStatus === "continue") {
    facts.fixSummary = verdict.fix.summary;
    facts.classCount = verdict.classes.length;
    facts.classNames = verdict.classes.map((entry) => entry.name).join(",");
  }
  if (verdict.judgeStatus === "escalate") {
    facts.decisionQuestion = verdict.decisionGate.question;
  }
  if (verdict.note !== undefined) facts.note = verdict.note;
  return facts;
}

function coderDecisiveFacts(output: CoderOutput): Record<string, unknown> {
  const facts: Record<string, unknown> = {
    coderStatus: output.status,
  };
  if (output.status === "unfinished") {
    facts.remainingScope = output.remainingScope;
  }
  // Report is the durable Artifact body — keep only a short presence marker inline.
  facts.reportPresent = output.report.trim().length > 0;
  return facts;
}

function collectorDecisiveFacts(
  receipt: CollectorReceipt,
): Record<string, unknown> {
  return {
    repository: receipt.repository,
    prNumber: receipt.prNumber,
    targetHead: receipt.targetHead,
    manifestDigest: receipt.manifestDigest,
    legStatuses: receipt.legs
      .map((leg) => `${leg.legId}:${leg.status}`)
      .join(","),
  };
}

function doctorDecisiveFacts(output: DoctorOutput): Record<string, unknown> {
  if (output.status === "refused") {
    return {
      doctorStatus: output.status,
      reason: output.reason,
      missingEvidenceCount: output.missingEvidence.length,
    };
  }
  return {
    doctorStatus: output.status,
    issueNumber: output.case.issueNumber,
    runsPath: output.case.runsPath,
    findingsCount: output.findings.length,
  };
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

/** Lawful Judge outcomes extracted from session (never a fabricated failure Receipt). */
export type LawfulJudgeRoleOutcome = Extract<
  TerminalRoleOutcome,
  { kind: "accepted" } | { kind: "audit_escalation" }
>;

export function extractJudgeRoleOutcome(
  entries: readonly SessionEntry[],
): LawfulJudgeRoleOutcome | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== JUDGE_OUTPUT_TOOL_NAME) continue;
    if (message.isError === true) continue;
    const details = message.details;
    if (isAuditEscalationResult(details)) {
      return {
        kind: "audit_escalation",
        role: "judge",
        status: "audit_escalation",
        decisiveFacts: { ...details },
      };
    }
    // Ordinary details must pass the package Judge verdict validator (ADR 0043 / #107 AC4).
    try {
      const verdict = validateAcceptedJudgeDetails(details);
      return {
        kind: "accepted",
        role: "judge",
        status: verdict.judgeStatus,
        decisiveFacts: judgeDecisiveFacts(verdict),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function navigatorPhaseValue(value: unknown): NavigatorPhase {
  if (value === "plan" || value === "apply") return value;
  return null;
}

export function extractNavigatorFact(
  entries: readonly SessionEntry[],
): TerminalNavigatorFact {
  // Prefer the visible attendance custom_message; fall back to decorated silence.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom_message" && entry.customType === "ak-navigator-attendance") {
      const details = entry.message?.details ?? (entry as { details?: unknown }).details;
      if (!isRecord(details)) continue;
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
      if (disposition === "silence" || disposition === "arrival") {
        return { disposition: "no-advice" };
      }
    }
  }
  // No attendance event → intentional silence / no-advice (not unavailable).
  return { disposition: "no-advice" };
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
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== CODER_OUTPUT_TOOL_NAME) continue;
    if (message.isError === true) continue;
    try {
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
  const navigator = extractNavigatorFact(entries);
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
  const navigator = extractNavigatorFact(entries);
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
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== COLLECTOR_OUTPUT_TOOL) continue;
    if (message.isError === true) continue;
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
  if (extracted === undefined) return undefined;
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
  const navigator = extractNavigatorFact(entries);
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
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== DOCTOR_OUTPUT_TOOL_NAME) continue;
    if (message.isError === true) continue;
    const details = message.details;
    if (isAuditEscalationResult(details)) {
      return {
        outcome: {
          kind: "audit_escalation",
          role: "doctor",
          status: "audit_escalation",
          decisiveFacts: { ...details },
        },
      };
    }
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
  const navigator = extractNavigatorFact(entries);
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
/** Redact exact run ID from string-valued decisive facts at the public Terminal boundary. */
function redactDecisiveFactsForPublicTerminal(
  facts: Readonly<Record<string, unknown>>,
  runId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    out[key] = typeof value === "string" ? redactExactRunId(value, runId) : value;
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
  navigator: TerminalNavigatorFact = { disposition: "no-advice" },
  options: { readonly resume?: TerminalResume } = {},
): Promise<TerminalResult> {
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
  navigator: TerminalNavigatorFact = { disposition: "no-advice" },
  options: { readonly resume?: TerminalResume } = {},
): Promise<TerminalResult> {
  return settleFailureTerminalResult(admitted, failure, navigator, options);
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
