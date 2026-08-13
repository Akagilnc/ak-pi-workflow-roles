#!/usr/bin/env node
/**
 * Internal entry: offer the book's one-shot ticket dispatch lease for a
 * board-selected ticket (snapshot issue number + book + site).
 *
 * Not a public role CLI (ADR 0052). Not registered as a package bin.
 * The dispatcher machine (factory board snapshot identity already known)
 * invokes via:
 *   npx tsx scripts/offer-ticket-dispatch-lease.ts \
 *     --book <bookKey> \
 *     --site <siteIdentity> \
 *     --ticket <n> \
 *     [--home <processHome>]
 *
 * Ticket identity is the board snapshot issue number, never guessed from
 * worktree, branch, path, or --project. ak-role claims this lease on admit.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveActivationLedgerHome } from "../src/activation-ledger-topology.ts";
import { offerSelectedTicketDispatchLease } from "../src/factory-board-ticket-dispatch.ts";

function usage(): never {
  console.error(`Usage: npx tsx scripts/offer-ticket-dispatch-lease.ts --book <bookKey> --site <siteIdentity> --ticket <n> [--home <processHome>]
  --book    book key (factory-board snapshot bookKey)
  --site    site identity the claimer will present (equality only)
  --ticket  selected ticket number from the board snapshot
  --home    process home for the activation ledger (default: homedir)
`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

const bookKey = arg("--book");
const siteRaw = arg("--site");
const ticketRaw = arg("--ticket");
const homeRaw = arg("--home");
if (!bookKey || !siteRaw || !ticketRaw) usage();

const ticketNumber = Number(ticketRaw);
if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
  console.error("--ticket must be a positive integer");
  process.exit(2);
}

const siteIdentity = resolve(siteRaw);
const home = homeRaw === undefined ? homedir() : homeRaw;

try {
  offerSelectedTicketDispatchLease({
    ledgerHome: resolveActivationLedgerHome(() => home),
    bookKey,
    siteIdentity,
    ticketNumber,
  });
  console.error(`offered ticket dispatch lease for book ${bookKey} ticket ${ticketNumber}`);
} catch (error) {
  console.error(formatError(error));
  process.exit(1);
}
