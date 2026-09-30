import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * ADR 0086 — Sitian log4j-style append-only:
 * Every attempt appends its row unconditionally; no sidecar claim files created.
 * Cross-process simultaneity is real concurrency — proven by a real run, not asserted here.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  appendSitianRecord,
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import {
  type SitianRecordInput,
} from "../../src/sitian-contracts.ts";
import { readSitianRecords } from "../../src/sitian-reader.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

async function withHermeticLedgerRoot<T>(
  run: (ctx: { home: string; cwd: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(worktreeTempPrefix("sitian-identity-claim-"));
  return withPrimaryAwareCleanup(
    async () => {
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      mkdirSync(cwd, { recursive: true });
      return await run({ home, cwd });
    },
    async () => {
      await rm(root, { recursive: true, force: true });
    },
  );
}

function volumeSurfaceNames(sessionDir: string, recordFile: string): string[] {
  const base = basename(recordFile);
  return readdirSync(sessionDir)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .sort();
}

test("repeated single-call attempts append unconditionally under log4j model: two rows, no sidecars", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const identity = "concurrent-same-identity-uniqueness";
    const kind = "identity-claim-concurrent-uniqueness";
    const sessionParent = join(home, ".ak-roles", "books", "cwd", "runs", "run", "session", "session.jsonl");
    mkdirSync(dirname(sessionParent), { recursive: true });
    const input: SitianRecordInput = {
      level: "event",
      kind,
      identity,
      home,
      cwd,
      sessionParent,
      payload: { marker: "parent-observe" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });

    // Real entry, deterministically sequenced: the second same-identity attempt
    // must still append its own row — no dedup, no read-back, no sidecar claim
    // file. Cross-process simultaneity is real concurrency, proven by a real run.
    for (const marker of ["child-a", "child-b"]) {
      const pointer = appendSitianRecord({ ...input, payload: { marker } });
      assert.equal(pointer.identity, identity);
    }

    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.filter((row) => row.identity === identity).length, 2);
    assert.deepEqual(volumeSurfaceNames(sessionDir, recordFile), [
      basename(recordFile),
    ]);
  });
});
