import {
  offerTicketDispatchLease,
  type SiteIdentity,
  type TicketIdentity,
} from "./ticket-dispatch-lease.ts";

/**
 * Production producer: offer the book's unique one-shot dispatch lease for a
 * board-selected ticket. Ticket identity is the GitHub snapshot issue number
 * (typed), never inferred from worktree/branch/path.
 *
 * Does not start a role run. ak-role claims this lease on admit.
 * Factory-board HTML render/watch must not call this (one pending slot per book).
 */
export function offerSelectedTicketDispatchLease(input: {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly ticketNumber: TicketIdentity;
  readonly now?: Date;
}): void {
  offerTicketDispatchLease({
    ledgerHome: input.ledgerHome,
    bookKey: input.bookKey,
    siteIdentity: input.siteIdentity,
    ticketNumber: input.ticketNumber,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
