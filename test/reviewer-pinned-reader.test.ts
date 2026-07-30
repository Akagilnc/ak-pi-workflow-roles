import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { isReviewerPromptIdentity, reviewerPromptIdentity } from "../src/reviewer-dispatch.ts";
import { createReviewerPinnedGitReader } from "../src/reviewer-pinned-git.ts";
import { immutableReviewerRefs, sameReviewerRefs } from "../src/reviewer-git-snapshot.ts";

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
    await git(root, "tag", "-a", "review-tag", base, "-m", "annotated");
    const blob = await git(root, "rev-parse", "HEAD:file");
    await git(root, "update-ref", "refs/tags/blob-base", blob);
    const target = await git(root, "rev-parse", "HEAD");
    const reader = await createReviewerPinnedGitReader(root);
    const pinnedTagObject = await git(root, "rev-parse", "review-tag^{object}");
    assert.deepEqual(reader.pin.refs["refs/tags/review-tag"], { objectId: pinnedTagObject, peeledCommitId: base });
    assert.deepEqual(reader.pin.refs["refs/tags/blob-base"], { objectId: blob, peeledCommitId: null });
    await assert.rejects(reader.resolve("blob-base"), /does not identify a commit/);
    await git(root, "branch", "-f", "review-base", "HEAD");
    await git(root, "tag", "-f", "review-tag", "HEAD");
    assert.equal(await reader.resolve("review-base"), base);
    assert.equal(await reader.resolve("review-tag"), base);
    assert.deepEqual(reader.pin.refs["refs/tags/review-tag"], { objectId: pinnedTagObject, peeledCommitId: base });
    assert.equal(await reader.resolve(base), base);
    assert.equal(await reader.resolve(base.slice(0, 8)), base);
    assert.equal(await reader.resolve("HEAD~1"), base);
    assert.equal(await reader.resolve("HEAD^1"), base);
    assert.equal(reader.pin.targetHead, target);
    await assert.rejects(reader.resolve("new-live-name"), /pinned ref map/);

    const ambiguous = await createReviewerPinnedGitReader(root);
    await git(root, "branch", "same", base); await git(root, "tag", "same", base);
    const withAliases = await createReviewerPinnedGitReader(root);
    await assert.rejects(withAliases.resolve("same"), /ambiguous/);
    await assert.rejects(ambiguous.resolve("HEAD:evil"), /Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared ref snapshot helper canonicalizes immutably and compares order-independently", () => {
  const refs = immutableReviewerRefs({ "refs/tags/z": { objectId: "2", peeledCommitId: "2" }, "refs/heads/a": { objectId: "1", peeledCommitId: "1" } });
  assert.deepEqual(Object.keys(refs), ["refs/heads/a", "refs/tags/z"]);
  assert.equal(sameReviewerRefs(refs, { "refs/tags/z": { objectId: "2", peeledCommitId: "2" }, "refs/heads/a": { objectId: "1", peeledCommitId: "1" } }), true);
  assert.equal(sameReviewerRefs(refs, { "refs/heads/a": { objectId: "different", peeledCommitId: "different" } }), false);
  assert.throws(() => (refs as unknown as Record<string, string>)["refs/heads/a"] = "changed");
});

test("shared prompt identity validates exact UTF-8 bytes, length, and SHA-256", () => {
  const identity = reviewerPromptIdentity("逐字 prompt\n");
  assert.equal(isReviewerPromptIdentity(identity), true);
  assert.equal(isReviewerPromptIdentity({ ...identity, utf8Length: identity.utf8Length + 1 }), false);
  assert.equal(isReviewerPromptIdentity({ ...identity, bytes: `${identity.bytes}x` }), false);
  assert.throws(() => (identity as { bytes: string }).bytes = "changed");
});
