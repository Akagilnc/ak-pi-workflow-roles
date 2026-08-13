import { resolve } from "node:path";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { offerSelectedTicketDispatchLease } from "../../src/factory-board-ticket-dispatch.ts";

/** Offer via the production board-select seam. Does not swallow HeldError. */
export function offerTestDispatchLease(
  home: string,
  projectRoot: string,
  ticketNumber = 176,
): void {
  const siteIdentity = resolve(projectRoot);
  offerSelectedTicketDispatchLease({
    ledgerHome: resolveActivationLedgerHome(() => home),
    bookKey: resolveBookKeyFromGit(siteIdentity),
    siteIdentity,
    ticketNumber,
  });
}
