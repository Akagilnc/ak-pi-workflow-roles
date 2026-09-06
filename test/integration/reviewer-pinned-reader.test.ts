import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { createReviewerPinnedGitReader } from "../../src/reviewer-pinned-git.ts";
import { immutableReviewerRefs } from "../../src/reviewer-git-snapshot.ts";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args])).stdout.trim();
}

/** One seeded repo template; cases cp -R into independent mkdtemps. */
let seededTemplateRoot: string | undefined;
let seededTemplateMemo: Promise<string> | undefined;
async function seededTemplate(): Promise<string> {
  seededTemplateMemo ??= (async () => {
    const root = await mkdtemp(worktreeTempPrefix("reviewer-pin-template-"));
    seededTemplateRoot = root;
    await git(root, "init");
    await git(root, "config", "maintenance.auto", "false");
    await git(root, "config", "gc.auto", "0");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await writeFile(join(root, "file"), "base\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    return root;
  })();
  return seededTemplateMemo;
}

after(async () => {
  if (seededTemplateRoot === undefined) return;
  const root = seededTemplateRoot;
  seededTemplateRoot = undefined;
  await rm(root, { recursive: true, force: true });
});

async function withMaterializedRepo<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const template = await seededTemplate();
  return withTempRoot(prefix, async (root) => {
    await cp(template, root, { recursive: true });
    return body(root);
  });
}

test("pinned base resolution ignores moved refs and accepts reachable full commits", async () => {
  await withMaterializedRepo("reviewer-pin-", async (root) => {
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
  });
});

test("SHA-256 pins full and abbreviated commits, range, and ref snapshots", async (t) => {
  await withTempRoot("reviewer-sha256-", async (root) => {
    try { await git(root, "init", "--object-format=sha256"); }
    catch { t.skip("installed Git lacks SHA-256 repository support"); return; }
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
    assert.deepEqual(await reader.snapshot(), reader.pin);
    assert.equal(reader.pin.refs["refs/heads/review-base"]?.peeledCommitId, base);
    });
});

