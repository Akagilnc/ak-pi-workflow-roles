import { resolve } from "node:path";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import {
  offerTicketDispatchLease,
  TicketDispatchLeaseHeldError,
} from "../../src/ticket-dispatch-lease.ts";

/** Test-only: ensure a pending one-shot lease exists for public admit/claim. */
export function offerTestDispatchLease(
  home: string,
  projectRoot: string,
  ticketNumber = 176,
): void {
  const siteIdentity = resolve(projectRoot);
  try {
    offerTicketDispatchLease({
      ledgerHome: resolveActivationLedgerHome(() => home),
      bookKey: resolveBookKeyFromGit(siteIdentity),
      siteIdentity,
      ticketNumber,
    });
  } catch (error) {
    if (!(error instanceof TicketDispatchLeaseHeldError)) throw error;
  }
}
