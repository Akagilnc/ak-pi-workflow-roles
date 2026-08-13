import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ACCEPTED_ACTIVATION_EVENT } from "../../src/activation-ledger.ts";
import { loadTicketTrajectoryRuns } from "../../src/ticket-trajectory.ts";
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

test("same flat run without binding is loud unbound", async () => {
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
    await assert.rejects(
      () => loadTicketTrajectoryRuns(ledgerDir, 176),
      (error: unknown) =>
        error instanceof TicketRunAttributionError && error.kind === "unbound",
    );
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
