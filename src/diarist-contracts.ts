/**
 * Public 起居郎 (diarist) terminating receipt contracts — ADR 0075 `diarist-is-role`.
 * Lawful explicit releases: completed (入录) | escalate (认不出本庭对象上抛).
 * Machine facts about the volume come from the mechanical sitian seam, never
 * from model self-report (锚定宪法); this module owns the receipt shape only.
 *
 * #779: no frozen candidate catalog; LLM finds sources and submits whole blocks.
 * Mechanical layer does not judge LLM output (no quote/ticket/relevance verify).
 */

import type {
  TicketProvenanceSourceKind,
  TicketProvenanceSourceRef,
} from "./ticket-provenance-contracts.ts";

export const DIARIST_OUTPUT_TOOL_NAME = "ak_diarist_output";
export const DIARIST_ACCEPTED_TEXT = "起居郎回执已接受";

/**
 * One whole block the diarist chose to enter (ADR 0075 `transcribe-whole-blocks`).
 * LLM supplies the block bytes + source pointer; mechanical layer appends as-is.
 */
export type DiaristEntrySubmission = {
  readonly sourceKind: TicketProvenanceSourceKind;
  readonly sourceRef: TicketProvenanceSourceRef;
  /** Whole-block transcript — not a pointer-only stand-in. */
  readonly transcript: string;
  readonly timestamp: string;
  /** Human-facing note (relation to this case). Not a machine gate. */
  readonly note?: string;
};

export type DiaristOutput =
  | {
      readonly status: "completed";
      /**
       * Typed court-target assertion (ADR 0075 `diarist-resolves-ticket-llm-layer`).
       * Positive integer = 本庭对象=票N; null/absent = true-unbound (真无票→无录).
       * LLM owns recognition; mechanical layer does not re-judge the number.
       */
      readonly ticketNumber?: number | null;
      /**
       * #871 typed co-review set (ADR 0075 `diarist-resolves-ticket-llm-layer` narrow extension).
       * Positive integers = tickets that should each receive a diary this court (includes main).
       * Absent/empty → single-ticket face (main only). Mechanical layer only type-projects/dedupes.
       */
      readonly courtTicketNumbers?: readonly number[] | null;
      /** Whole blocks to append under the asserted ticket. Empty list is lawful. */
      readonly entries?: readonly DiaristEntrySubmission[];
    }
  | {
      /** LLM cannot tell which ticket this summons is about — escalate, never wash into 无录. */
      readonly status: "escalate";
      readonly reason: string;
    };

/**
 * Shape-only projection of a typed co-review ticket set (#871).
 * Positive safe integers, first-seen order, duplicates dropped. Not content judgment.
 * Returns undefined when the field is absent or yields no lawful members after projection.
 */
export function projectCourtTicketNumbers(raw: unknown): readonly number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    let n: number | undefined;
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 1) {
      n = item;
    } else if (typeof item === "string" && /^[1-9]\d*$/.test(item)) {
      const parsed = Number(item);
      if (Number.isSafeInteger(parsed) && parsed >= 1) n = parsed;
    }
    if (n === undefined || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

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
  if (status === "completed" || status === "escalate") {
    return value as DiaristOutput;
  }
  throw new Error("Diarist output has no execution discriminator");
}

/** Entries array as the diarist wrote it — no field rewrite (#836 B6.8/B6.9). */
export function projectDiaristEntries(value: unknown): unknown[] {
  const rows = (value as { entries?: unknown } | null)?.entries;
  return Array.isArray(rows) ? [...rows] : [];
}
