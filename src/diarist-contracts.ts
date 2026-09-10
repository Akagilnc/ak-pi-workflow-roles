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
      /** Whole blocks to append under the asserted ticket. Empty list is lawful. */
      readonly entries?: readonly DiaristEntrySubmission[];
    }
  | {
      /** LLM cannot tell which ticket this summons is about — escalate, never wash into 无录. */
      readonly status: "escalate";
      readonly reason: string;
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
  if (status === "completed" || status === "escalate") {
    return value as DiaristOutput;
  }
  throw new Error("Diarist output has no execution discriminator");
}

/**
 * Lenient projection of submitted entries (第 0 条: shape is not an admission
 * gate). Rows that cannot form a lawful volume entry are dropped from the
 * commit, never bounced back at the role. This is write-seam self-check only —
 * not quote/ticket/relevance judgment of LLM content (#779).
 */
export function projectDiaristEntries(value: unknown): DiaristEntrySubmission[] {
  const rows = (value as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(rows)) return [];
  const out: DiaristEntrySubmission[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      out.push({
        sourceKind: "unprojected",
        sourceRef: {},
        transcript: JSON.stringify(row),
        timestamp: "",
      });
      continue;
    }
    const record = row as Record<string, unknown>;
    const ref = record.sourceRef !== null && typeof record.sourceRef === "object" && !Array.isArray(record.sourceRef)
      ? record.sourceRef as Record<string, unknown>
      : {};
    const sourceRef: TicketProvenanceSourceRef = {
      ...(typeof ref.sessionFile === "string" ? { sessionFile: ref.sessionFile } : {}),
      ...(typeof ref.entryId === "string" || typeof ref.entryId === "number"
        ? { entryId: ref.entryId }
        : {}),
      ...(typeof ref.path === "string" ? { path: ref.path } : {}),
      ...(typeof ref.url === "string" ? { url: ref.url } : {}),
    };
    out.push({
      sourceKind: typeof record.sourceKind === "string" ? record.sourceKind : "unprojected",
      sourceRef,
      transcript: typeof record.transcript === "string" && record.transcript.length > 0
        ? record.transcript
        : JSON.stringify(record),
      timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
      ...(typeof record.note === "string" ? { note: record.note } : {}),
    });
  }
  return out;
}
