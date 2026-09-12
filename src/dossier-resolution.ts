/**
 * Unique dossier-resolution seam for 审刑院 (#233).
 * Machine pointers only: cwd + per-turn HostContext (Pi child env fallback).
 * No latest-run / mtime / global scan.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { runDirectoryFromHostContext, type HostContext } from "./host-contracts.ts";

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

function isHostContext(value: object): value is HostContext {
  return "sessionManager" in value;
}

function dossierPointerFrom(source?: HostContext | NodeJS.ProcessEnv): string | undefined {
  if (source !== undefined && isHostContext(source)) {
    return runDirectoryFromHostContext(source);
  }
  const env = source ?? process.env;
  const raw = env[AUDIT_RUN_DIR_ENV];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/**
 * Resolve the per-run dossier pointer.
 *
 * ACP/headless: typed HostContext.runDirectory.
 * Pi child: HostContext projected from env, or env fallback when no context.
 * Absent pointer = bare Pi internal seam (ADR 0052): audit proceeds; the model
 * self-locates the dossier from its own fall-volume position per soul.
 */
export function resolveAuditDossier(
  source?: HostContext | NodeJS.ProcessEnv,
): DossierResolution {
  const raw = dossierPointerFrom(source);
  // Bare Pi activation seam: no machine gate when the pointer was never injected.
  if (raw === undefined) {
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

type AuditSubjectContext = { sessionManager: { getEntries?(): Iterable<unknown> } };

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
