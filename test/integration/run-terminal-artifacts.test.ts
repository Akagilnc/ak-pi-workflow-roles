/**
 * Reader face for the leg's terminal: the `terminal` section of current.json
 * (#1161). Seeded raw, the way an outside writer would leave it; read through
 * readRunTerminal. #953 failure-over-success currentness (a later write replaces
 * an earlier one) is covered at the real settlement seam in
 * public-cli-failure-artifacts.test.ts — do not parallel-prove it here.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { seedCurrentSection, seedTerminal } from "../helpers/run-dossier-fixture.ts";

import { readRunTerminal } from "../../src/run-terminal-artifacts.ts";

async function withTempRunsRoot<T>(
  scenario: (runsRoot: string) => Promise<T>,
): Promise<T> {
  return await withTempRoot("ak-run-terminal-", async (root) => {
    const runsRoot = join(root, "runs");
    await mkdir(runsRoot, { recursive: true });
    return await scenario(runsRoot);
  });
}

test("the terminal is read per run directory: absent until written, each face present, siblings never adopt it", async () => {
  await withTempRunsRoot(async (runsRoot) => {
    const runA = "019ff000-7a01-7000-8000-0000000007a1";
    const runB = "019ff000-7a02-7000-8000-0000000007a2";
    const dirA = join(runsRoot, `${runA}@coder`);
    const dirB = join(runsRoot, `${runB}@coder`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    // No current.json at all, and a current.json with no terminal section, are both absent.
    assert.deepEqual(readRunTerminal(dirA), { status: "absent" });
    seedCurrentSection(dirA, "invocation", { role: "coder", runId: runA });
    assert.deepEqual(readRunTerminal(dirA), { status: "absent" });

    // A failure terminal on A is read as A's, and B stays absent.
    const errorBody = { kind: "error", role: "coder", runId: runA, cause: "provider", diagnostic: "sibling-A durable failure" };
    seedTerminal(dirA, "error", errorBody);
    assert.deepEqual(readRunTerminal(dirA), { status: "present", face: "error", body: errorBody });
    assert.deepEqual(readRunTerminal(dirB), { status: "absent" }, "a sibling run's terminal must not bind to another run");

    // Each face reads back as written; the last write wins (no clearing logic).
    const reportBody = { role: "coder", runId: runB, outcome: { kind: "accepted", role: "coder" } };
    seedTerminal(dirB, "report", reportBody);
    assert.deepEqual(readRunTerminal(dirB), { status: "present", face: "report", body: reportBody });
    const noReceiptBody = { role: "coder", runId: runB, outcome: { kind: "no_receipt", role: "coder", status: "no-accepted-receipt", decisiveFacts: {} } };
    seedTerminal(dirB, "no_receipt", noReceiptBody);
    assert.deepEqual(readRunTerminal(dirB), { status: "present", face: "no_receipt", body: noReceiptBody });
    // A's earlier failure is untouched by B's writes.
    assert.equal(readRunTerminal(dirA).status, "present");
  });
});

test("a terminal section without a known face, a typed object body or a producer role is unreadable; a damaged current.json is not swallowed", async () => {
  await withTempRunsRoot(async (runsRoot) => {
    const dir = join(runsRoot, "019ff000-7a03-7000-8000-0000000007a3@coder");
    await mkdir(dir, { recursive: true });
    const unreadable = (face: string, body: unknown) => {
      seedCurrentSection(dir, "terminal", { face, at: "2026-08-01T00:00:00.000Z", body });
      return readRunTerminal(dir);
    };
    for (const [face, body] of [
      ["retired-face", { role: "coder" }],
      ["report", "not an object"],
      ["report", null],
      ["report", ["role"]],
      ["error", { kind: "error" }],
      ["error", { role: "  " }],
      ["no_receipt", { role: 7 }],
    ] as const) {
      const read = unreadable(face, body);
      assert.equal(read.status, "unreadable", `${face} ${JSON.stringify(body)}`);
      if (read.status === "unreadable") assert.ok(read.reason.trim().length > 0);
    }
    await writeFile(join(dir, "current.json"), "{ not json", "utf8");
    assert.throws(() => readRunTerminal(dir));
  });
});
