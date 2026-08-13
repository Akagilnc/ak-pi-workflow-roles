import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { offerSelectedTicketDispatchLease } from "../../src/factory-board-ticket-dispatch.ts";
import {
  DISPATCH_LEASE_PENDING_FILE,
  TicketDispatchLeaseHeldError,
} from "../../src/ticket-dispatch-lease.ts";

async function withLedgerHome<T>(scenario: (ledgerHome: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-board-dispatch-"));
  try {
    const ledgerHome = resolveActivationLedgerHome(() => home);
    return await scenario(ledgerHome);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("production offerSelectedTicketDispatchLease writes the pending lease", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerSelectedTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    const pendingPath = join(
      activationBookDirectory(ledgerHome, "demo-book"),
      DISPATCH_LEASE_PENDING_FILE,
    );
    assert.equal(existsSync(pendingPath), true);
  });
});

test("second production offer while pending exists throws HeldError", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerSelectedTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    assert.throws(
      () =>
        offerSelectedTicketDispatchLease({
          ledgerHome,
          bookKey: "demo-book",
          siteIdentity: "/site/other",
          ticketNumber: 177,
        }),
      (error: unknown) => error instanceof TicketDispatchLeaseHeldError,
    );
  });
});
