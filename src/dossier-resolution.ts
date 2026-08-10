/**
 * Unique dossier-resolution seam for 审刑院 (#233).
 * Machine pointers only: cwd + AK_ROLE_RUN_DIR. No latest-run / mtime / global scan.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { JUDGE_OUTPUT_TOOL_NAME as JUDGE_OUTPUT_TOOL } from "./package-contracts/judge-output.ts";

export const JUDGE_OUTPUT_TOOL_NAME = JUDGE_OUTPUT_TOOL;
export const AUDIT_RUN_DIR_ENV = "AK_ROLE_RUN_DIR" as const;
export const REVIEWER_CANDIDATE_ENTRY_TYPE = "ak_reviewer_audit_candidate" as const;
export const DOCTOR_CANDIDATE_ENTRY_TYPE = "ak_doctor_audit_candidate" as const;

export type MissingDossierObservation = { readonly kind: "missing-dossier" };
export type MissingSubjectObservation = {
  readonly kind: "missing-subject";
  readonly subject: "assignment" | "candidate-verdict" | "candidate-receipt" | "candidate-testimony" | string;
};
export type DossierObservation = MissingDossierObservation | MissingSubjectObservation;

export type DossierOk = { readonly status: "ok"; readonly runDirectory: string };
export type DossierIncomplete = {
  readonly status: "incomplete";
  readonly observation: DossierObservation;
};
export type DossierResolution = DossierOk | DossierIncomplete;

export type SubjectOk = { readonly status: "ok" };
export type SubjectIncomplete = {
  readonly status: "incomplete";
  readonly observation: MissingSubjectObservation;
};
export type SubjectResolution = SubjectOk | SubjectIncomplete;

/**
 * Resolve the per-run dossier pointer injected by the public CLI.
 * Concurrent runs in one worktree stay isolated because the pointer is per-process.
 */
export function resolveAuditDossier(env: NodeJS.ProcessEnv = process.env): DossierResolution {
  const raw = env[AUDIT_RUN_DIR_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { status: "incomplete", observation: { kind: "missing-dossier" } };
  }
  const runDirectory = resolve(raw);
  try {
    if (!existsSync(runDirectory) || !statSync(runDirectory).isDirectory()) {
      return { status: "incomplete", observation: { kind: "missing-dossier" } };
    }
  } catch {
    return { status: "incomplete", observation: { kind: "missing-dossier" } };
  }
  return { status: "ok", runDirectory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Judge subjects must already be on the parent session books before audit starts:
 * assignment (user message) + candidate verdict (sole judge output tool call).
 */
export function readJudgeAuditSubjects(context: ExtensionContext): SubjectResolution {
  const entries = context.sessionManager.getEntries?.() ?? [];
  let hasAssignment = false;
  let hasCandidate = false;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
          : "";
      if (text.trim().length > 0) hasAssignment = true;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "toolCall" && part.name === JUDGE_OUTPUT_TOOL_NAME && isRecord(part.arguments)) {
          hasCandidate = true;
        }
      }
    }
  }
  if (!hasAssignment) {
    return { status: "incomplete", observation: { kind: "missing-subject", subject: "assignment" } };
  }
  if (!hasCandidate) {
    return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-verdict" } };
  }
  return { status: "ok" };
}

/**
 * Reviewer candidate receipt must be recorded before audit (first-record-then-audit).
 */
export function readReviewerAuditSubjects(context: ExtensionContext): SubjectResolution {
  const entries = context.sessionManager.getEntries?.() ?? [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === REVIEWER_CANDIDATE_ENTRY_TYPE) {
      return { status: "ok" };
    }
  }
  return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-receipt" } };
}

/**
 * Doctor candidate testimony must be recorded before audit.
 */
export function readDoctorAuditSubjects(context: ExtensionContext): SubjectResolution {
  const entries = context.sessionManager.getEntries?.() ?? [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === DOCTOR_CANDIDATE_ENTRY_TYPE) {
      return { status: "ok" };
    }
  }
  return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-testimony" } };
}

export function toAuditIncomplete<TObservation extends DossierObservation>(
  observation: TObservation,
): { status: "audit-incomplete"; observation: TObservation; candidate: undefined } {
  return { status: "audit-incomplete", observation, candidate: undefined };
}
