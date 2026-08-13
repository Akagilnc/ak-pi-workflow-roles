import { resolve } from "node:path";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { offerTicketDispatchLease } from "../../src/ticket-dispatch-lease.ts";

/**
 * Test setup: place a pending dispatch lease for admit-path tests.
 * Production machine path is dispatchSelectedTicketRole (offer then start ak-role);
 * tests that only need the lease use this low-level offer. Does not swallow HeldError.
 */
export function offerTestDispatchLease(
  home: string,
  projectRoot: string,
  ticketNumber = 176,
): void {
  const siteIdentity = resolve(projectRoot);
  offerTicketDispatchLease({
    ledgerHome: resolveActivationLedgerHome(() => home),
    bookKey: resolveBookKeyFromGit(siteIdentity),
    siteIdentity,
    ticketNumber,
  });
}
