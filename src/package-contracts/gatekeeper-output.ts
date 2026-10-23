/**
 * Public Gatekeeper (门下省) terminating receipt contracts (#639).
 * Direct public seat decision shape. status field semantics: dispatch | pass.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

import { isRecord } from "../unknown-value.ts";

export const GATEKEEPER_OUTPUT_TOOL_NAME = "ak_gatekeeper_output";

/** Same open decision shape the province uses inside audit sessions. */
export const gatekeeperDecisionSchema = openToolObject(
  Type.Object({
    status: Type.Unknown({
      description: "dispatch | pass",
    }),
    officer: Type.Unknown({
      description: "仅 status 为 dispatch 时填 inspector | notary；没有就填 null",
    }),
    findings: Type.Unknown({
      description: "仅 status 为 pass 时填 string[] findings；没有就填 null",
    }),
  }),
);

export const gatekeeperOutputSchema = withTerminatingOutputDeclarations(
  gatekeeperDecisionSchema,
);

export type GatekeeperDirectOutput =
  | { readonly status: "dispatch"; readonly officer: "inspector" | "notary" }
  | { readonly status: "pass"; readonly findings?: readonly string[] };

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** #836: no status allowlist rejection — pass object through. */
export function validateRecordedGatekeeperOutput(value: unknown): GatekeeperDirectOutput {
  if (!isRecord(value)) throw new Error("Gatekeeper output is not an object");
  return value as GatekeeperDirectOutput;
}

