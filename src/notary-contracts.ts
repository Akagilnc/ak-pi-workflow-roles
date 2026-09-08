/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: pass | bounce | escalate.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export const NOTARY_OUTPUT_TOOL_NAME = "ak_notary_output";
export const NOTARY_ACCEPTED_TEXT = "符宝郎回执已接受";
export const NOTARY_SOURCE_RUN_FLAG = {
  name: "ak-notary-source-run",
  definition: {
    description: "Absolute source run directory bound for Notary self-fetch",
    type: "string" as const,
  },
} as const;

/** Optional ticket binding for court-diary (起居录) lookup — ADR 0075. */
export const NOTARY_TICKET_FLAG = {
  name: "ak-notary-ticket-number",
  definition: {
    description: "Optional ticket number for Notary court-diary lookup",
    type: "string" as const,
  },
} as const;

/** Package-owned kickoff only — callers supply zero prompt bytes (ADR 0067 / #448). */
export const NOTARY_FIXED_KICKOFF =
  "符宝郎案卷已受理；来源 run 定位见会话材料。";

export const notaryOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "pass | bounce | escalate — 形状指引，非 schema 闸",
      }),
      findings: Type.Unknown({
        description: "string[] findings，随 pass、bounce 或 escalate 留存",
      }),
      reason: Type.Optional(Type.Unknown({
        description: "status 为 escalate 时的上呈理由",
      })),
    }),
  ),
);

export type NotarySourceRunLocator = {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: string;
};

/** Recognition face only — fields retained as submitted (#753, no disposition/findings forge). */
export type NotaryOutput =
  | { readonly status: "pass"; readonly findings?: unknown }
  | { readonly status: "bounce"; readonly findings?: unknown }
  | {
      readonly status: "escalate";
      readonly reason?: unknown;
      readonly findings?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recognize one lawful explicit Notary release (pass | bounce | escalate).
 * #753: no field rewrite — submitted params retained as-is (no disposition forge,
 * no findings array rewrite). Recognition only for recording/settlement callers.
 */
export function projectLawfulNotaryOutput(value: unknown): NotaryOutput | undefined {
  if (!isRecord(value)) return undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  if (status === "bounce" || status === "pass" || status === "escalate") {
    return value as NotaryOutput;
  }
  return undefined;
}

/** Retain submitted Notary params as-is for the failure channel (no shape rewrite). */
export function retainNotarySubmission(value: unknown): unknown {
  if (value === undefined) return { missing: "arguments" as const };
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Settlement/recording path: only lawful recorded pass/bounce/escalate.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedNotaryOutput(value: unknown): NotaryOutput {
  const projected = projectLawfulNotaryOutput(value);
  if (projected === undefined) {
    throw new Error("Notary output has no recognized execution discriminator");
  }
  return projected;
}

