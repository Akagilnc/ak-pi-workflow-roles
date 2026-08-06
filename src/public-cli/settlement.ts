/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #107 / #101).
 * Controlled failures and audit human decisions settle here without washing causes.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isAuditEscalationResult } from "../audit-escalation.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "../package-contracts/judge-output.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";
import {
  ensureRunArtifactsDir,
  type AdmittedJudgeInvocation,
} from "./invocation.ts";
import {
  exitCodeForTerminalOutcome,
  formatTerminalResult,
  isLawfulTypedTerminalOutcome,
  recommendationNavigatorFact,
  type ControlledFailureCause,
  type TerminalArtifactRef,
  type TerminalNavigatorFact,
  type TerminalResult,
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
  sessionDirectory: string,
): Promise<SessionReadiness> {
  try {
    const files = (await readdir(sessionDirectory))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    if (files.length === 0) return { state: "missing" };
    await readFile(join(sessionDirectory, files.at(-1)!), "utf8");
    return { state: "present" };
  } catch (error) {
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
 * Order: thrown → timeout → knownCause → activation (nonzero) → session → output.
 * Cause is never inferred from stderr wording.
 */
export function classifyPostAdmissionFailure(input: {
  timedOut: boolean;
  code: number | null;
  stderr: string;
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
  if (input.thrown !== undefined) {
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
  if (input.timedOut) {
    return {
      cause: "timeout",
      diagnostic: "judge role run timed out",
      details: { timedOut: true, code: input.code },
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
      details: { code: input.code },
      ...(input.knownIdentity === undefined
        ? {}
        : { identity: input.knownIdentity }),
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

/** Post-role Navigator delivery grace (Issue #11 / #101 / #106). */
export const NAVIGATOR_POST_ROLE_GRACE_MS = 3_000;

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

async function readLatestSessionEntries(
  sessionDirectory: string,
): Promise<SessionEntry[]> {
  const files = (await readdir(sessionDirectory))
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) return [];
  const text = await readFile(join(sessionDirectory, files.at(-1)!), "utf8");
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
 * Last native assistant provider-stop in a session (stopReason === "error").
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
    if (message.stopReason !== "error") continue;
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

/** Read latest session entries and extract a typed provider-stop, if any. */
export async function readSessionProviderStop(
  sessionDirectory: string,
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
    const entries = await readLatestSessionEntries(sessionDirectory);
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
 * Single lawful-settlement implementation (session → outcome/Navigator/artifacts).
 *
 * - Returns undefined only for genuine absence (missing session path, or no
 *   lawful verdict in an otherwise readable session).
 * - Malformed JSONL / other session-read failures throw with knownCause=session
 *   and original identity (SyntaxError name retained).
 * - Artifact publication failures propagate with their original typed identity.
 */
async function settleLawfulJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
): Promise<TerminalResult | undefined> {
  let entries: SessionEntry[];
  try {
    entries = await readLatestSessionEntries(admitted.sessionDirectory);
  } catch (error) {
    // Missing path is absence of a lawful outcome; callers classify via session inspect.
    if (isMissingPathError(error)) return undefined;
    // Malformed JSONL and other read failures keep typed session identity.
    throw error instanceof Error &&
      (error as { knownCause?: unknown }).knownCause === "session"
      ? error
      : sessionReadFailure(error, "session unreadable");
  }
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
  admitted: AdmittedJudgeInvocation,
  failure: ControlledFailure,
): Promise<TerminalArtifactRef[]> {
  const { baseDir, attempt: baseAttempt } = await resolveFailureArtifactsBase(
    admitted.runDirectory,
  );
  const priorIssues: PublicationAttempt[] =
    baseAttempt === undefined ? [] : [baseAttempt];

  // Prefer conventional names; unique fallback dirs keep colliding fixed paths
  // from stranding the original failure outside settlement.
  const underArtifacts = baseDir === join(admitted.runDirectory, "artifacts");
  const uniqueFallbackDirs = underArtifacts
    ? [baseDir, admitted.runDirectory]
    : [baseDir];
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
    role: "judge",
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
export async function settleJudgeFailureTerminalResult(
  admitted: AdmittedJudgeInvocation,
  failure: ControlledFailure,
  navigator: TerminalNavigatorFact = { disposition: "no-advice" },
): Promise<TerminalResult> {
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
  const roleOutcome: TerminalRoleOutcome = {
    kind: "failure",
    role: "judge",
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
