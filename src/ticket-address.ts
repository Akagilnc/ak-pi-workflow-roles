/**
 * #1201 public address: ticket + seat (+ round). One locator shared by
 * `ak-role resume <ticket> <seat>[#<round>]` and
 * `--source-run <ticket>:<seat>#<round>` (ADR 0088).
 *
 * Only legs filed under the ticket are visible here. A leg that has reported no
 * ticket stays in `unbound/` and is not in this address.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { CliUsageError } from "./public-cli/cli-errors.ts";
import { parseRunLeaf } from "./role-run-placement.ts";
import { parseTicketNumber } from "./run-ticket-number.ts";
import { readTicketProgressLines } from "./ticket-progress.ts";

export type TicketLegAddress = {
  readonly ticketNumber: number;
  readonly seat: string;
  /** Round as written on the progress row (`2`, `1.completeness`). */
  readonly round?: string;
};

/** Bare digits; a quoted leading `#` is accepted. */
export function parseAddressTicket(token: string): number | undefined {
  return parseTicketNumber(token.startsWith("#") ? token.slice(1) : token);
}

/** `<seat>` or `<seat>#<round>`. */
export function parseSeatRound(token: string): { readonly seat: string; readonly round?: string } {
  const hash = token.indexOf("#");
  return hash === -1
    ? { seat: token }
    : { seat: token.slice(0, hash), round: token.slice(hash + 1) };
}

/** `<ticket>:<seat>#<round>`; undefined when the token is not that spelling. */
export function parseTicketLegLocator(token: string): Required<TicketLegAddress> | undefined {
  const colon = token.indexOf(":");
  if (colon === -1) return undefined;
  const ticketNumber = parseAddressTicket(token.slice(0, colon));
  const { seat, round } = parseSeatRound(token.slice(colon + 1));
  if (ticketNumber === undefined || seat === "" || round === undefined || round === "") {
    return undefined;
  }
  return { ticketNumber, seat, round };
}

/**
 * Run directory of the addressed leg under the caller's book directory.
 * With a round: the leg that sealed that progress row (the row's receipt
 * reference names it). Without: the seat's most recently active leg under the
 * ticket, read off the leg directories themselves — rows exist only for accepted
 * receipts, so a leg that has not submitted yet is still found. Activity is the
 * leg directory's mtime: every turn takes and releases the leg's writer lease
 * there. One `runs/` listing and one stat per leg of the seat.
 */
export function locateTicketLeg(bookDirectory: string, input: TicketLegAddress): string {
  const ticketDirectory = join(bookDirectory, String(input.ticketNumber));
  if (!existsSync(ticketDirectory)) {
    throw new CliUsageError(`ticket ${input.ticketNumber} has no records in this project's book: ${ticketDirectory}`);
  }
  if (input.round !== undefined) {
    const row = readTicketProgressLines(ticketDirectory)
      .find((line) => line.seat === input.seat && line.round === input.round);
    if (row === undefined) {
      throw new CliUsageError(
        `ticket ${input.ticketNumber} has no progress row ${input.seat}#${input.round}`,
      );
    }
    // `runs/<leg>/receipts/<n>.json`
    return join(ticketDirectory, ...row.receipt.split("/").slice(0, 2));
  }
  const runsDirectory = join(ticketDirectory, "runs");
  let latest: { readonly leaf: string; readonly mtimeMs: number } | undefined;
  for (const entry of existsSync(runsDirectory) ? readdirSync(runsDirectory, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || parseRunLeaf(entry.name)?.role !== input.seat) continue;
    const { mtimeMs } = statSync(join(runsDirectory, entry.name));
    if (
      latest === undefined
      || mtimeMs > latest.mtimeMs
      || (mtimeMs === latest.mtimeMs && entry.name > latest.leaf)
    ) {
      latest = { leaf: entry.name, mtimeMs };
    }
  }
  if (latest === undefined) {
    throw new CliUsageError(`ticket ${input.ticketNumber} has no ${input.seat} leg`);
  }
  return join(runsDirectory, latest.leaf);
}
