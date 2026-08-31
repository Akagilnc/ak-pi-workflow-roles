/**
 * Public Gleaner-Left (左拾遗) terminating receipt contracts.
 * Lawful explicit release: completed, with empty or nonempty 弹章.
 * No bounce / verdict channel (言不为狱). 原卷保真 (ADR 0055).
 */

export const GLEANER_LEFT_OUTPUT_TOOL_NAME = "ak_gleaner_left_output";
export const GLEANER_LEFT_ACCEPTED_TEXT = "左拾遗回执已接受";

export type GleanerLeftFinding = {
  readonly pointer: string;
  readonly statement: string;
};

export type GleanerLeftOutput = {
  readonly status: "completed";
  readonly findings: readonly GleanerLeftFinding[];
};

export function validateRecordedGleanerLeftOutput(value: unknown): GleanerLeftOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gleaner-left output has no execution discriminator");
  }
  let status: unknown;
  try {
    status = (value as Record<string, unknown>).status;
  } catch {
    throw new Error("Gleaner-left output has no execution discriminator");
  }
  if (status === "completed") {
    return value as GleanerLeftOutput;
  }
  throw new Error("Gleaner-left output has no execution discriminator");
}

/** Machine-facing facts from an accepted 弹章. Findings retained as submitted. */
export function gleanerLeftDecisiveFacts(
  output: GleanerLeftOutput,
): Record<string, unknown> {
  const facts: Record<string, unknown> = { status: output.status };
  const findings = (output as { findings?: unknown }).findings;
  if (Array.isArray(findings)) facts.findings = findings;
  return facts;
}
