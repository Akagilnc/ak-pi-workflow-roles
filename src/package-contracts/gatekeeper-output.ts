/**
 * Public Gatekeeper (门下省) terminating receipt contracts (#639).
 * Direct public seat decision shape. status field semantics: converged | continue | escalate.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export const GATEKEEPER_OUTPUT_TOOL_NAME = "ak_gatekeeper_output";

/** Same open decision shape the province uses inside audit sessions. */
export const gatekeeperDecisionSchema = openToolObject(
  Type.Object({
    status: Type.Unknown({
      description: "converged | continue | escalate",
    }),
    officer: Type.Unknown({
      description: "inspector | notary",
    }),
    findings: Type.Unknown({
      description: "findings",
    }),
  }),
);

export const gatekeeperOutputSchema = withTerminatingOutputDeclarations(
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
 * Project one explicit Gatekeeper decision.
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

