/**
 * Public Evidence-Child terminating receipt contracts (#675).
 * One report body; shape is not an admission gate (ADR 0055).
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./terminating-infrastructure.ts";

export const EVIDENCE_CHILD_OUTPUT_TOOL_NAME = "ak_evidence_child_output" as const;
export const EVIDENCE_CHILD_ACCEPTED_TEXT = "取证回执已接受";

export const evidenceChildOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      report: Type.Unknown({
        description: "取证报告正文 — 形状指引，非 schema 闸",
      }),
    }),
  ),
);

/** Report body retained as delivered — no type/blank reshape (ADR 0055 / §0). */
export type EvidenceChildOutput = { readonly report: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectLawfulEvidenceChildOutput(
  value: unknown,
): EvidenceChildOutput | undefined {
  // Presence of report field is the only discriminator. No String() conversion,
  // no blank trim gate — original candidate bytes stay (ADR 0055 / CLAUDE.md §0).
  if (!isRecord(value) || !Object.hasOwn(value, "report")) return undefined;
  return { report: value.report };
}

export function validateRecordedEvidenceChildOutput(value: unknown): EvidenceChildOutput {
  const projected = projectLawfulEvidenceChildOutput(value);
  if (projected === undefined) {
    throw new Error("Evidence-child output has no report field");
  }
  return projected;
}

export function evidenceChildDecisiveFacts(
  output: EvidenceChildOutput,
): Record<string, unknown> {
  return { report: output.report };
}
