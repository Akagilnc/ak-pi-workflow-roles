/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: pass | bounce.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";

export const NOTARY_OUTPUT_TOOL_NAME = "ak_notary_output";
export const NOTARY_ACCEPTED_TEXT = "Notary output accepted";
export const NOTARY_SOURCE_RUN_FLAG = {
  name: "ak-notary-source-run",
  definition: {
    description: "Absolute source run directory bound for Notary self-fetch",
    type: "string" as const,
  },
} as const;

/** Package-owned kickoff only — callers supply zero prompt bytes (ADR 0067 / #448). */
export const NOTARY_FIXED_KICKOFF =
  "Notary review. Bound source-run locator is on the session materials; fetch authoritative ticket, git, and dossier evidence yourself; submit one typed decision.";

export const notaryOutputSchema = openToolObject(
  Type.Object({
    status: Type.Unknown({
      description: "pass | bounce — 形状指引，非 schema 闸",
    }),
    findings: Type.Unknown({
      description: "string[] findings，随 pass 或 bounce 留存",
    }),
  }),
);

export type NotarySourceRunLocator = {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: string;
};

export type NotaryOutput =
  | { readonly status: "pass"; readonly findings: readonly string[] }
  | {
      readonly status: "bounce";
      readonly disposition: "rewrite";
      readonly findings: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Project one explicit Notary release. Throws when there is no lawful explicit
 * pass / bounce — callers map that to the existing non-zero failure channel.
 */
export function validateNotaryOutput(value: unknown): NotaryOutput {
  if (!isRecord(value)) {
    throw new Error("Notary output has no recognized execution discriminator");
  }
  const statusRaw = typeof value.status === "string" ? value.status : undefined;
  if (statusRaw === undefined) {
    throw new Error("Notary output has no recognized execution discriminator");
  }
  const status = statusRaw;
  if (status === "bounce") {
    const clone = structuredClone(value) as Record<string, unknown>;
    if (clone.disposition === undefined) clone.disposition = "rewrite";
    if (!Array.isArray(clone.findings)) clone.findings = asStringArray(clone.findings);
    return clone as NotaryOutput;
  }
  if (status === "pass") {
    const clone = structuredClone(value) as Record<string, unknown>;
    if (!Array.isArray(clone.findings)) clone.findings = asStringArray(clone.findings);
    return clone as NotaryOutput;
  }
  throw new Error("Notary output has no recognized execution discriminator");
}

export function validateRecordedNotaryOutput(value: unknown): NotaryOutput {
  return validateNotaryOutput(value);
}

export function notaryDecisiveFacts(output: NotaryOutput): Record<string, unknown> {
  const status = String(output.status);
  const facts: Record<string, unknown> = { status, officer: "notary" };
  if (status === "pass" || status === "bounce") {
    const findings = (output as { findings?: unknown }).findings;
    facts.findingsCount = Array.isArray(findings) ? findings.length : 0;
  }
  if (status === "bounce") {
    facts.disposition = "rewrite";
  }
  return facts;
}
