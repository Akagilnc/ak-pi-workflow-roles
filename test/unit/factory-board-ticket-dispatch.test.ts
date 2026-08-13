import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { dispatchSelectedTicketRole } from "../../src/factory-board-ticket-dispatch.ts";
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

test("machine dispatcher offers lease then ignites role", async () => {
  await withLedgerHome(async (ledgerHome) => {
    let ignited = false;
    const result = dispatchSelectedTicketRole({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
      ignite: () => {
        ignited = true;
        // Lease must already be pending before ignition so admit can claim it.
        const pendingPath = join(
          activationBookDirectory(ledgerHome, "demo-book"),
          DISPATCH_LEASE_PENDING_FILE,
        );
        assert.equal(existsSync(pendingPath), true);
        const body = JSON.parse(readFileSync(pendingPath, "utf8")) as {
          ticketNumber: number;
          siteIdentity: string;
        };
        assert.equal(body.ticketNumber, 176);
        assert.equal(body.siteIdentity, "/site/demo");
        return "started";
      },
    });
    assert.equal(ignited, true);
    assert.equal(result, "started");
  });
});

test("second machine dispatch while pending exists throws HeldError before ignite", async () => {
  await withLedgerHome(async (ledgerHome) => {
    dispatchSelectedTicketRole({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
      ignite: () => undefined,
    });
    let ignited = false;
    assert.throws(
      () =>
        dispatchSelectedTicketRole({
          ledgerHome,
          bookKey: "demo-book",
          siteIdentity: "/site/other",
          ticketNumber: 177,
          ignite: () => {
            ignited = true;
          },
        }),
      (error: unknown) => error instanceof TicketDispatchLeaseHeldError,
    );
    assert.equal(ignited, false);
  });
});
