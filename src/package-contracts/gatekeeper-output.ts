/**
 * Public Gatekeeper (门下省) terminating receipt contracts (#639).
 * Direct public seat shares the province decision shape: dispatch | pass.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./terminating-infrastructure.ts";

export const GATEKEEPER_OUTPUT_TOOL_NAME = "ak_gatekeeper_output";
export const GATEKEEPER_ACCEPTED_TEXT = "门下省决议已受理";

/** Same open decision shape the province uses inside audit sessions. */
export const gatekeeperOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "dispatch | pass — 形状指引，非 schema 闸",
      }),
      officer: Type.Unknown({
        description: "status 为 dispatch 时为 inspector | notary",
      }),
      findings: Type.Unknown({
        description: "status 为 pass 时可选 string[] findings",
      }),
    }),
  ),
);

export type GatekeeperDirectOutput =
  | { readonly status: "dispatch"; readonly officer: "inspector" | "notary" }
  | { readonly status: "pass"; readonly findings?: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Project one lawful explicit Gatekeeper decision (dispatch | pass).
 * No throw on shape — ADR 0055 / 第 0 条: already-submitted params are retained as-is;
 * public-terminal projects non-usable releases via typed failure cause.
 */
export function projectLawfulGatekeeperOutput(value: unknown): GatekeeperDirectOutput | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "pass") {
    return Array.isArray(value.findings)
      ? { status: "pass", findings: asStringArray(value.findings) }
      : { status: "pass" };
  }
  if (
    value.status === "dispatch" &&
    (value.officer === "inspector" || value.officer === "notary")
  ) {
    return { status: "dispatch", officer: value.officer };
  }
  return undefined;
}

/**
 * Settlement/recording path: only lawful recorded dispatch/pass.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedGatekeeperOutput(value: unknown): GatekeeperDirectOutput {
  const projected = projectLawfulGatekeeperOutput(value);
  if (projected === undefined) {
    throw new Error("Gatekeeper output has no recognized execution discriminator");
  }
  return projected;
}

export function gatekeeperDecisiveFacts(
  output: GatekeeperDirectOutput,
): Record<string, unknown> {
  const facts: Record<string, unknown> = { status: output.status };
  if (output.status === "dispatch") {
    facts.officer = output.officer;
  } else if (Array.isArray(output.findings)) {
    facts.findingsCount = output.findings.length;
  }
  return facts;
}
