/**
 * Unique dossier-resolution seam for 审刑院 (#233).
 * Machine pointers only: cwd + AK_ROLE_RUN_DIR. No latest-run / mtime / global scan.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { JUDGE_OUTPUT_TOOL_NAME as JUDGE_OUTPUT_TOOL } from "./package-contracts/judge-output.ts";

export const JUDGE_OUTPUT_TOOL_NAME = JUDGE_OUTPUT_TOOL;
export const AUDIT_RUN_DIR_ENV = "AK_ROLE_RUN_DIR" as const;
export const DOCTOR_CANDIDATE_ENTRY_TYPE = "ak_doctor_audit_candidate" as const;

export type MissingDossierObservation = { readonly kind: "missing-dossier" };
export type MissingSubjectObservation = {
  readonly kind: "missing-subject";
  readonly subject: "assignment" | "candidate-verdict" | "candidate-receipt" | "candidate-testimony" | string;
};
export type DossierObservation = MissingDossierObservation | MissingSubjectObservation;

export type DossierOk = {
  readonly status: "ok";
  /** Present only when public CLI injected a validated AK_ROLE_RUN_DIR. */
  readonly runDirectory?: string;
};
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
 *
 * Absent pointer = bare Pi internal seam (ADR 0052): audit proceeds; the model
 * self-locates the dossier from its own fall-volume position per soul. Public CLI
 * always injects the pointer — only then does the machine validate the path.
 * Concurrent runs stay isolated because a present pointer is per-process.
 */
export function resolveAuditDossier(env: NodeJS.ProcessEnv = process.env): DossierResolution {
  const raw = env[AUDIT_RUN_DIR_ENV];
  // Bare Pi activation seam: no machine gate when the pointer was never injected.
  if (typeof raw !== "string" || raw.trim() === "") {
    return { status: "ok" };
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
type AuditSubjectContext = { sessionManager: { getEntries?(): Iterable<unknown> } };

export function readJudgeAuditSubjects(context: AuditSubjectContext): SubjectResolution {
  const entries = context.sessionManager.getEntries?.() ?? [];
  let hasAssignment = false;
  let hasCandidate = false;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")).join("")
          : "";
      if (text.trim().length > 0) hasAssignment = true;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && part.type === "toolCall" && part.name === JUDGE_OUTPUT_TOOL_NAME && isRecord(part.arguments)) {
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
 * Doctor candidate testimony must be recorded before audit.
 */
export function readDoctorAuditSubjects(context: AuditSubjectContext): SubjectResolution {
  const entries = context.sessionManager.getEntries?.() ?? [];
  for (const entry of entries) {
    if (isRecord(entry) && entry.type === "custom" && entry.customType === DOCTOR_CANDIDATE_ENTRY_TYPE) {
      return { status: "ok" };
    }
  }
  return { status: "incomplete", observation: { kind: "missing-subject", subject: "candidate-testimony" } };
}

/**
 * Missing dossier/subject is infrastructure failure, not a judgment status (#475).
 * Observation + empty candidate ride the existing failInfrastructure → error artifact path.
 */
export class AuditMaterialsUnavailableError extends Error {
  readonly observation: DossierObservation;
  readonly candidate: undefined;
  constructor(observation: DossierObservation) {
    const detail =
      observation.kind === "missing-subject"
        ? `${observation.kind}:${observation.subject}`
        : observation.kind;
    super(`Audit materials unavailable: ${detail}`);
    this.name = "AuditMaterialsUnavailableError";
    this.observation = observation;
    this.candidate = undefined;
  }
}

export function requireAuditMaterials(
  resolution: DossierResolution | SubjectResolution,
): asserts resolution is DossierOk | SubjectOk {
  if (resolution.status === "incomplete") {
    throw new AuditMaterialsUnavailableError(resolution.observation);
  }
}
