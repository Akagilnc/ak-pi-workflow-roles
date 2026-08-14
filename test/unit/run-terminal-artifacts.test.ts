/**
 * Reader face for publisher durable terminal artifacts.
 * T10: parent-directory unique error.<uuid>.json must bind body.runId to the
 * requested run directory — sibling fallbacks must not cross-adopt.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRunTerminalArtifact } from "../../src/run-terminal-artifacts.ts";

async function withTempRunsRoot<T>(
  scenario: (runsRoot: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-run-terminal-"));
  try {
    const runsRoot = join(root, "runs");
    await mkdir(runsRoot, { recursive: true });
    return await scenario(runsRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
