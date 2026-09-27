/**
 * 起居郎 volume commit — ADR 0075 `diarist-is-role` / #901 / #1090.
 * LLM submits bounds; mechanical layer appends a projection commit from
 * session volumes (pure append, no cross-submit dedupe). No human view.
 * No lifecycle here (ADR 0018): the seat prepares, the role envelope commits.
 */
import { reprojectTicketProvenance } from "./ticket-provenance.ts";
import type { TicketProvenanceSession } from "./ticket-provenance-contracts.ts";

/**
 * Honest machine facts about what this turn actually committed to the volume.
 * Populated by the envelope accept hook — never from model self-report.
 */
export type DiaristCommitFacts = {
  readonly ticketNumber: number | null;
  readonly volumeRecordFile: string;
  /** Dialogue lines written by this reproject. */
  readonly lineCount: number;
};

/**
 * Append a diary projection from LLM-submitted bounds (#1090).
 * Shape projection of sessions is the caller's job (accept hook);
 * this seam only copies source facts into the volume.
 */
export async function commitDiaristProjection(input: {
  readonly ticketNumber: number | null;
  readonly cwd: string;
  readonly home?: string;
  readonly runDirectory?: string;
  readonly sessions: readonly TicketProvenanceSession[];
}): Promise<DiaristCommitFacts> {
  const result = await reprojectTicketProvenance({
    ticketNumber: input.ticketNumber,
    cwd: input.cwd,
    ...(input.home === undefined ? {} : { home: input.home }),
    sessions: input.sessions,
    ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
  });
  return {
    ticketNumber: input.ticketNumber,
    volumeRecordFile: result.recordFile,
    lineCount: result.lines.length,
  };
}
