/**
 * Public Navigator (游奕使) terminating receipt contracts (#639 / #959).
 * Navigator speaks free-form prose. The tool is only a lifecycle vehicle so the
 * host can seal a turn; the model-facing content is prose, not structured route
 * candidates. Code does not parse, rank, or judge the advice.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export const NAVIGATOR_OUTPUT_TOOL_NAME = "ak_navigator_output";

export const navigatorOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      prose: Type.Unknown({
        description: "游奕使散文建议，原样呈现。不要求 candidates/next 等结构化字段。形状指引，非 schema 闸",
      }),
    }),
  ),
);

export type NavigatorAdvice = { readonly prose: string };

/**
 * Project one Navigator advice receipt as prose.
 * Accepts { prose }, a bare string, or any object — objects stringify as the
 * prose body so historical / free-form submissions still present. Shape is not
 * an admission gate (ADR 0055 / 第 0 条 / #959).
 */
export function projectLawfulNavigatorOutput(value: unknown): NavigatorAdvice | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { prose: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.prose === "string") return { prose: record.prose };
    if (record.prose !== undefined && record.prose !== null) {
      return { prose: typeof record.prose === "string" ? record.prose : String(record.prose) };
    }
    // Free-form object submission: present the whole body as prose when it has content.
    const keys = Object.keys(record);
    if (keys.length === 0) return { prose: "" };
    try {
      return { prose: JSON.stringify(record) };
    } catch {
      return { prose: String(record) };
    }
  }
  return { prose: String(value) };
}

/**
 * Settlement/recording path: project prose. Does not gate role admission.
 */
export function validateRecordedNavigatorOutput(value: unknown): NavigatorAdvice {
  const projected = projectLawfulNavigatorOutput(value);
  if (projected === undefined) {
    throw new Error("Navigator output is empty");
  }
  return projected;
}

/** Extract display prose from any navigator payload / attendance body. */
export function navigatorProseFromUnknown(value: unknown): string | undefined {
  const projected = projectLawfulNavigatorOutput(value);
  if (projected === undefined) return undefined;
  const trimmed = projected.prose.trim();
  return trimmed === "" ? undefined : projected.prose;
}
