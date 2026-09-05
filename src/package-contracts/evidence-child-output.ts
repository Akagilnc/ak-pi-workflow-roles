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

export type EvidenceChildOutput = { readonly report: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectLawfulEvidenceChildOutput(
  value: unknown,
): EvidenceChildOutput | undefined {
  if (!isRecord(value) || typeof value.report !== "string") return undefined;
  if (value.report.trim() === "") return undefined;
  return { report: value.report };
}

export function validateRecordedEvidenceChildOutput(value: unknown): EvidenceChildOutput {
  const projected = projectLawfulEvidenceChildOutput(value);
  if (projected === undefined) {
    throw new Error("Evidence-child output has no recognized report body");
  }
  return projected;
}

export function evidenceChildDecisiveFacts(
  output: EvidenceChildOutput,
): Record<string, unknown> {
  return { report: output.report };
}
