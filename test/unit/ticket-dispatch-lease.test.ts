import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const packageRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const tsxLoaderPath = createRequire(import.meta.url).resolve("tsx/esm");
const leaseModuleHref = pathToFileURL(join(packageRoot, "src/ticket-dispatch-lease.ts")).href;

async function withLedgerHome<T>(scenario: (ledgerHome: string, home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-ticket-lease-"));
  try {
    const ledgerHome = resolveActivationLedgerHome(() => home);
    return await scenario(ledgerHome, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function clearBookLeaseArtifacts(bookDir: string): void {
  if (!existsSync(bookDir)) return;
  for (const name of readdirSync(bookDir)) {
    if (name === DISPATCH_LEASE_PENDING_FILE || name.startsWith("dispatch-lease.claimed.")) {
      unlinkSync(join(bookDir, name));
    }
  }
}

function spawnNodeWorker(
  workerPath: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsxLoaderPath, workerPath, ...args],
      {
        cwd: packageRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

test("site mismatch via real claim does not swallow a newer pending offer", async () => {
  await withLedgerHome(async (ledgerHome, home) => {
    // Cross-process schedule through the real claim seam (no production yield):
    // 1) offer A (ticket 111 / site-A)
    // 2) offerer child hammers offer B against the real pending slot
    // 3) claimer child acquires A with wrong site (rename pending → exclusive path)
    // 4) offerer inserts B in the acquire→restore window
    // 5) claimer mismatch restore uses wx and must not clobber B
    // 6) B remains claimable
    const bookKey = "demo-book";
    const bookDir = activationBookDirectory(ledgerHome, bookKey);
    const pendingPath = join(bookDir, DISPATCH_LEASE_PENDING_FILE);
    const claimWorkerPath = join(home, "claim-worker.mjs");
    const offerWorkerPath = join(home, "offer-worker.mjs");
    writeFileSync(
      claimWorkerPath,
      `
import {
  claimTicketDispatchLease,
  TicketDispatchLeaseSiteMismatchError,
} from ${JSON.stringify(leaseModuleHref)};

try {
  claimTicketDispatchLease({
    ledgerHome: process.argv[2],
    bookKey: process.argv[3],
    siteIdentity: process.argv[4],
  });
  process.exit(0);
} catch (error) {
  process.exit(error instanceof TicketDispatchLeaseSiteMismatchError ? 2 : 1);
}
`,
    );
    writeFileSync(
      offerWorkerPath,
      `
import {
  offerTicketDispatchLease,
  TicketDispatchLeaseHeldError,
} from ${JSON.stringify(leaseModuleHref)};

const ledgerHome = process.argv[2];
const bookKey = process.argv[3];
const deadline = Date.now() + Number(process.argv[4] ?? "2000");
while (Date.now() < deadline) {
  try {
    offerTicketDispatchLease({
      ledgerHome,
      bookKey,
      siteIdentity: "/site-B",
      ticketNumber: 222,
    });
    process.stdout.write("OFFERED\\n");
    process.exit(0);
  } catch (error) {
    if (!(error instanceof TicketDispatchLeaseHeldError)) {
      console.error(error);
      process.exit(1);
    }
  }
}
process.stdout.write("TIMEOUT\\n");
process.exit(3);
`,
    );

    const maxAttempts = 40;
    let observedNoClobber = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      clearBookLeaseArtifacts(bookDir);
      offerTicketDispatchLease({
        ledgerHome,
        bookKey,
        siteIdentity: "/site-A",
        ticketNumber: 111,
      });

      // Start the offer hammer first so it is already looping when claim acquires.
      const offerDone = spawnNodeWorker(offerWorkerPath, [ledgerHome, bookKey, "2000"]);
      await delay(50);
      const claimDone = spawnNodeWorker(claimWorkerPath, [ledgerHome, bookKey, "/site-WRONG"]);
      const [offerResult, claimResult] = await Promise.all([offerDone, claimDone]);

      assert.equal(claimResult.code, 2, claimResult.stderr || claimResult.stdout);
      if (offerResult.code !== 0) {
        // Missed the acquire→restore window; retry the real concurrent schedule.
        continue;
      }
      assert.equal(offerResult.stdout.trim(), "OFFERED", offerResult.stderr);
      assert.equal(existsSync(pendingPath), true, "newer offer B must remain pending");

      const pendingBody = JSON.parse(readFileSync(pendingPath, "utf8")) as {
        ticketNumber: number;
        siteIdentity: string;
      };
      // Rename-over restore would put A back and clobber B — fail closed if seen.
      assert.equal(pendingBody.ticketNumber, 222, "claimer must not clobber newer offer B");
      assert.equal(pendingBody.siteIdentity, "/site-B");

      observedNoClobber = true;
      const claimed = claimTicketDispatchLease({
        ledgerHome,
        bookKey,
        siteIdentity: "/site-B",
        createCorrelationId: () => "corr-after-race",
      });
      assert.equal(claimed.ticketNumber, 222);
      assert.equal(claimed.siteIdentity, "/site-B");
      assert.equal(claimed.correlationId, "corr-after-race");
      break;
    }

    assert.equal(
      observedNoClobber,
      true,
      `failed to observe acquire→offer B→mismatch restore window in ${maxAttempts} cross-process attempts`,
    );
  });
});
