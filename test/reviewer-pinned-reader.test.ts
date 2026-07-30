import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    await assert.rejects(reader.resolve("blob-base"), /base-invalid/);
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
    await assert.rejects(reader.resolve("new-live-name"), /base-invalid/);

    const ambiguous = await createReviewerPinnedGitReader(root);
    await git(root, "branch", "same", base); await git(root, "tag", "same", base);
    const withAliases = await createReviewerPinnedGitReader(root);
    await assert.rejects(withAliases.resolve("same"), /base-invalid/);
    await assert.rejects(ambiguous.resolve("HEAD:evil"), /base-invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("abbreviated bases are resolved only among commits reachable from the activation target", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-prefix-"));
  try {
    await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "file"), "base\n"); await git(root, "add", "."); await git(root, "commit", "-m", "base");
    const base = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "file"), "target\n"); await git(root, "commit", "-am", "target");
    const reader = await createReviewerPinnedGitReader(root);
    const prefix = base.slice(0, 4);
    assert.equal(await reader.resolve(prefix), base);

    let collision: Buffer | undefined;
    for (let index = 0; collision === undefined; index++) {
      const candidate = Buffer.from(`unreachable-${index}`);
      const header = Buffer.from(`blob ${candidate.length}\0`);
      if (createHash("sha1").update(header).update(candidate).digest("hex").startsWith(prefix)) collision = candidate;
    }
    const collisionPath = join(root, "collision");
    await writeFile(collisionPath, collision);
    const collisionId = await git(root, "hash-object", "-w", collisionPath);
    assert.equal(collisionId.startsWith(prefix), true);
    assert.equal(await reader.resolve(prefix), base);

    const tree = await git(root, "rev-parse", "HEAD^{tree}");
    let parent = reader.pin.targetHead;
    const prefixes = new Map<string, string>();
    let ambiguousPrefix: string | undefined;
    for (let index = 0; index < 1200 && ambiguousPrefix === undefined; index++) {
      parent = execFileSync("git", ["-C", root, "commit-tree", tree, "-p", parent], { input: `reachable-${index}\n`, encoding: "utf8" }).trim();
      const candidatePrefix = parent.slice(0, 4);
      if (prefixes.has(candidatePrefix)) ambiguousPrefix = candidatePrefix;
      else prefixes.set(candidatePrefix, parent);
    }
    assert.ok(ambiguousPrefix, "expected a four-hex collision among reachable commits");
    await git(root, "update-ref", "HEAD", parent);
    const ambiguousReader = await createReviewerPinnedGitReader(root);
    await assert.rejects(ambiguousReader.resolve(ambiguousPrefix), /base-invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pinning discovers and canonicalizes the worktree root from nested and symlinked cwd", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "reviewer-root-"));
  const root = join(temporary, "repository");
  const nested = join(root, "nested", "directory");
  const linked = join(temporary, "linked-repository");
  try {
    await mkdir(nested, { recursive: true });
    await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "file"), "content\n"); await git(root, "add", "."); await git(root, "commit", "-m", "initial");
    await symlink(root, linked, "dir");
    const canonicalRoot = await realpath(root);
    assert.equal((await createReviewerPinnedGitReader(nested)).pin.repositoryRoot, canonicalRoot);
    assert.equal((await createReviewerPinnedGitReader(join(linked, "nested"))).pin.repositoryRoot, canonicalRoot);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("pinning rejects non-repositories and bare repositories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "reviewer-root-reject-"));
  const bare = join(temporary, "bare.git");
  try {
    await assert.rejects(createReviewerPinnedGitReader(temporary));
    await git(temporary, "init", "--bare", bare);
    await assert.rejects(createReviewerPinnedGitReader(bare));
  } finally { await rm(temporary, { recursive: true, force: true }); }
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
  assert.equal(isReviewerPromptIdentity({ ...identity, text: `${identity.text}x` }), false);
  assert.throws(() => (identity as { text: string }).text = "changed");
});
