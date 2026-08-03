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
import { withPrimaryAwareCleanup } from "./helpers/primary-aware-cleanup.ts";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args])).stdout.trim();
}

test("pinned base resolution ignores moved refs and accepts reachable full commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-pin-"));
  await withPrimaryAwareCleanup(async () => {
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
    await assert.rejects(reader.resolve("blob-base"), /base revision ref must resolve to a commit/);
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
    await assert.rejects(reader.resolve("new-live-name"), /base revision must name an existing pinned ref or reachable commit/);

    const ambiguous = await createReviewerPinnedGitReader(root);
    await git(root, "branch", "same", base); await git(root, "tag", "same", base);
    const withAliases = await createReviewerPinnedGitReader(root);
    await assert.rejects(withAliases.resolve("same"), /base revision is ambiguous across pinned refs/);
    await assert.rejects(ambiguous.resolve("HEAD:evil"), /base revision syntax is invalid or uses a forbidden revision form/);
  }, () => rm(root, { recursive: true, force: true }));
});

test("SHA-256 pins full and abbreviated commits, range, material, and ref snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-sha256-"));
  await withPrimaryAwareCleanup(async () => {
    try { await git(root, "init", "--object-format=sha256"); }
    catch (error) {
      const detail = error instanceof Error ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? "")}` : String(error);
      if (/sha.?256|object.?format|unsupported/i.test(detail)) { t.skip(`installed Git lacks SHA-256 repository support: ${detail}`); return; }
      throw error;
    }
    await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "file"), "base\n"); await git(root, "add", "."); await git(root, "commit", "-m", "base");
    const base = await git(root, "rev-parse", "HEAD"); await git(root, "branch", "review-base");
    await writeFile(join(root, "file"), "target\n"); await git(root, "commit", "-am", "target");
    const reader = await createReviewerPinnedGitReader(root);
    assert.equal(reader.pin.objectFormat, "sha256");
    assert.match(reader.pin.targetHead, /^[0-9a-f]{64}$/);
    assert.equal(await reader.resolve(base), base);
    assert.equal(await reader.resolve(base.slice(0, 8)), base);
    await assert.rejects(reader.resolve(base.slice(0, 40) + "g"), /base-invalid/);
    await assert.rejects(reader.resolve(base.slice(0, 40)), /base-invalid/);
    const range = await reader.range(base);
    assert.equal(range.base, base); assert.match(range.target, /^[0-9a-f]{64}$/); assert.deepEqual(range.commits, [reader.pin.targetHead]);
    assert.equal(Buffer.from(await reader.material("file", reader.pin.targetHead)).toString(), "target\n");
    assert.deepEqual(await reader.snapshot(), reader.pin);
    assert.equal(reader.pin.refs["refs/heads/review-base"]?.peeledCommitId, base);
  }, () => rm(root, { recursive: true, force: true }));
});

test("abbreviated bases are resolved only among commits reachable from the activation target", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-prefix-"));
  await withPrimaryAwareCleanup(async () => {
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
  }, () => rm(root, { recursive: true, force: true }));
});

test("pinning discovers and canonicalizes the worktree root from nested and symlinked cwd", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "reviewer-root-"));
  const root = join(temporary, "repository");
  const nested = join(root, "nested", "directory");
  const linked = join(temporary, "linked-repository");
  await withPrimaryAwareCleanup(async () => {
    await mkdir(nested, { recursive: true });
    await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "file"), "content\n"); await git(root, "add", "."); await git(root, "commit", "-m", "initial");
    await symlink(root, linked, "dir");
    const canonicalRoot = await realpath(root);
    assert.equal((await createReviewerPinnedGitReader(nested)).pin.repositoryRoot, canonicalRoot);
    assert.equal((await createReviewerPinnedGitReader(join(linked, "nested"))).pin.repositoryRoot, canonicalRoot);
  }, () => rm(temporary, { recursive: true, force: true }));
});

test("pinning rejects non-repositories and bare repositories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "reviewer-root-reject-"));
  const bare = join(temporary, "bare.git");
  await withPrimaryAwareCleanup(async () => {
    await assert.rejects(createReviewerPinnedGitReader(temporary));
    await git(temporary, "init", "--bare", bare);
    await assert.rejects(createReviewerPinnedGitReader(bare));
  }, () => rm(temporary, { recursive: true, force: true }));
});

test("material path safety rejects unsafe Git object paths at the concrete read seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-material-path-"));
  await withPrimaryAwareCleanup(async () => {
    await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "safe"), "content\n"); await git(root, "add", "."); await git(root, "commit", "-m", "initial");
    const reader = await createReviewerPinnedGitReader(root);
    const unsafe = [
      { path: "/absolute", diagnostic: /materials\.repositoryPath must be relative, not absolute/ },
      { path: "../escape", diagnostic: /materials\.repositoryPath must not contain .*parent-directory/ },
      { path: "dir/../escape", diagnostic: /materials\.repositoryPath must not contain .*parent-directory/ },
      { path: "bad\\path", diagnostic: /materials\.repositoryPath must not contain backslashes/ },
      { path: "bad\npath", diagnostic: /materials\.repositoryPath must not contain control characters/ },
    ];
    for (const { path, diagnostic } of unsafe) {
      await assert.rejects(reader.material(path, reader.pin.targetHead), diagnostic);
    }
    await assert.rejects(reader.material("missing", reader.pin.targetHead), /pinned material at materials\.repositoryPath is missing from the target/);
    assert.equal(Buffer.from(await reader.material("safe", reader.pin.targetHead)).toString(), "content\n");
  }, () => rm(root, { recursive: true, force: true }));
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