test("abbreviated bases are resolved only among commits reachable from the activation target", async () => {
  await withMaterializedRepo("reviewer-prefix-", async (root) => {
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

    const parent = reader.pin.targetHead;
    const parts: string[] = [];
    for (let index = 0; index < 1200; index++) {
      const message = `reachable-${index}\n`;
      parts.push(
        "commit refs/heads/collision-chain\n" +
          `mark :${index + 1}\n` +
          `committer Test <test@example.com> ${1_700_000_000 + index} +0000\n` +
          `data ${Buffer.byteLength(message)}\n` +
          message +
          (index === 0 ? `from ${parent}\n` : `from :${index}\n`) +
          "\n",
      );
    }
    execFileSync("git", ["-C", root, "fast-import", "--quiet", "--date-format=raw"], {
      input: parts.join(""),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const chain = execFileSync("git", ["-C", root, "rev-list", "collision-chain"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    const prefixes = new Map<string, string>();
    let ambiguousPrefix: string | undefined;
    for (const sha of [...chain].reverse()) {
      const candidatePrefix = sha.slice(0, 4);
      if (prefixes.has(candidatePrefix)) {
        ambiguousPrefix = candidatePrefix;
        break;
      }
      prefixes.set(candidatePrefix, sha);
    }
    assert.ok(ambiguousPrefix, "expected a four-hex collision among reachable commits");
    await git(root, "update-ref", "HEAD", chain[0]!);
    const ambiguousReader = await createReviewerPinnedGitReader(root);
    await assert.rejects(ambiguousReader.resolve(ambiguousPrefix), /base-invalid/);
  });
});

test("pinning discovers and canonicalizes the worktree root from nested and symlinked cwd", async () => {
  await withTempRoot("reviewer-root-", async (temporary) => {
  const root = join(temporary, "repository");
  const nested = join(root, "nested", "directory");
  const linked = join(temporary, "linked-repository");

    await mkdir(nested, { recursive: true });
    const template = await seededTemplate();
    await cp(template, root, { recursive: true });
    await symlink(root, linked, "dir");
    const canonicalRoot = await realpath(root);
    assert.equal((await createReviewerPinnedGitReader(nested)).pin.repositoryRoot, canonicalRoot);
    assert.equal((await createReviewerPinnedGitReader(join(linked, "nested"))).pin.repositoryRoot, canonicalRoot);
    });
});

test("pinning rejects non-repositories and bare repositories", async () => {
  await withTempRoot("reviewer-root-reject-", async (temporary) => {
  const nonRepo = join(temporary, "non-repo");
  const bare = join(temporary, "bare.git");

    await mkdir(nonRepo, { recursive: true });
    // Worktree-local fixture sits under the package git tree; plant an invalid
    // .git file so discovery cannot walk up to the monorepo (#685 C4).
    await writeFile(join(nonRepo, ".git"), "not-a-git-repository\n");
    await assert.rejects(createReviewerPinnedGitReader(nonRepo));
    await git(temporary, "init", "--bare", bare);
    await assert.rejects(createReviewerPinnedGitReader(bare));
    });
});

test("shared ref snapshot helper canonicalizes refs immutably", () => {
  const refs = immutableReviewerRefs({ "refs/tags/z": { objectId: "2", peeledCommitId: "2" }, "refs/heads/a": { objectId: "1", peeledCommitId: "1" } });
  assert.deepEqual(Object.keys(refs), ["refs/heads/a", "refs/tags/z"]);
  assert.throws(() => (refs as unknown as Record<string, string>)["refs/heads/a"] = "changed");
});

test("pinned reader: origin/commit messages/readPinnedText for Spec self-fetch", async () => {
  const { branchNamesAtPinnedHead, parseGitHubOriginRemote } = await import("../../src/reviewer-pinned-git.ts");
  assert.deepEqual(parseGitHubOriginRemote("git@github.com:Acme/widgets.git"), {
    owner: "Acme",
    repo: "widgets",
  });
  assert.deepEqual(parseGitHubOriginRemote("https://github.com/Acme/widgets.git"), {
    owner: "Acme",
    repo: "widgets",
  });
  assert.equal(parseGitHubOriginRemote("https://gitlab.com/Acme/widgets.git"), undefined);

  await withMaterializedRepo("reviewer-pin-self-fetch-", async (root) => {
    const base = await git(root, "rev-parse", "HEAD");
    await mkdir(join(root, "docs", "adr"), { recursive: true });
    await writeFile(join(root, "docs", "adr", "0001-x.md"), "# ADR\nbody\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "feat: land #88 with adr");
    const beforeRemote = await createReviewerPinnedGitReader(root);
    // Confirmed no origin ⇒ self-fetch unavailable.
    assert.equal(await beforeRemote.originRepository(), undefined);

    // Issue-shaped tag + branch at HEAD: featureTokens may include both; branch ticket source is heads/remotes only.
    await git(root, "branch", "fix/issue-99-release");
    await git(root, "tag", "fix/issue-12-tag");
    await git(root, "remote", "add", "origin", "git@github.com:Acme/widgets.git");
    await git(root, "update-ref", "refs/remotes/origin/fix/issue-55-remote", "HEAD");
    // Reader is pinned at construction; re-create after ref/remote mutations.
    const reader = await createReviewerPinnedGitReader(root);

    const tokens = await reader.featureTokens();
    assert.equal(tokens.includes("fix/issue-99-release"), true);
    assert.equal(tokens.includes("fix/issue-12-tag"), true);
    assert.equal(tokens.includes("fix/issue-55-remote"), true);
    const branchNames = branchNamesAtPinnedHead(reader.pin);
    assert.equal(branchNames.includes("fix/issue-99-release"), true);
    assert.equal(branchNames.includes("fix/issue-55-remote"), true);
    // Tag must never enter branch-ticket provenance even when it points at targetHead.
    assert.equal(branchNames.includes("fix/issue-12-tag"), false);

    assert.deepEqual(await reader.originRepository(), { owner: "Acme", repo: "widgets" });

    const messages = await reader.commitMessagesNewestFirst(base);
    assert.equal(messages[0], "feat: land #88 with adr");

    assert.equal(await reader.readPinnedText("docs/adr/0001-x.md"), "# ADR\nbody\n");
    // Confirmed path-at-pinned-tree absence ⇒ missing (not a blanket exit-128 wash).
    assert.equal(await reader.readPinnedText("docs/adr/missing.md"), undefined);
    assert.equal(await reader.readPinnedText("../escape"), undefined);

    // Non-absence Git failure (repo dir gone) must keep true cause — not pretend unavailable/missing.
    // Barrier .git file: without it, discovery walks into the monorepo under this worktree.
    await rename(join(root, ".git"), join(root, ".git-hidden"));
    await writeFile(join(root, ".git"), "not-a-git-repository\n");
    await assert.rejects(() => reader.originRepository(), /git process failed/);
    await assert.rejects(() => reader.readPinnedText("docs/adr/0001-x.md"), /git process failed/);
  });
});

test("pinned reader: execGit pins LC_ALL=C so soft-degrade classifiers stay English", async () => {
  await withMaterializedRepo("reviewer-pin-locale-", async (root) => {
    await mkdir(join(root, "docs", "adr"), { recursive: true });
    await writeFile(join(root, "docs", "adr", "0001-x.md"), "# ADR\nbody\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "adr");

    const shimDir = await mkdtemp(worktreeTempPrefix("reviewer-git-lc-shim-"));
    const lcLog = join(shimDir, "lc_all.log");
    const realGit = (await exec("which", ["git"])).stdout.trim();
    assert.ok(realGit.length > 0);
    const shimPath = join(shimDir, "git");
    await writeFile(
      shimPath,
      [
        "#!/bin/sh",
        `printf '%s\n' "\${LC_ALL-}" >> ${JSON.stringify(lcLog)}`,
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(shimPath, 0o755);

    const previousPath = process.env.PATH;
    const previousLcAll = process.env.LC_ALL;
    const previousLang = process.env.LANG;
    const previousLcMessages = process.env.LC_MESSAGES;
    await withPrimaryAwareCleanup(
      async () => {
        process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
        // Hostile process locale must not leak into the sole Git diagnostic seam.
        process.env.LC_ALL = "zh_CN.UTF-8";
        process.env.LANG = "zh_CN.UTF-8";
        process.env.LC_MESSAGES = "zh_CN.UTF-8";

        const reader = await createReviewerPinnedGitReader(root);
        // Confirmed missing origin still soft-degrades under hostile locale.
        assert.equal(await reader.originRepository(), undefined);
        // Confirmed missing pinned path still soft-degrades under hostile locale.
        assert.equal(await reader.readPinnedText("docs/adr/missing.md"), undefined);

        const logged = (await readFile(lcLog, "utf8")).trim().split("\n").filter((line) => line.length > 0);
        assert.ok(logged.length > 0);
        assert.equal(logged.every((line) => line === "C"), true);
      },
      async () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      },
      async () => {
        if (previousLcAll === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = previousLcAll;
      },
      async () => {
        if (previousLang === undefined) delete process.env.LANG;
        else process.env.LANG = previousLang;
      },
      async () => {
        if (previousLcMessages === undefined) delete process.env.LC_MESSAGES;
        else process.env.LC_MESSAGES = previousLcMessages;
      },
      async () => {
        await rm(shimDir, { recursive: true, force: true });
      },
    );
  });
});
