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
  // #836: no field drop
  return (typeof value === "object" && value !== null && !Array.isArray(value))
    ? (value as NavigatorAdvice)
    : undefined;
}

/**
 * Settlement/recording path: only lawful recorded candidate arrays.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedNavigatorOutput(value: unknown): NavigatorAdvice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Navigator output is not an object");
  }
  return value as NavigatorAdvice;
}

