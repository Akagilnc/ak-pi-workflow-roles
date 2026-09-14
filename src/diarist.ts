/**
 * 起居郎 volume commit — ADR 0075 `diarist-is-role` / #901.
 * LLM submits bounds (+ optional amendments); mechanical layer reprojects the
 * unique records.jsonl from session volumes. No human view. No lifecycle here
 * (ADR 0018): the seat prepares, the role envelope commits.
 */
import {
  reprojectTicketProvenance,
  type UnparsableSessionLine,
} from "./ticket-provenance.ts";
import type {
  TicketProvenanceAmendment,
  TicketProvenanceSession,
} from "./ticket-provenance-contracts.ts";

/**
 * Honest machine facts about what this turn actually committed to the volume.
 * Populated by the envelope accept hook — never from model self-report.
 */
export type DiaristCommitFacts = {
  readonly ticketNumber: number;
  readonly volumeRecordFile: string;
  /** Dialogue lines written by this reproject. */
  readonly lineCount: number;
  /**
   * Session lines inside the bounds that still have no amendment.
   * Accept hook turns a non-empty list into ParentQueueReaskError.
   */
  readonly unparsable: readonly UnparsableSessionLine[];
};

/**
 * Reproject the unique diary from LLM-submitted bounds + optional amendments.
 * Shape projection of sessions/amendments is the caller's job (accept hook);
 * this seam only copies source facts into the volume.
 */
export async function commitDiaristProjection(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly home?: string;
  readonly sessions: readonly TicketProvenanceSession[];
  readonly amendments?: readonly TicketProvenanceAmendment[];
}): Promise<DiaristCommitFacts> {
  const result = await reprojectTicketProvenance({
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    ...(input.home === undefined ? {} : { home: input.home }),
    sessions: input.sessions,
    ...(input.amendments === undefined ? {} : { amendments: input.amendments }),
  });
  return {
    ticketNumber: input.ticketNumber,
    volumeRecordFile: result.recordFile,
    lineCount: result.lines.length,
    unparsable: result.unparsable,
  };
}
