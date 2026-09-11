/**
 * Public Auditor (审刑院) terminating receipt contracts (#675 / #754).
 * Lawful explicit releases: pass | bounce | escalate.
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./terminating-infrastructure.ts";

export const AUDITOR_OUTPUT_TOOL_NAME = "ak_auditor_output" as const;
export const AUDITOR_ACCEPTED_TEXT = "审刑院回执已接受";

// #836 r16 class 2: `status` is the machine execution discriminator the queue
// reads (src/judge-role.ts:120-129 审刑院合规路径 / src/gatekeeper-role.ts:170-247).
export const auditorOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "pass | bounce | escalate — 形状指引，非 schema 闸",
      }),
      violations: Type.Optional(Type.Unknown({
        description: "status 为 bounce 时的违规条目",
      })),
      conflicts: Type.Optional(Type.Unknown({
        description: "status 为 escalate 时的冲突",
      })),
      decisionGate: Type.Optional(Type.Unknown({
        description: "status 为 escalate 时的决策闸",
      })),
    }),
    ["status"],
  ),
);

export type AuditorOutput =
  | { readonly status: "pass" }
  | { readonly status: "bounce"; readonly violations?: unknown }
  | {
      readonly status: "escalate";
      readonly conflicts?: unknown;
      readonly decisionGate?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** #836: no field drop — original object is the receipt. */
export function projectLawfulAuditorOutput(value: unknown): AuditorOutput | undefined {
  return isRecord(value) ? (value as AuditorOutput) : undefined;
}

export function validateRecordedAuditorOutput(value: unknown): AuditorOutput {
  if (!isRecord(value)) throw new Error("Auditor output is not an object");
  return value as AuditorOutput;
}

