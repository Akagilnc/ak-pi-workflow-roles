/**
 * Public 起居郎 (diarist) terminating receipt contracts — ADR 0075 `diarist-is-role` / #901.
 * Lawful explicit releases: completed (入录) | escalate (认不出本庭对象上抛).
 * Machine facts about the volume come from the mechanical reproject seam, never
 * from model self-report (锚定宪法); this module owns the receipt shape only.
 *
 * #901: LLM submits bounds; the mechanical layer projects source bytes.
 */

import {
  projectTicketProvenanceSessions,
  type TicketProvenanceSession,
} from "./ticket-provenance-contracts.ts";
import { isSafePositiveTicketNumber } from "./run-ticket-number.ts";
import { isRecord } from "./unknown-value.ts";

export const DIARIST_OUTPUT_TOOL_NAME = "ak_diarist_output";

export type DiaristOutput =
  | {
      readonly status: "completed";
      /**
       * Typed court-target assertion (ADR 0075 `diarist-resolves-ticket-llm-layer`).
       * Positive integer = 本庭对象=票N; null/absent = true-unbound (先录入 unbound).
       * LLM owns recognition; mechanical layer does not re-judge the number.
       */
      readonly ticketNumber?: number | null;
      /**
       * Dialogue bounds: one entry per session volume, each with one or more ranges.
       * Empty / absent = lawful empty selection (no dialogue this turn).
       * Malformed endpoints → accept hook reasks (`reask-not-explode`).
       */
      readonly sessions?: readonly TicketProvenanceSession[];
      /** Per-ticket dialogue bounds for a single multi-ticket summons (#1107). */
      readonly ticketSessions?: readonly {
        readonly ticketNumber: number;
        readonly sessions: readonly TicketProvenanceSession[];
      }[];
    }
  | {
      /** LLM cannot tell which ticket this summons is about — escalate, never wash into 无录. */
      readonly status: "escalate";
      readonly reason: string;
    };

export function validateRecordedDiaristOutput(value: unknown): DiaristOutput {
  if (!isRecord(value)) {
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
 * Project sessions from a completed diarist payload.
 * Absent key → empty (lawful). Present but unusable → undefined (caller reasks).
 */
export function projectDiaristSessions(
  value: unknown,
): readonly TicketProvenanceSession[] | undefined {
  const raw = (value as { sessions?: unknown } | null)?.sessions;
  if (raw === undefined) return [];
  return projectTicketProvenanceSessions(raw);
}

/** Present multi-ticket bounds take precedence over the legacy single-ticket sessions. */
export function projectDiaristTicketSessions(
  value: Record<string, unknown>,
): readonly { readonly ticketNumber: number; readonly sessions: readonly TicketProvenanceSession[] }[] | undefined {
  const raw = value.ticketSessions;
  if (!Array.isArray(raw)) return undefined;
  const perTicket = new Map<number, TicketProvenanceSession[]>();
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const { ticketNumber, sessions: rawSessions } = entry as Record<string, unknown>;
    if (!isSafePositiveTicketNumber(ticketNumber)) return undefined;
    const sessions = projectTicketProvenanceSessions(rawSessions);
    if (sessions === undefined) return undefined;
    perTicket.set(ticketNumber, [...(perTicket.get(ticketNumber) ?? []), ...sessions]);
  }
  return Array.from(perTicket, ([ticketNumber, sessions]) => ({ ticketNumber, sessions }));
}
