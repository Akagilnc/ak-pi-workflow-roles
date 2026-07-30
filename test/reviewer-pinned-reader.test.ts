import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createReviewerPinnedGitReader, isReviewerPromptIdentity, reviewerPromptIdentity } from "../src/reviewer-dispatch.ts";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args])).stdout.trim();
}

test("pinned base resolution ignores moved refs and accepts reachable full commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-pin-"));
  try {
    await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "file"), "base\n"); await git(root, "add", "."); await git(root, "commit", "-m", "base");
    const base = await git(root, "rev-parse", "HEAD"); await git(root, "branch", "review-base", base);
    await writeFile(join(root, "file"), "target\n"); await git(root, "commit", "-am", "target");
    const reader = await createReviewerPinnedGitReader(root);
    await git(root, "branch", "-f", "review-base", "HEAD");
    assert.equal(await reader.resolve("review-base"), base);
    assert.equal(await reader.resolve(base), base);
    await assert.rejects(reader.resolve("new-live-name"), /pinned ref map/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared prompt identity validates exact UTF-8 bytes, length, and SHA-256", () => {
  const identity = reviewerPromptIdentity("逐字 prompt\n");
  assert.equal(isReviewerPromptIdentity(identity), true);
  assert.equal(isReviewerPromptIdentity({ ...identity, utf8Length: identity.utf8Length + 1 }), false);
  assert.equal(isReviewerPromptIdentity({ ...identity, bytes: `${identity.bytes}x` }), false);
  assert.throws(() => (identity as { bytes: string }).bytes = "changed");
});
