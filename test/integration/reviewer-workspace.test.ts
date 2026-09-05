import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import { createReviewerWorkspaceOwner } from "../../src/reviewer-workspace.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(worktreeTempPrefix("ak-reviewer-workspace-test-"));
  git(root, "init");
  git(root, "config", "user.name", "Reviewer Test");
  git(root, "config", "user.email", "reviewer@example.invalid");
  await writeFile(join(root, "tracked.txt"), "pinned\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "pinned target");
  const targetHead = git(root, "rev-parse", "HEAD^{commit}");
  return {
    root,
    targetHead,
    target: {
      repositoryRoot: root,
      objectFormat: git(root, "rev-parse", "--show-object-format") as "sha1" | "sha256",
      targetHead,
      refs: {},
    },
  };
}

test("Reviewer workspace ignores a sibling ref created after pin read", async () => {
  const fixture = await repositoryFixture();
  const owner = createReviewerWorkspaceOwner({
    fault(operation) {
      if (operation === "mirror.before-create") {
        git(fixture.root, "update-ref", "refs/heads/sibling-writer", fixture.targetHead);
      }
    },
  });
  try {
    const batch = await owner.prepare(fixture.target, ["standards"]);
    assert.equal(git(batch.workspaces[0]!.path, "rev-parse", "HEAD^{commit}"), fixture.targetHead);
    assert.equal(git(batch.workspaces[0]!.path, "branch", "--list", "sibling-writer"), "");
    await owner.dispose(batch.workspaces[0]!);
  } finally {
    await owner.shutdown();
  }
});

test("Reviewer workspace rejects a changed target HEAD", async () => {
  const fixture = await repositoryFixture();
  const owner = createReviewerWorkspaceOwner({
    fault(operation) {
      if (operation === "snapshot.head") {
        execFileSync("git", ["-C", fixture.root, "commit", "--allow-empty", "-m", "new target"]);
      }
    },
  });
  try {
    await assert.rejects(
      owner.prepare(fixture.target, ["standards"]),
      /target identity no longer matches/,
    );
  } finally {
    await owner.shutdown();
  }
});
