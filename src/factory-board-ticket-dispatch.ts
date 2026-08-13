import {
  offerTicketDispatchLease,
  type SiteIdentity,
  type TicketIdentity,
} from "./ticket-dispatch-lease.ts";

/**
 * Real machine dispatcher for a board-selected ticket.
 *
 * The selecting process already holds typed ticket/book/site identity (board
 * snapshot issue number + ledger book + site equality string). This seam:
 *   1) offers the book's unique one-shot dispatch lease, then
 *   2) ignites the role (caller-supplied; typically spawn/run ak-role at site).
 *
 * ak-role claims the lease on admit. No separate human CLI channel may carry
 * --book/--site/--ticket; callers without a selected ticket simply do not call
 * this, and admit stays unbound. Factory-board HTML render/watch must not call
 * this (one pending slot per book).
 */
export function dispatchSelectedTicketRole<T>(input: {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly ticketNumber: TicketIdentity;
  readonly now?: Date;
  readonly ignite: () => T;
}): T {
  offerTicketDispatchLease({
    ledgerHome: input.ledgerHome,
    bookKey: input.bookKey,
    siteIdentity: input.siteIdentity,
    ticketNumber: input.ticketNumber,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return input.ignite();
}
