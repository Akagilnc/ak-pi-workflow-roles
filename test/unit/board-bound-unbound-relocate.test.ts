/**
 * #863 stock: board-typed unbound runs relocate in place via the shared
 * rewrite seam; true-unbound (no board ticket) stays put.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { relocateBoardBoundUnboundRunsInBook } from "../../src/book-topology-runs-migrator.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function seedUnboundRun(
  bookDir: string,
  leaf: string,
  ticketNumber: number | undefined,
): Promise<string> {
  const runDir = join(bookDir, "unbound", "runs", leaf);
  await mkdir(join(runDir, "session"), { recursive: true });
  const page = {
    runDirectory: runDir,
    ...(ticketNumber === undefined ? {} : { ticketNumber }),
  };
  await writeFile(
    join(runDir, "admitted-request.json"),
    `${JSON.stringify(page, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "invocation.json"),
    `${JSON.stringify(page, null, 2)}\n`,
    "utf8",
  );
  return runDir;
}

test("board-bound unbound run relocates under its typed ticket", async () => {
  await withTempRoot("ak-863-stock-reloc-", async (home) => {
    const bookDir = join(home, ".ak-roles", "books", "demo-book");
    const leaf = "01a086300-0000-7000-8000-00000000judge@judge";
    const source = await seedUnboundRun(bookDir, leaf, 970);
    const relocated = await relocateBoardBoundUnboundRunsInBook(bookDir);
    assert.equal(relocated.length, 1);
    assert.equal(relocated[0]!.ticketNumber, 970);
    assert.equal(relocated[0]!.from, source);
    const target = join(bookDir, "970", "runs", leaf);
    assert.equal(relocated[0]!.to, target);
    const admitted = JSON.parse(
      await readFile(join(target, "admitted-request.json"), "utf8"),
    ) as { runDirectory?: string; ticketNumber?: number };
    assert.equal(admitted.ticketNumber, 970);
    assert.equal(admitted.runDirectory, target);
  });
});

test("true-unbound run without board ticket stays under unbound", async () => {
  await withTempRoot("ak-863-stock-keep-", async (home) => {
    const bookDir = join(home, ".ak-roles", "books", "demo-book");
    const leaf = "01a086300-0000-7000-8000-00000000free@fixer";
    const source = await seedUnboundRun(bookDir, leaf, undefined);
    const relocated = await relocateBoardBoundUnboundRunsInBook(bookDir);
    assert.deepEqual(relocated, []);
    const admitted = JSON.parse(
      await readFile(join(source, "admitted-request.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(admitted.ticketNumber, undefined);
  });
});
