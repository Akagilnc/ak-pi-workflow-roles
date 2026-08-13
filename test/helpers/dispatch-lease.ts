import { resolve } from "node:path";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { dispatchSelectedTicketRole } from "../../src/factory-board-ticket-dispatch.ts";

/**
 * Offer via the production board-select dispatcher seam (offer then ignite).
 * Tests that only need the lease use a no-op ignite; production supplies the
 * real role starter. Does not swallow HeldError.
 */
export function offerTestDispatchLease(
  home: string,
  projectRoot: string,
  ticketNumber = 176,
): void {
  const siteIdentity = resolve(projectRoot);
  dispatchSelectedTicketRole({
    ledgerHome: resolveActivationLedgerHome(() => home),
    bookKey: resolveBookKeyFromGit(siteIdentity),
    siteIdentity,
    ticketNumber,
    ignite: () => undefined,
  });
}
