/**
 * Shared settlement for public Role runs: role outcome + Navigator fact + artifacts
 * into one Terminal result (ADR 0052 / #106 / #101).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isAuditEscalationResult } from "../audit-escalation.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../package-contracts/judge-output.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";
import {
  ensureRunArtifactsDir,
  type AdmittedJudgeInvocation,
} from "./invocation.ts";
import {
  formatTerminalResult,
  recommendationNavigatorFact,
  type TerminalArtifactRef,
  type TerminalNavigatorFact,
  type TerminalResult,
  type TerminalRoleOutcome,
} from "./terminal.ts";

export { formatTerminalResult };

/** Post-role Navigator delivery grace (Issue #11 / #101 / #106). */
export const NAVIGATOR_POST_ROLE_GRACE_MS = 3_000;

type SessionMessage = {
  role?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  content?: unknown;
  customType?: string;
};

type SessionEntry = {
  type?: string;
  customType?: string;
  message?: SessionMessage;
  timestamp?: string;
};

async function readLatestSessionEntries(
  sessionDirectory: string,
): Promise<SessionEntry[]> {
  const files = (await readdir(sessionDirectory))
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) return [];
  const text = await readFile(join(sessionDirectory, files.at(-1)!), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEntry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function judgeDecisiveFacts(details: Record<string, unknown>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (typeof details.judgeStatus === "string") facts.judgeStatus = details.judgeStatus;
  if (isRecord(details.fix) && typeof details.fix.summary === "string") {
    facts.fixSummary = details.fix.summary;
  }
  if (Array.isArray(details.classes)) {
    facts.classCount = details.classes.length;
    const names = details.classes
      .map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : undefined))
      .filter((name): name is string => name !== undefined);
    if (names.length > 0) facts.classNames = names.join(",");
  }
  if (isRecord(details.decisionGate)) {
    if (typeof details.decisionGate.question === "string") {
      facts.decisionQuestion = details.decisionGate.question;
    }
  }
  if (typeof details.note === "string") facts.note = details.note;
  return facts;
}

export function extractJudgeRoleOutcome(
  entries: readonly SessionEntry[],
): TerminalRoleOutcome | undefined {
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
        decisiveFacts: isRecord(details) ? { ...details } : {},
      };
    }
    if (!isRecord(details)) continue;
    const status =
      typeof details.judgeStatus === "string" ? details.judgeStatus : "accepted";
    return {
      kind: "accepted",
      role: "judge",
      status,
      decisiveFacts: judgeDecisiveFacts(details),
    };
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

export async function settleJudgeTerminalResult(
  admitted: AdmittedJudgeInvocation,
): Promise<TerminalResult> {
  const entries = await readLatestSessionEntries(admitted.sessionDirectory);
  const roleOutcome = extractJudgeRoleOutcome(entries);
  if (roleOutcome === undefined) {
    throw new Error(
      "Judge Role run completed without a lawful typed terminal result",
    );
  }
  const navigator = extractNavigatorFact(entries);
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
