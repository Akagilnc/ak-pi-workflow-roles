/**
 * #412 r3 — failure honesty at the single projectRoot→bookKey true source.
 * Only "Git cannot adjudicate this root" may become the synthetic `root:` key
 * (absent/non-directory root, or ActivationGitRepositoryRequiredError from a
 * git child that ran). Git infrastructure failures (missing binary → ENOENT)
 * must stay loud — never washed into a valid book key.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { resolveTaishiBookKey } from "../../src/taishi-book-key.ts";

test("resolveTaishiBookKey: absent projectRoot keeps the established synthetic root: identity", () => {
  const absent = join(tmpdir(), `taishi-book-key-absent-${process.pid}-${Date.now()}`);
  assert.equal(resolveTaishiBookKey(absent), `root:${physicalPathIdentity(absent)}`);
});

test("resolveTaishiBookKey: plain file mid-path (ENOTDIR) is the same cannot-be-a-repo fallback, not infrastructure", () => {
  const parent = mkdtempSync(join(tmpdir(), "taishi-book-key-"));
  const filePath = join(parent, "file");
  const child = join(filePath, "child");
  try {
    writeFileSync(filePath, "plain file", "utf8");
    // statSync on file/child throws ENOTDIR — structurally no Git repository can
    // exist there, so it joins ENOENT on the root:<identity> fallback face.
    assert.equal(resolveTaishiBookKey(child), `root:${physicalPathIdentity(child)}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveTaishiBookKey: git executable unavailable stays loud ENOENT, never a root: key", () => {
  const dir = mkdtempSync(join(tmpdir(), "taishi-book-key-"));
  const realPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.throws(
      () => resolveTaishiBookKey(dir),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    process.env.PATH = realPath;
  }
  rmSync(dir, { recursive: true, force: true });
});
