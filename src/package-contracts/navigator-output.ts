/**
 * Public Navigator (游奕使) terminating receipt contracts (#639).
 * Direct public seat submits route advice with the same candidate shape the
 * attendance prepare tool owns — one shape authority for navigator advice.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./terminating-infrastructure.ts";

export const NAVIGATOR_OUTPUT_TOOL_NAME = "ak_navigator_output";
export const NAVIGATOR_ACCEPTED_TEXT = "游奕使建议已受理";

export const navigatorOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "advice — 形状指引，非 schema 闸",
      }),
      candidates: Type.Unknown({
        description: "排好序的路线建议数组，元素含 next/phase/reason — 形状指引，非 schema 闸",
      }),
    }),
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type NavigatorAdvice = { readonly status: "advice"; readonly candidates: readonly unknown[] };

/**
 * Project one lawful explicit Navigator advice receipt: candidates array,
 * each candidate a record. Broken ancillary fields are preserved as submitted —
 * shape is not an admission gate (ADR 0055 / 第 0 条).
 */
export function projectLawfulNavigatorOutput(value: unknown): NavigatorAdvice | undefined {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return undefined;
  if (value.status !== "advice") return undefined;
  return { status: "advice", candidates: value.candidates.filter(isRecord) };
}

/**
 * Settlement/recording path: only lawful recorded candidate arrays.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedNavigatorOutput(value: unknown): NavigatorAdvice {
  const projected = projectLawfulNavigatorOutput(value);
  if (projected === undefined) {
    throw new Error("Navigator output has no recognized execution discriminator");
  }
  return projected;
}

export function navigatorDecisiveFacts(output: { readonly candidates: readonly unknown[] }): Record<string, unknown> {
  return { status: "advice", candidates: output.candidates };
}
