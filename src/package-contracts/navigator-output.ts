/**
 * Public Navigator (游奕使) terminating receipt contracts (#639 / #959 / #1160).
 * Advice body is free-form prose. Status association for parallel prepare lives on
 * `byStatus` — code picks by the settlement status field only (owner 3188b502).
 * Code does not parse, rank, or judge advice semantics.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { isRecord } from "../unknown-value.ts";
import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export const NAVIGATOR_OUTPUT_TOOL_NAME = "ak_navigator_output";

export const navigatorOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      prose: Type.Optional(Type.Unknown({
        description: "单条散文建议。无状态分叉时使用；原样呈现。",
      })),
      byStatus: Type.Optional(Type.Unknown({
        description:
          "按主衙门结局 status 预写的散文建议。键为 status 字面量，值为建议正文。"
          + "结算时代码只按实际 status 取对应原文，不解析建议语义。",
      })),
    }),
  ),
);

export type NavigatorAdvice = { readonly prose: string };

/** Parallel-prepare payload: status-keyed prose plus optional single prose. */
export type PreparedNavigatorAdvice = {
  readonly byStatus: Readonly<Record<string, string>>;
  readonly prose?: string;
};

function nonEmptyProse(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.trim() === "" ? undefined : text;
}

function byStatusFromUnknown(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const prose = nonEmptyProse(raw);
    if (prose !== undefined) out[key] = prose;
  }
  return out;
}

/**
 * Project one Navigator advice receipt as prose (display / single-advice path).
 * Accepts { prose }, a bare string, or any object — objects stringify as the
 * prose body so historical / free-form submissions still present. Shape is not
 * an admission gate (ADR 0055 / 仓内 CLAUDE.md 开篇 / #959).
 */
export function projectLawfulNavigatorOutput(value: unknown): NavigatorAdvice | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { prose: value };
  if (isRecord(value)) {
    if (typeof value.prose === "string") return { prose: value.prose };
    if (value.prose !== undefined && value.prose !== null) {
      return { prose: typeof value.prose === "string" ? value.prose : String(value.prose) };
    }
    // Free-form object submission: present the whole body as prose when it has content.
    const keys = Object.keys(value);
    if (keys.length === 0) return { prose: "" };
    try {
      return { prose: JSON.stringify(value) };
    } catch {
      return { prose: String(value) };
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

/**
 * Extract parallel-prepare advice. Empty / missing → undefined.
 * Never a rejection — shape is not an admission gate.
 */
export function preparedAdviceFromUnknown(value: unknown): PreparedNavigatorAdvice | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const prose = nonEmptyProse(value);
    return prose === undefined ? undefined : { byStatus: {}, prose };
  }
  if (!isRecord(value)) {
    const prose = nonEmptyProse(value);
    return prose === undefined ? undefined : { byStatus: {}, prose };
  }
  const byStatus = byStatusFromUnknown(value.byStatus);
  const hasProseField = Object.prototype.hasOwnProperty.call(value, "prose");
  const hasByStatusField = Object.prototype.hasOwnProperty.call(value, "byStatus");
  const prose = nonEmptyProse(value.prose);
  if (Object.keys(byStatus).length === 0 && prose === undefined) {
    // Explicit empty prose / byStatus → no advice (do not re-stringify the shell).
    if (hasProseField || hasByStatusField) return undefined;
    // Free-form object without byStatus/prose: single-advice compat via stringify.
    const keys = Object.keys(value);
    if (keys.length === 0) return undefined;
    try {
      const text = JSON.stringify(value);
      return text.trim() === "" || text === "{}" ? undefined : { byStatus: {}, prose: text };
    } catch {
      const text = String(value);
      return text.trim() === "" ? undefined : { byStatus: {}, prose: text };
    }
  }
  return {
    byStatus,
    ...(prose === undefined ? {} : { prose }),
  };
}

/** First-defined status keys win; prose concatenates when both present. */
export function mergePreparedAdvice(
  prior: PreparedNavigatorAdvice | undefined,
  next: PreparedNavigatorAdvice | undefined,
): PreparedNavigatorAdvice | undefined {
  if (prior === undefined) return next;
  if (next === undefined) return prior;
  const byStatus = { ...next.byStatus, ...prior.byStatus };
  const proseParts = [prior.prose, next.prose]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "");
  const prose = proseParts.length === 0 ? undefined : proseParts.join("\n\n");
  if (Object.keys(byStatus).length === 0 && prose === undefined) return undefined;
  return {
    byStatus,
    ...(prose === undefined ? {} : { prose }),
  };
}

/**
 * Pick prepared prose for a settlement status (#1160 / owner 3188b502).
 * - byStatus present → only the matching status key (no prose fallback).
 * - byStatus empty → single prose used as the only advice.
 * Missing match → undefined (honest no-advice).
 */
export function pickPreparedProse(
  prepared: PreparedNavigatorAdvice | undefined,
  status: string | undefined,
): string | undefined {
  if (prepared === undefined) return undefined;
  if (Object.keys(prepared.byStatus).length > 0) {
    if (status === undefined) return undefined;
    const hit = prepared.byStatus[status];
    return typeof hit === "string" && hit.trim() !== "" ? hit : undefined;
  }
  const prose = prepared.prose;
  return typeof prose === "string" && prose.trim() !== "" ? prose : undefined;
}
