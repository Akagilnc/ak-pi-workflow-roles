/**
 * 起居郎 volume commit — ADR 0075 `diarist-is-role` / #901 / #1090.
 * LLM submits bounds; mechanical layer appends a projection commit from
 * session volumes (pure append, no cross-submit dedupe). No human view.
 * No lifecycle here (ADR 0018): the seat prepares, the role envelope commits.
 */
import { reprojectTicketProvenanceBatch } from "./ticket-provenance.ts";
import type { TicketProvenanceSession } from "./ticket-provenance-contracts.ts";

/**
 * Append per-ticket diary projections from LLM-submitted bounds (#1090 / #1107).
 * Shape projection of sessions is the caller's job (accept hook);
 * this seam only copies source facts into each ticket's volume.
 */
export async function commitDiaristProjection(input: {
  readonly cwd: string;
  readonly home?: string;
  readonly runDirectory?: string;
  readonly tickets: readonly {
    readonly ticketNumber: number | null;
    readonly sessions: readonly TicketProvenanceSession[];
  }[];
}): Promise<void> {
  await reprojectTicketProvenanceBatch(input);
}
