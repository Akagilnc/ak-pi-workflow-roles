import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { DISPATCH_STUB_EVENT } from "../../src/activation-reconciliation.ts";
import {
  claimTicketDispatchLease,
  DISPATCH_LEASE_PENDING_FILE,
  listTicketBindingFacts,
  offerTicketDispatchLease,
  TICKET_BINDING_EVENT,
  TicketDispatchLeaseHeldError,
  TicketDispatchLeaseMissingError,
  TicketDispatchLeaseSiteMismatchError,
} from "../../src/ticket-dispatch-lease.ts";

async function withLedgerHome<T>(scenario: (ledgerHome: string, home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-ticket-lease-"));
  try {
    const ledgerHome = resolveActivationLedgerHome(() => home);
    return await scenario(ledgerHome, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("offer then claim yields unique correlation, consumes pending, writes binding + stub", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    const pendingPath = join(activationBookDirectory(ledgerHome, "demo-book"), DISPATCH_LEASE_PENDING_FILE);
    assert.equal(existsSync(pendingPath), true);

    const claimed = claimTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      createCorrelationId: () => "corr-opaque-1",
      pid: 4242,
    });
    assert.equal(claimed.ticketNumber, 176);
    assert.equal(claimed.bookKey, "demo-book");
    assert.equal(claimed.siteIdentity, "/site/demo");
    assert.equal(claimed.correlationId, "corr-opaque-1");
    assert.notEqual(claimed.correlationId, String(176));
    assert.equal(existsSync(pendingPath), false);

    const waiting = await readFile(
      join(activationBookDirectory(ledgerHome, "demo-book"), "waiting.jsonl"),
      "utf8",
    );
    const rows = waiting
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.event, TICKET_BINDING_EVENT);
    assert.equal(rows[0]?.ticketNumber, 176);
    assert.deepEqual(rows[0]?.correlation, { kind: "caller", id: "corr-opaque-1" });
    assert.equal(rows[1]?.event, DISPATCH_STUB_EVENT);
    assert.deepEqual(rows[1]?.correlation, { kind: "caller", id: "corr-opaque-1" });

    const listed = listTicketBindingFacts(ledgerHome, "demo-book");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ticketNumber, 176);
    assert.equal(listed[0]?.correlation.id, "corr-opaque-1");
  });
});

test("claim with no lease fails loudly", async () => {
  await withLedgerHome(async (ledgerHome) => {
    assert.throws(
      () =>
        claimTicketDispatchLease({
          ledgerHome,
          bookKey: "demo-book",
          siteIdentity: "/site/demo",
        }),
      (error: unknown) => error instanceof TicketDispatchLeaseMissingError,
    );
  });
});

test("second offer while pending exists fails loudly", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    assert.throws(
      () =>
        offerTicketDispatchLease({
          ledgerHome,
          bookKey: "demo-book",
          siteIdentity: "/site/other",
          ticketNumber: 177,
        }),
      (error: unknown) => error instanceof TicketDispatchLeaseHeldError,
    );
  });
});

test("sequential double-claim: one success, one fail", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    const first = claimTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
    });
    assert.ok(first.correlationId.length > 0);
    assert.throws(
      () =>
        claimTicketDispatchLease({
          ledgerHome,
          bookKey: "demo-book",
          siteIdentity: "/site/demo",
        }),
      (error: unknown) =>
        error instanceof TicketDispatchLeaseMissingError ||
        error instanceof TicketDispatchLeaseHeldError,
    );
  });
});

test("site mismatch fails loudly and restores pending for the correct site", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    assert.throws(
      () =>
        claimTicketDispatchLease({
          ledgerHome,
          bookKey: "demo-book",
          siteIdentity: "/site/other",
        }),
      (error: unknown) => error instanceof TicketDispatchLeaseSiteMismatchError,
    );
    const pendingPath = join(activationBookDirectory(ledgerHome, "demo-book"), DISPATCH_LEASE_PENDING_FILE);
    assert.equal(existsSync(pendingPath), true);
    const claimed = claimTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      createCorrelationId: () => "corr-after-mismatch",
    });
    assert.equal(claimed.correlationId, "corr-after-mismatch");
    assert.equal(claimed.ticketNumber, 176);
  });
});

test("generated correlation is not the ticket number string", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    const claimed = claimTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
    });
    assert.notEqual(claimed.correlationId, "176");
    assert.notEqual(claimed.correlationId, String(claimed.ticketNumber));
    assert.ok(claimed.correlationId.length > 0);
  });
});

test("claim reads the exclusive acquired object (no shared claimed sidecar)", async () => {
  await withLedgerHome(async (ledgerHome) => {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      ticketNumber: 176,
    });
    const bookDir = activationBookDirectory(ledgerHome, "demo-book");
    const pendingPath = join(bookDir, DISPATCH_LEASE_PENDING_FILE);
    assert.equal(existsSync(pendingPath), true);

    const claimed = claimTicketDispatchLease({
      ledgerHome,
      bookKey: "demo-book",
      siteIdentity: "/site/demo",
      createCorrelationId: () => "corr-exclusive-1",
    });
    assert.equal(claimed.correlationId, "corr-exclusive-1");
    assert.equal(claimed.ticketNumber, 176);
    assert.equal(existsSync(pendingPath), false);
    // No shared dispatch-lease.claimed.json sidecar remains.
    assert.equal(existsSync(join(bookDir, "dispatch-lease.claimed.json")), false);
  });
});
