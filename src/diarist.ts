/**
 * 起居郎 volume commit — ADR 0075 `diarist-is-role` / #779.
 * Semantic collection is the diarist role's own LLM turn (finds materials itself).
 * This module only appends submitted whole blocks idempotently and refreshes the
 * human view. No frozen catalog, no quote reverse-verify, no ticket-number
 * re-judgment of LLM output (#779 owner: 机械层凭什么能判断llm的输出).
 * No lifecycle here (ADR 0018): the seat prepares, the role envelope commits.
 */
import {
  appendTicketProvenanceEntry,
  ensureTicketProvenanceVolume,
  readTicketProvenance,
  writeTicketProvenanceHumanView,
} from "./ticket-provenance.ts";
import { projectTicketProvenanceEntry } from "./ticket-provenance-contracts.ts";

/**
 * Honest machine facts about what this turn actually committed to the volume.
 * Populated by the envelope accept hook — never from model self-report.
 */
export type DiaristCommitFacts = {
  readonly ticketNumber: number;
  /** New body entries this turn actually put on the volume (entry-count delta). */
  readonly appended: number;
  /** Submitted rows that could not form a lawful volume entry (shape only). */
  readonly dropped: number;
  readonly volumeRecordFile: string;
  readonly humanViewFile: string;
  /**
   * What this turn's collection amounted to.
   * `empty-selection` = LLM submitted no rows; `nothing-appended` = every row
   * dropped at the write seam; both differ from a successful append.
   */
  readonly collectorStatus: "ok" | "empty-selection" | "nothing-appended";
};

/**
 * Append LLM-submitted whole blocks under a bound ticket.
 * Entry identity keeps the volume idempotent across re-summons.
 * Shape projection is write-seam self-check only — not content judgment (#779).
 */
export async function commitDiaristEntries(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly sessionParent: string;
  readonly home?: string;
  readonly entries: readonly unknown[];
}): Promise<DiaristCommitFacts> {
  const { ticketNumber, cwd } = input;
  const homeOpt = input.home === undefined ? {} : { home: input.home };
  const volumePaths = ensureTicketProvenanceVolume(ticketNumber, cwd, input.home);

  const before = await readTicketProvenance(ticketNumber, cwd, input.home);
  let dropped = 0;

  for (const submitted of input.entries) {
    if (projectTicketProvenanceEntry(submitted) === undefined) {
      dropped += 1;
    }
    appendTicketProvenanceEntry({
      ticketNumber,
      cwd,
      sessionParent: input.sessionParent,
      ...homeOpt,
      payload: submitted,
      source: "diarist",
    });
  }

  const volume = await readTicketProvenance(ticketNumber, cwd, input.home);
  const humanViewFile = writeTicketProvenanceHumanView({
    ticketNumber,
    cwd,
    ...homeOpt,
    entries: volume.entries,
    unprojected: volume.unprojected,
  });

  const appended = volume.entries.length - before.entries.length;
  return {
    ticketNumber,
    appended,
    dropped,
    volumeRecordFile: volumePaths.recordFile,
    humanViewFile,
    collectorStatus:
      appended > 0
        ? "ok"
        : input.entries.length === 0
          ? "empty-selection"
          : "nothing-appended",
  };
}
