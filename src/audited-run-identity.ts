/**
 * Shared audited-run identity for review-officer startup materials (#1166 / ADR 0087).
 * Value form is `<runId>@<席>` only — no directory path.
 */
import { basename } from "node:path";

import { formatRunLeaf, parseRunLeaf } from "./role-run-placement.ts";

export const AUDITED_RUN_IDENTITY_KIND = "audited-run-identity" as const;

export type AuditedRunIdentityMaterial = {
  readonly kind: typeof AUDITED_RUN_IDENTITY_KIND;
  readonly identity: string;
};

/** Identity leaf from a run directory basename; undefined when the leaf is not `runId@role`. */
export function auditedRunIdentityFromDirectory(runDirectory: string): string | undefined {
  const parsed = parseRunLeaf(basename(runDirectory));
  if (parsed === undefined) return undefined;
  return formatRunLeaf(parsed.runId, parsed.role);
}

export function auditedRunIdentityMaterial(identity: string): AuditedRunIdentityMaterial {
  return { kind: AUDITED_RUN_IDENTITY_KIND, identity };
}

/** Identity from locator fields already in hand (notary source-run). */
export function auditedRunIdentityFromParts(runId: string, role: string): string {
  return formatRunLeaf(runId, role);
}
