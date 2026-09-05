import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import {
  buildTicketTrajectoryBookIndex,
  loadTicketTrajectoryRuns,
  loadUnboundTrajectoryRuns,
} from "../../src/ticket-trajectory.ts";

async function withBookDir<T>(scenario: (ledgerDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(worktreeTempPrefix("ak-ticket-traj-"));
  try {
    return await scenario(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedFlatRun(
  ledgerDir: string,
  runFolder: string,
  options?: { ticketNumber?: number; role?: string },
): Promise<string> {
  const runDir = join(ledgerDir, "runs", runFolder);
  const sessionDir = join(runDir, "session");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "session.jsonl");
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", timestamp: "2026-08-07T00:00:00.000Z" })}\n`,
    "utf8",
  );
  const invocation: Record<string, unknown> = {
    role: options?.role ?? "judge",
    runId: runFolder,
  };
  if (options?.ticketNumber !== undefined) {
    invocation.ticketNumber = options.ticketNumber;
  }
  await writeFile(
    join(runDir, "invocation.json"),
    `${JSON.stringify(invocation, null, 2)}\n`,
    "utf8",
  );
  return runDir;
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

test("flat run with typed invocation ticketNumber is included for that ticket", async () => {
  await withBookDir(async (ledgerDir) => {
    const runFolder = "01jrun@judge";
    await seedFlatRun(ledgerDir, runFolder, { ticketNumber: 176 });
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === runFolder), true);
    // Other tickets do not inherit the bound flat run.
    const other = await loadTicketTrajectoryRuns(ledgerDir, 177);
    assert.equal(other.some((run) => run.runId === runFolder), false);
  });
});

test("flat run without ticketNumber is isolated unbound (not joined, not board-wide error)", async () => {
  await withBookDir(async (ledgerDir) => {
    const runFolder = "01jrun@judge";
    await seedFlatRun(ledgerDir, runFolder);
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.length, 0);
    assert.equal(runs.some((run) => run.runId === runFolder), false);
    const index = await buildTicketTrajectoryBookIndex(ledgerDir);
    assert.equal(index.unboundRuns.length, 1);
    assert.equal(index.unboundRuns[0]?.runFolder, runFolder);
    const unbound = await loadUnboundTrajectoryRuns(ledgerDir, index);
    assert.equal(unbound.length, 1);
    assert.equal(unbound[0]?.run.runId, runFolder);
  });
});

test("legacy issues/<n>/runs is still included", async () => {
  await withBookDir(async (ledgerDir) => {
    await seedLegacyRun(ledgerDir, 176, "legacy-coder-1");
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === "legacy-coder-1"), true);
  });
});

// Unbound isolation matrix: an unrelated unbound flat run must not pollute any
// ticket view — legacy topology, another ticket's bound load, and empty tickets.
test("unrelated unbound flat runs stay isolated from every ticket view", async () => {
  // Row 1: legacy issues/<n>/runs is listed even when another flat run is unbound.
  await withBookDir(async (ledgerDir) => {
    await seedLegacyRun(ledgerDir, 176, "legacy-coder-1");
    await seedFlatRun(ledgerDir, "01jrun@judge");
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === "legacy-coder-1"), true);
    assert.equal(runs.some((run) => run.runId === "01jrun@judge"), false);
  });

  // Row 2: a bound flat-run ticket load does not fail or absorb the unbound run.
  await withBookDir(async (ledgerDir) => {
    await seedFlatRun(ledgerDir, "01bound@judge", { ticketNumber: 176 });
    await seedFlatRun(ledgerDir, "01other@fixer", { role: "fixer" });
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 176);
    assert.equal(runs.some((run) => run.runId === "01bound@judge"), true);
    assert.equal(runs.some((run) => run.runId === "01other@fixer"), false);
  });

  // Row 3: empty ticket not poisoned by unrelated unbound runs.
  await withBookDir(async (ledgerDir) => {
    await seedFlatRun(ledgerDir, "01jrun@judge");
    const runs = await loadTicketTrajectoryRuns(ledgerDir, 177);
    assert.equal(runs.length, 0);
    const unbound = await loadUnboundTrajectoryRuns(ledgerDir);
    assert.equal(unbound.some((item) => item.run.runId === "01jrun@judge"), true);
  });
});

test("book index is reusable across tickets without re-scanning semantics", async () => {
  await withBookDir(async (ledgerDir) => {
    await seedFlatRun(ledgerDir, "01a@judge", { ticketNumber: 176 });
    await seedFlatRun(ledgerDir, "01b@fixer", { ticketNumber: 177, role: "fixer" });
    const index = await buildTicketTrajectoryBookIndex(ledgerDir);
    assert.equal(index.runsByTicket.get(176)?.length, 1);
    assert.equal(index.runsByTicket.get(177)?.length, 1);
    assert.equal(index.unboundRuns.length, 0);
    const a = await loadTicketTrajectoryRuns(ledgerDir, 176, index);
    const b = await loadTicketTrajectoryRuns(ledgerDir, 177, index);
    assert.equal(a.some((run) => run.runId === "01a@judge"), true);
    assert.equal(b.some((run) => run.runId === "01b@fixer"), true);
  });
});
