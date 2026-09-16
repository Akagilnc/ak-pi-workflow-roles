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
import {
  isSafePositiveTicketNumber,
  requireSafePositiveTicketNumber,
} from "./run-ticket-number.ts";

export const DIARIST_OUTPUT_TOOL_NAME = "ak_diarist_output";
export const DIARIST_ACCEPTED_TEXT = "起居郎回执已接受";

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
       * Field absent → no new set this turn (resume keeps stored run fact; first court defaults to [main]).
       * Explicit empty array → single-ticket face [main] whole-set replace.
       * Non-empty with zero lawful members after type projection is not a new set (call site).
       * Mechanical layer only type-projects/dedupes and guarantees principal membership when applying a set.
       */
      readonly courtTicketNumbers?: readonly number[] | null;
      /**
       * Dialogue bounds: one entry per session volume, each with one or more ranges.
       * Empty / absent = lawful empty selection (no dialogue this turn).
       * Malformed endpoints → accept hook reasks (`reask-not-explode`).
       */
      readonly sessions?: readonly TicketProvenanceSession[];
    }
  | {
      /** LLM cannot tell which ticket this summons is about — escalate, never wash into 无录. */
      readonly status: "escalate";
      readonly reason: string;
    };

/**
 * Sole shape projection for a typed co-review ticket set (#871).
 * Positive safe integers, first-seen order, duplicates dropped. Not content judgment.
 * Returns null when `raw` is not an array (callers classify absent vs durable damage).
 * Returns a possibly empty list when `raw` is an array (unlawful members skipped).
 * When `principalTicket` is set, that ticket is guaranteed as a member (prepended if missing).
 */
export function projectCourtTicketNumbers(
  raw: unknown,
  options?: { readonly principalTicket?: number },
): readonly number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!isSafePositiveTicketNumber(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  const principal = options?.principalTicket;
  if (principal === undefined) return out;
  requireSafePositiveTicketNumber(principal, "projectCourtTicketNumbers principalTicket");
  if (seen.has(principal)) return out;
  return [principal, ...out];
}

/**
 * Durable-field interpreter for #871 co-review sets.
 * Absent key (old-format run) is not damage. Present but empty / non-array /
 * partially unlawful / missing principal is damage — callers must fail closed,
 * never wash into main-only.
 */
export function interpretDurableCourtTicketNumbers(
  record: Record<string, unknown>,
  options?: { readonly principalTicket?: number },
):
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly tickets: readonly number[] }
  | { readonly kind: "damage"; readonly reason: string } {
  if (!Object.hasOwn(record, "courtTicketNumbers")) {
    return { kind: "absent" };
  }
  const raw = record.courtTicketNumbers;
  if (!Array.isArray(raw)) {
    return {
      kind: "damage",
      reason: "courtTicketNumbers is present but not an array",
    };
  }
  if (raw.length === 0) {
    return {
      kind: "damage",
      reason: "courtTicketNumbers is present but empty",
    };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isSafePositiveTicketNumber(item)) {
      return {
        kind: "damage",
        reason: `courtTicketNumbers[${i}] is not a safe positive integer`,
      };
    }
  }
  // Members are all lawful numbers; sole projection owns dedupe/order.
  const tickets = projectCourtTicketNumbers(raw);
  if (tickets === null || tickets.length === 0) {
    return {
      kind: "damage",
      reason: "courtTicketNumbers projected empty after lawful members",
    };
  }
  const principal = options?.principalTicket;
  if (principal !== undefined) {
    if (!isSafePositiveTicketNumber(principal)) {
      return {
        kind: "damage",
        reason: "courtTicketNumbers principal ticket is not a safe positive integer",
      };
    }
    if (!tickets.includes(principal)) {
      return {
        kind: "damage",
        reason: `courtTicketNumbers is missing principal ticket #${principal}`,
      };
    }
  }
  return { kind: "ok", tickets: Object.freeze([...tickets]) };
}

/** True when two durable #871 sets are byte-identical sequences. */
export function sameCourtTicketNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
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
