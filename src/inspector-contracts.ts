/**
 * Public Inspector (察院) terminating receipt contracts.
 * Lawful explicit releases: pass | bounce | escalate.
 * Dual path: gate-dispatched and independently callable (#568 / ADR 0074).
 */

export const INSPECTOR_OUTPUT_TOOL_NAME = "ak_inspector_output" as const;
export const INSPECTOR_ACCEPTED_TEXT = "察院回执已接受";
export const INSPECTOR_SOURCE_RUN_FLAG = {
  name: "ak-inspector-source-run",
  definition: {
    description: "Absolute parent run directory bound for Inspector first mint",
    type: "string" as const,
  },
} as const;

export type InspectorOutput =
  | { readonly status: "pass"; readonly findings?: unknown }
  | { readonly status: "bounce"; readonly findings?: unknown }
  | { readonly status: "escalate"; readonly reason?: unknown; readonly findings?: unknown };

export function validateRecordedInspectorOutput(value: unknown): InspectorOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inspector output has no execution discriminator");
  }
  let status: unknown;
  try {
    status = (value as Record<string, unknown>).status;
  } catch {
    throw new Error("Inspector output has no execution discriminator");
  }
  if (status === "pass" || status === "bounce" || status === "escalate") {
    return value as InspectorOutput;
  }
  throw new Error("Inspector output has no execution discriminator");
}

