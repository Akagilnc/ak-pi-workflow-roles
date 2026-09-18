/**
 * #855 ghost legs: admitted|running + writer lease autopsy → typed report facts.
 * Does not mutate run-state or directories.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { scanAnalystIssueRuns } from "../../src/analyst-ledger.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function seedGhostRun(input: {
  readonly home: string;
  readonly book: string;
  readonly runId: string;
  readonly role: string;
  readonly state: "admitted" | "running" | "terminal";
  readonly projectRoot: string;
  readonly ticketNumber?: number;
  readonly lock?: string | null;
}): Promise<string> {
  const runDirectory = join(
    input.home,
    ".ak-roles",
    "books",
    input.book,
    input.ticketNumber === undefined ? "unbound" : String(input.ticketNumber),
    "runs",
    `${input.runId}@${input.role}`,
  );
  await mkdir(join(runDirectory, "session"), { recursive: true });
  await writeFile(
    join(runDirectory, "run-state.json"),
    `${JSON.stringify({
      runId: input.runId,
      role: input.role,
      state: input.state,
      bookKey: input.book,
      projectRoot: input.projectRoot,
      runDirectory,
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
      sessionDirectory: join(runDirectory, "session"),
      sessionFile: join(runDirectory, "session", "session.jsonl"),
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runDirectory, "invocation.json"),
    `${JSON.stringify({
      projectRoot: input.projectRoot,
      ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
    })}\n`,
    "utf8",
  );
  if (input.lock !== undefined && input.lock !== null) {
    await writeFile(join(runDirectory, "writer.lock"), input.lock, "utf8");
  }
  return runDirectory;
}

test("analyst scan lists dead-holder and no-lease ghosts; keeps live holders out; leaves disk intact", async () => {
  await withTempRoot("ak-ghost-legs-", async (home) => {
    const book = "ghost-book";
    const projectRoot = join(home, "repo");
    await mkdir(projectRoot, { recursive: true });
    // Seed a git common-dir so book identity is stable if anything resolves it.
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const deadRun = "01a0ghost0-dead-7000-8000-000000000001";
    const noLeaseRun = "01a0ghost0-nole-7000-8000-000000000002";
    const liveRun = "01a0ghost0-live-7000-8000-000000000003";
    const terminalRun = "01a0ghost0-term-7000-8000-000000000004";
    const badLockRun = "01a0ghost0-badl-7000-8000-000000000005";

    const deadDir = await seedGhostRun({
      home, book, runId: deadRun, role: "judge", state: "running",
      projectRoot, ticketNumber: 855, lock: "999999999",
    });
    const noLeaseDir = await seedGhostRun({
      home, book, runId: noLeaseRun, role: "countersign", state: "admitted",
      projectRoot, ticketNumber: 855, lock: null,
    });
    await seedGhostRun({
      home, book, runId: liveRun, role: "judge", state: "running",
      projectRoot, ticketNumber: 855, lock: String(process.pid),
    });
    await seedGhostRun({
      home, book, runId: terminalRun, role: "judge", state: "terminal",
      projectRoot, ticketNumber: 855, lock: "999999999",
    });
    await seedGhostRun({
      home, book, runId: badLockRun, role: "judge", state: "admitted",
      projectRoot, ticketNumber: 855, lock: "not-a-pid",
    });

    const scan = await scanAnalystIssueRuns({
      bookKey: book,
      ticketNumber: 855,
      home,
    });

    const byId = new Map(scan.ghostLegs.map((g) => [g.runId, g]));
    assert.equal(byId.has(liveRun), false, "live holder must not be listed");
    assert.equal(byId.has(terminalRun), false, "terminal is not a ghost candidate");

    assert.deepEqual(byId.get(deadRun), {
      runId: deadRun,
      role: "judge",
      runState: "running",
      leaseCheck: { kind: "holder-dead", pid: 999999999 },
    });
    assert.deepEqual(byId.get(noLeaseRun), {
      runId: noLeaseRun,
      role: "countersign",
      runState: "admitted",
      leaseCheck: { kind: "no-lease" },
    });
    assert.deepEqual(byId.get(badLockRun), {
      runId: badLockRun,
      role: "judge",
      runState: "admitted",
      leaseCheck: { kind: "unverifiable", reason: "unparseable" },
    });

    // Disk unchanged — package does not settle or delete for the caller.
    assert.equal(
      JSON.parse(await readFile(join(deadDir, "run-state.json"), "utf8")).state,
      "running",
    );
    assert.equal(
      JSON.parse(await readFile(join(noLeaseDir, "run-state.json"), "utf8")).state,
      "admitted",
    );
  });
});
