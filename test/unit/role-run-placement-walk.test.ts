import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("optional runs slot ENOTDIR is empty; subject-tree still walks", async () => {
  await withTempRoot("ak-rrp-walk-", async (root) => {
    const bookDir = join(root, "book");
    await mkdir(bookDir, { recursive: true });
    await writeFile(join(bookDir, "runs"), "not-a-directory\n", "utf8");
    const subjectRun = join(bookDir, "582", "runs", "01jsub@judge");
    await mkdir(subjectRun, { recursive: true });
    assert.deepEqual(await listBookRunDirectories(bookDir), [subjectRun]);
  });
});

test("book-root ENOTDIR stays loud (damaged topology, not empty book)", async () => {
  await withTempRoot("ak-rrp-book-root-", async (root) => {
    const bookAsFile = join(root, "book-file");
    await writeFile(bookAsFile, "not-a-book-dir\n", "utf8");
    await assert.rejects(
      () => listBookRunDirectories(bookAsFile),
      (error: NodeJS.ErrnoException) => error.code === "ENOTDIR",
    );
  });
});
