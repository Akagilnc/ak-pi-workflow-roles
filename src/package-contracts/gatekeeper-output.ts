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
export const gatekeeperDecisionSchema = openToolObject(
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
);

export const gatekeeperOutputSchema = withInfrastructureFailureDeclaration(
  gatekeeperDecisionSchema,
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
/** #836: no field drop — original object is the receipt. */
export function projectLawfulGatekeeperOutput(value: unknown): GatekeeperDirectOutput | undefined {
  return isRecord(value) ? (value as GatekeeperDirectOutput) : undefined;
}

/** #836: no status allowlist rejection — pass object through. */
export function validateRecordedGatekeeperOutput(value: unknown): GatekeeperDirectOutput {
  if (!isRecord(value)) throw new Error("Gatekeeper output is not an object");
  return value as GatekeeperDirectOutput;
}

