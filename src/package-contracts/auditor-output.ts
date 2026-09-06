/**
 * Public Auditor (审刑院) terminating receipt contracts (#675).
 * Lawful explicit releases: pass | revise | escalate.
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./terminating-infrastructure.ts";

export const AUDITOR_OUTPUT_TOOL_NAME = "ak_auditor_output" as const;
export const AUDITOR_ACCEPTED_TEXT = "审刑院回执已接受";

export const auditorOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "pass | revise | escalate — 形状指引，非 schema 闸",
      }),
      violations: Type.Optional(Type.Unknown({
        description: "status 为 revise 时的违规条目",
      })),
      conflicts: Type.Optional(Type.Unknown({
        description: "status 为 escalate 时的冲突",
      })),
      decisionGate: Type.Optional(Type.Unknown({
        description: "status 为 escalate 时的决策闸",
      })),
    }),
  ),
);

export type AuditorOutput =
  | { readonly status: "pass" }
  | { readonly status: "revise"; readonly violations?: unknown }
  | {
      readonly status: "escalate";
      readonly conflicts?: unknown;
      readonly decisionGate?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectLawfulAuditorOutput(value: unknown): AuditorOutput | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "pass") return { status: "pass" };
  if (value.status === "revise") {
    return {
      status: "revise",
      ...(Object.hasOwn(value, "violations") ? { violations: value.violations } : {}),
    };
  }
  if (value.status === "escalate") {
    return {
      status: "escalate",
      ...(Object.hasOwn(value, "conflicts") ? { conflicts: value.conflicts } : {}),
      ...(Object.hasOwn(value, "decisionGate") ? { decisionGate: value.decisionGate } : {}),
    };
  }
  return undefined;
}

export function validateRecordedAuditorOutput(value: unknown): AuditorOutput {
  const projected = projectLawfulAuditorOutput(value);
  if (projected === undefined) {
    throw new Error("Auditor output has no recognized execution discriminator");
  }
  return projected;
}

export function auditorDecisiveFacts(output: AuditorOutput): Record<string, unknown> {
  const facts: Record<string, unknown> = { status: output.status };
  if (output.status === "revise" && output.violations !== undefined) {
    facts.violations = output.violations;
  }
  if (output.status === "escalate") {
    if (output.conflicts !== undefined) facts.conflicts = output.conflicts;
    if (output.decisionGate !== undefined) facts.decisionGate = output.decisionGate;
  }
  return facts;
}
