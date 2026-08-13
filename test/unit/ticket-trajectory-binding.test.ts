import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ACCEPTED_ACTIVATION_EVENT } from "../../src/activation-ledger.ts";
import { DISPATCH_STUB_EVENT } from "../../src/activation-reconciliation.ts";
import {
  buildTicketTrajectoryBookIndex,
  loadTicketTrajectoryRuns,
  loadUnboundTrajectoryRuns,
} from "../../src/ticket-trajectory.ts";
import {
  TICKET_BINDING_EVENT,
  TicketRunAttributionError,
} from "../../src/ticket-dispatch-lease.ts";

async function withBookDir<T>(scenario: (ledgerDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-ticket-traj-"));
  try {
    return await scenario(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
}

async function seedFlatRun(ledgerDir: string, runFolder: string): Promise<string> {
  const runDir = join(ledgerDir, "runs", runFolder);
  const sessionDir = join(runDir, "session");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "session.jsonl");
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", timestamp: "2026-08-07T00:00:00.000Z" })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "invocation.json"),
    `${JSON.stringify({ role: "judge", runId: runFolder }, null, 2)}\n`,
    "utf8",
  );
  return sessionFile;
}

async function seedLegacyRun(ledgerDir: string, issueNumber: number, runId: string): Promise<void> {
  const runDir = join(ledgerDir, "issues", String(issueNumber), "runs", runId);
  const sessionDir = join(runDir, "session");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "session.jsonl"),
    `${JSON.stringify({ type: "session", timestamp: "2026-08-07T00:00:01.000Z" })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "invocation.json"),
    `${JSON.stringify({ role: "coder", runId }, null, 2)}\n`,
    "utf8",
  );
}

test("binding + activation + flat run is included for that ticket", async () => {
  await withBookDir(async (ledgerDir) => {
    const runFolder = "01jrun@judge";
    const sessionFile = await seedFlatRun(ledgerDir, runFolder);
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.000Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 176,
        correlation: { kind: "caller", id: "corr-flat-1" },
      },
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "judge",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: sessionFile },
        correlation: { kind: "caller", id: "corr-flat-1" },
      },
    ]);
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === runFolder), true);
  });
});

test("same flat run without binding is isolated (not joined, not board-wide error)", async () => {
  await withBookDir(async (ledgerDir) => {
    const runFolder = "01jrun@judge";
    const sessionFile = await seedFlatRun(ledgerDir, runFolder);
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "judge",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: sessionFile },
        correlation: { kind: "caller", id: "corr-unbound-1" },
      },
    ]);
    // Unbound activations never join any ticket and never poison empty tickets.
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.length, 0);
    assert.equal(runs.some((run) => run.runId === runFolder), false);
    // Honest unknown-seam exposure: unbound fact is visible via book index / loader.
    const index = buildTicketTrajectoryBookIndex(ledgerDir);
    assert.equal(index.unboundActivations.length, 1);
    assert.equal(index.unboundActivations[0]?.correlation.kind, "caller");
    const unbound = await loadUnboundTrajectoryRuns(ledgerDir, index);
    assert.equal(unbound.length, 1);
    assert.equal(unbound[0]?.run.runId, runFolder);
    assert.equal(unbound[0]?.correlationId, "corr-unbound-1");
  });
});

test("doctor activation without ticket-binding is not unbound", async () => {
  await withBookDir(async (ledgerDir) => {
    const runFolder = "01jrun@doctor";
    const sessionFile = await seedFlatRun(ledgerDir, runFolder);
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "doctor",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: sessionFile },
        correlation: { kind: "absent" },
      },
    ]);
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.length, 0);
  });
});

test("legacy issues/<n>/runs is still included", async () => {
  await withBookDir(async (ledgerDir) => {
    await seedLegacyRun(ledgerDir, 176, "legacy-coder-1");
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === "legacy-coder-1"), true);
  });
});

test("legacy issues/<n>/runs is listed even when another activation is unbound", async () => {
  await withBookDir(async (ledgerDir) => {
    await seedLegacyRun(ledgerDir, 176, "legacy-coder-1");
    const sessionFile = await seedFlatRun(ledgerDir, "01jrun@judge");
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "judge",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: sessionFile },
        correlation: { kind: "caller", id: "corr-other-unbound" },
      },
    ]);
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === "legacy-coder-1"), true);
    assert.equal(runs.some((run) => run.runId === "01jrun@judge"), false);
  });
});

test("ticket load does not fail when another activation is unbound", async () => {
  await withBookDir(async (ledgerDir) => {
    const boundSession = await seedFlatRun(ledgerDir, "01bound@judge");
    const otherSession = await seedFlatRun(ledgerDir, "01other@fixer");
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.000Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 176,
        correlation: { kind: "caller", id: "corr-bound-176" },
      },
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "judge",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: boundSession },
        correlation: { kind: "caller", id: "corr-bound-176" },
      },
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "fixer",
        observedAt: "2026-08-07T00:00:00.200Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: otherSession },
        correlation: { kind: "caller", id: "corr-unbound-other" },
      },
    ]);
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === "01bound@judge"), true);
    assert.equal(runs.some((run) => run.runId === "01other@fixer"), false);
  });
});

test("empty ticket is not poisoned by unrelated unbound activations", async () => {
  await withBookDir(async (ledgerDir) => {
    const sessionFile = await seedFlatRun(ledgerDir, "01jrun@judge");
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "judge",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: sessionFile },
        correlation: { kind: "caller", id: "corr-unbound-other" },
      },
    ]);
    // Ticket 177 has nothing of its own; unbound activation must not throw or join.
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 177);
    assert.equal(runs.length, 0);
    // Unbound remains visible on the book unknown surface.
    const unbound = await loadUnboundTrajectoryRuns(ledgerDir);
    assert.equal(unbound.some((item) => item.correlationId === "corr-unbound-other"), true);
  });
});

test("dispatch-only binding appears on the ticket before activation", async () => {
  await withBookDir(async (ledgerDir) => {
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.000Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 176,
        correlation: { kind: "caller", id: "corr-dispatch-only" },
      },
      {
        event: DISPATCH_STUB_EVENT,
        observedAt: "2026-08-07T00:00:00.050Z",
        bookKey: "demo-book",
        dispatch: { kind: "process", pid: 4242 },
        correlation: { kind: "caller", id: "corr-dispatch-only" },
      },
    ]);
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.runId, "dispatch:corr-dispatch-only");
    assert.equal(runs[0]?.hasResult, false);
    assert.equal(runs[0]?.startedAt, "2026-08-07T00:00:00.050Z");
    // Other tickets do not inherit the dispatch-only run.
    const other = await loadTicketTrajectoryRuns(ledgerDir, 177);
    assert.equal(other.length, 0);
  });
});

test("book index is reusable across tickets without re-scanning semantics", async () => {
  await withBookDir(async (ledgerDir) => {
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.000Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 176,
        correlation: { kind: "caller", id: "corr-a" },
      },
      {
        event: DISPATCH_STUB_EVENT,
        observedAt: "2026-08-07T00:00:00.050Z",
        bookKey: "demo-book",
        dispatch: { kind: "process", pid: 1 },
        correlation: { kind: "caller", id: "corr-a" },
      },
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 177,
        correlation: { kind: "caller", id: "corr-b" },
      },
      {
        event: DISPATCH_STUB_EVENT,
        observedAt: "2026-08-07T00:00:00.150Z",
        bookKey: "demo-book",
        dispatch: { kind: "process", pid: 2 },
        correlation: { kind: "caller", id: "corr-b" },
      },
    ]);
    const index = buildTicketTrajectoryBookIndex(ledgerDir);
    assert.equal(index.bindings.length, 2);
    assert.equal(index.dispatchStubs.length, 2);
    // Book-level lookups are pre-built for direct per-ticket consume.
    assert.equal(index.bindingsByTicket.get(176)?.length, 1);
    assert.equal(index.bindingsByTicket.get(177)?.length, 1);
    assert.equal(index.stubsByCorrelation.get("corr-a")?.length, 1);
    assert.equal(index.stubsByCorrelation.get("corr-b")?.length, 1);
    assert.equal(index.unboundActivations.length, 0);
    const a = await loadTicketTrajectoryRuns(ledgerDir, 176, index);
    const b = await loadTicketTrajectoryRuns(ledgerDir, 177, index);
    assert.equal(a.some((run) => run.runId === "dispatch:corr-a"), true);
    assert.equal(b.some((run) => run.runId === "dispatch:corr-b"), true);
  });
});

test("two tickets binding the same correlation are ambiguous", async () => {
  await withBookDir(async (ledgerDir) => {
    const runFolder = "01jrun@judge";
    const sessionFile = await seedFlatRun(ledgerDir, runFolder);
    await writeJsonl(join(ledgerDir, "waiting.jsonl"), [
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.000Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 176,
        correlation: { kind: "caller", id: "corr-shared" },
      },
      {
        event: TICKET_BINDING_EVENT,
        observedAt: "2026-08-07T00:00:00.001Z",
        bookKey: "demo-book",
        siteIdentity: "/site/demo",
        ticketNumber: 177,
        correlation: { kind: "caller", id: "corr-shared" },
      },
      {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: "judge",
        observedAt: "2026-08-07T00:00:00.100Z",
        bookKey: "demo-book",
        session: { kind: "session-file", path: sessionFile },
        correlation: { kind: "caller", id: "corr-shared" },
      },
    ]);
    await assert.rejects(
      () => loadTicketTrajectoryRuns(ledgerDir, 176),
      (error: unknown) =>
        error instanceof TicketRunAttributionError && error.kind === "ambiguous",
    );
  });
});
