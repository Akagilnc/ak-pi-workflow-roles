import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolveAuditDossier } from "../../src/dossier-resolution.ts";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

// Judge subject pre-check deleted with createPiJudgeAuditor (#756); gate officers self-fetch.
// Keep concurrent isolation contract for the shared AK_ROLE_RUN_DIR pointer.

test("concurrent pointers keep two runs from crossing dossiers", async () => {
  await withTempRoot("ak-dossier-concurrent-", async (root) => {
  const previous = process.env.AK_ROLE_RUN_DIR;
    return withPrimaryAwareCleanup(
      async () => {

    const runA = join(root, "run-a");
    const runB = join(root, "run-b");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(runA);
    await mkdir(runB);

    process.env.AK_ROLE_RUN_DIR = runA;
    const a = resolveAuditDossier();
    process.env.AK_ROLE_RUN_DIR = runB;
    const b = resolveAuditDossier();

    assert.equal(a.status, "ok");
    assert.equal(b.status, "ok");
    if (a.status === "ok" && b.status === "ok") {
      assert.equal(a.runDirectory, runA);
      assert.equal(b.runDirectory, runB);
      assert.notEqual(a.runDirectory, b.runDirectory);
    }
        },
      async () => { if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous; }
    );
  });
});
