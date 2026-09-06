/**
 * Public 起居郎 (diarist) terminating receipt contracts — ADR 0075 `diarist-is-role`.
 * Lawful explicit release: completed, with empty or nonempty selections.
 * Machine facts about the volume come from the mechanical sitian seam, never
 * from model self-report (锚定宪法); this module owns the receipt shape only.
 */

export const DIARIST_OUTPUT_TOOL_NAME = "ak_diarist_output";
export const DIARIST_ACCEPTED_TEXT = "起居郎回执已接受";

/** Internal transport: frozen candidate-catalog path for this turn's ticket. */
export const DIARIST_SOURCES_FLAG = {
  name: "ak-diarist-sources",
  definition: {
    description: "Frozen per-ticket source catalog the diarist selects from",
    type: "string" as const,
  },
} as const;

/** One selected block reference into the frozen candidate catalog. */
export type DiaristSelection = {
  /** Index into the catalog the diarist received. */
  readonly candidateIndex: number;
  /** Quotes claimed verbatim from that block (reverse-verified mechanically). */
  readonly quotes: readonly string[];
  /** Human-facing note (relation to this case). Not a machine gate. */
  readonly note?: string;
};

export type DiaristOutput = {
  readonly status: "completed";
  readonly selections: readonly DiaristSelection[];
};

export function validateRecordedDiaristOutput(value: unknown): DiaristOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Diarist output has no execution discriminator");
  }
  let status: unknown;
  try {
    status = (value as Record<string, unknown>).status;
  } catch {
    throw new Error("Diarist output has no execution discriminator");
  }
  if (status === "completed") {
    return value as DiaristOutput;
  }
  throw new Error("Diarist output has no execution discriminator");
}

/**
 * Lenient projection of submitted selections (第 0 条: shape is not an admission
 * gate). Rows that carry no usable candidateIndex are dropped from the commit,
 * never bounced back at the role.
 */
export function projectDiaristSelections(value: unknown): DiaristSelection[] {
  const rows = (value as { selections?: unknown } | null)?.selections;
  if (!Array.isArray(rows)) return [];
  const out: DiaristSelection[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const index = record.candidateIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
    const quotes = Array.isArray(record.quotes)
      ? record.quotes.filter((q): q is string => typeof q === "string" && q.length > 0)
      : [];
    out.push({
      candidateIndex: index,
      quotes,
      ...(typeof record.note === "string" ? { note: record.note } : {}),
    });
  }
  return out;
}

/** Machine-facing facts from an accepted receipt. Submitted rows retained as-is. */
export function diaristDecisiveFacts(
  output: DiaristOutput,
): Record<string, unknown> {
  const facts: Record<string, unknown> = { status: output.status };
  const selections = (output as { selections?: unknown }).selections;
  if (Array.isArray(selections)) facts.selections = selections;
  // Mechanical sitian facts recorded by the envelope at accept time.
  const sitian = (output as { sitian?: unknown }).sitian;
  if (sitian !== undefined) facts.sitian = sitian;
  return facts;
}
