/**
 * Reader face for publisher durable terminal artifacts.
 * T10: parent-directory unique error.<uuid>.json must bind body.runId to the
 * requested run directory — sibling fallbacks must not cross-adopt.
 * #953: multi-face currentness follows publish contract (failure over success),
 * not filesystem mtime.
 */
import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { readRunTerminalArtifact } from "../../src/run-terminal-artifacts.ts";

async function withTempRunsRoot<T>(
  scenario: (runsRoot: string) => Promise<T>,
): Promise<T> {
  return await withTempRoot("ak-run-terminal-", async (root) => {
    const runsRoot = join(root, "runs");
    await mkdir(runsRoot, { recursive: true });
    return await scenario(runsRoot);
    });
}

function uniqueErrorName(uuid: string): string {
  return `error.${uuid}.json`;
}

test("parent-dir unique error fallback binds body.runId — sibling runs do not cross-adopt", async () => {
  await withTempRunsRoot(async (runsRoot) => {
    const runA = "019ff000-7a01-7000-8000-0000000007a1";
    const runB = "019ff000-7a02-7000-8000-0000000007a2";
    const dirA = join(runsRoot, `${runA}@coder`);
    const dirB = join(runsRoot, `${runB}@coder`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    // Sibling A durable failure landed only under the shared parent (runs/).
    const siblingFallback = join(
      runsRoot,
      uniqueErrorName("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    await writeFile(
      siblingFallback,
      `${JSON.stringify({
        kind: "error",
        role: "coder",
        runId: runA,
        cause: "provider",
        diagnostic: "sibling-A durable failure",
      }, null, 2)}\n`,
      "utf8",
    );

    // Target B must not adopt A's parent unique fallback.
    const beforeOwn = await readRunTerminalArtifact(dirB);
    assert.equal(
      beforeOwn.status,
      "absent",
      "sibling parent unique error must not bind to another run",
    );

    // Target B's own parent unique fallback remains readable via runId binding.
    const ownFallback = join(
      runsRoot,
      uniqueErrorName("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );
    await writeFile(
      ownFallback,
      `${JSON.stringify({
        kind: "error",
        role: "coder",
        runId: runB,
        cause: "provider",
        diagnostic: "target-B durable failure",
      }, null, 2)}\n`,
      "utf8",
    );

    const own = await readRunTerminalArtifact(dirB);
    assert.equal(own.status, "present");
    if (own.status !== "present") return;
    assert.equal(own.file, "error.json");
    assert.equal(own.path, ownFallback);
    assert.equal(own.body.runId, runB);
    assert.equal(own.body.diagnostic, "target-B durable failure");

    // Same-run path ownership still accepts unique fallback under runDirectory
    // without requiring a parent scan (and without sibling interference).
    const sameRunName = uniqueErrorName("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const sameRunPath = join(dirA, sameRunName);
    await writeFile(
      sameRunPath,
      `${JSON.stringify({
        kind: "error",
        role: "coder",
        runId: runA,
        cause: "provider",
        diagnostic: "same-run directory unique fallback",
      }, null, 2)}\n`,
      "utf8",
    );
    const sameRun = await readRunTerminalArtifact(dirA);
    assert.equal(sameRun.status, "present");
    if (sameRun.status !== "present") return;
    assert.equal(sameRun.path, sameRunPath);
  });
});

test("#953 reader prefers failure face over residual success even when report mtime is newer", async () => {
  await withTempRunsRoot(async (runsRoot) => {
    const runId = "019ff000-9531-7000-8000-000000009531";
    const runDirectory = join(runsRoot, `${runId}@judge`);
    const artifactsDir = join(runDirectory, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const reportPath = join(artifactsDir, "report.json");
    await writeFile(
      reportPath,
      `${JSON.stringify({
        role: "judge",
        runId,
        outcome: {
          kind: "accepted",
          role: "judge",
          payloads: [{ judgeStatus: "continue" }],
        },
      })}\n`,
      "utf8",
    );
    // Spoof a future mtime — must not outrank the current failure face.
    const future = new Date("2100-01-01T00:00:00.000Z");
    await utimes(reportPath, future, future);

    const failurePath = join(runDirectory, "error.settlement.json");
    await writeFile(
      failurePath,
      `${JSON.stringify({
        kind: "error",
        role: "judge",
        runId,
        diagnostic: "CURRENT FAILURE",
        cause: "provider",
      })}\n`,
      "utf8",
    );

    const read = await readRunTerminalArtifact(runDirectory);
    assert.equal(read.status, "present");
    if (read.status !== "present") return;
    assert.equal(read.path, failurePath);
    assert.equal(read.body.diagnostic, "CURRENT FAILURE");
    assert.notEqual(
      (read.body.outcome as { kind?: string } | undefined)?.kind,
      "accepted",
    );
  });
});
