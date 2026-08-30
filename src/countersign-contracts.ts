/**
 * Public Countersign (给事中) terminating receipt contracts.
 * Lawful verdicts: converged (署) | continue (封驳) | escalate (上呈).
 * (#572 / ADR 0074)
 */
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export const COUNTERSIGN_OUTPUT_TOOL_NAME = "ak_countersign_output";
export const COUNTERSIGN_ACCEPTED_TEXT = "给事中回执已接受";

export const countersignOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      countersignStatus: Type.Unknown({
        description: "converged（署）| continue（封驳）| escalate（上呈）— 形状指引，非 schema 闸",
      }),
      note: Type.Unknown({
        description: "裁决理由叙事，随态留存",
      }),
      findings: Type.Unknown({
        description: "string[] 逐条理由与证据指针",
      }),
    }),
  ),
);

export type CountersignOutput =
  | { readonly countersignStatus: "converged"; readonly findings: readonly string[] }
  | {
    readonly countersignStatus: "continue";
    readonly disposition: "rewrite";
    readonly findings: readonly string[];
  }
  | { readonly countersignStatus: "escalate"; readonly findings: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Project one lawful explicit Countersign verdict (署 | 封驳 | 上呈).
 * No throw on shape — ADR 0055 / 第 0 条: already-submitted params are retained
 * as-is; public-terminal projects non-usable verdicts via typed failure cause.
 */
export function projectLawfulCountersignOutput(value: unknown): CountersignOutput | undefined {
  if (!isRecord(value)) return undefined;
  const status =
    typeof value.countersignStatus === "string" ? value.countersignStatus : undefined;
  if (status === "continue") {
    const clone = structuredClone(value) as Record<string, unknown>;
    if (clone.disposition === undefined) clone.disposition = "rewrite";
    if (!Array.isArray(clone.findings)) clone.findings = asStringArray(clone.findings);
    return clone as CountersignOutput;
  }
  if (status === "converged" || status === "escalate") {
    const clone = structuredClone(value) as Record<string, unknown>;
    if (!Array.isArray(clone.findings)) clone.findings = asStringArray(clone.findings);
    return clone as CountersignOutput;
  }
  return undefined;
}

/** Retain submitted Countersign params as-is for the failure channel (no shape rewrite). */
export function retainCountersignSubmission(value: unknown): unknown {
  if (value === undefined) return { missing: "arguments" as const };
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Settlement/recording path: only lawful recorded verdicts.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedCountersignOutput(value: unknown): CountersignOutput {
  const projected = projectLawfulCountersignOutput(value);
  if (projected === undefined) {
    throw new Error("Countersign output has no recognized execution discriminator");
  }
  return projected;
}

export function countersignDecisiveFacts(output: CountersignOutput): Record<string, unknown> {
  const facts: Record<string, unknown> = { countersignStatus: output.countersignStatus };
  facts.findingsCount = Array.isArray(output.findings) ? output.findings.length : 0;
  if (output.countersignStatus === "continue") {
    facts.disposition = "rewrite";
  }
  return facts;
}
