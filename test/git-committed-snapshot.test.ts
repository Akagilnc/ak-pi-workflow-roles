import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGitCommittedSnapshot } from "../src/stats-line.ts";

function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function repository(format: "sha1" | "sha256") {
  const root = mkdtempSync(join(tmpdir(), `ak-stats-${format}-`));
  execFileSync("git", ["init", `--object-format=${format}`, root]);
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "file.txt"), "content\n"); git(root, "add", "file.txt"); git(root, "commit", "-m", "fixture");
  return { root, commit: git(root, "rev-parse", "HEAD"), blob: git(root, "rev-parse", "HEAD:file.txt") };
}

for (const format of ["sha1", "sha256"] as const) test(`Git committed snapshot admits an exact ${format} commit`, async (t) => {
  let repo: ReturnType<typeof repository>;
  try { repo = repository(format); } catch (error) { if (format === "sha256") { t.skip("installed Git lacks SHA-256 repositories"); return; } throw error; }
  const snapshot = createGitCommittedSnapshot({ repositoryRoot: repo.root, repository: "ak/repo", targetCommit: repo.commit });
  assert.deepEqual(await snapshot.list("."), ["file.txt"]);
  assert.equal(new TextDecoder().decode(await snapshot.read("file.txt")), "content\n");
});

test("Git committed snapshot synchronously rejects noncanonical identities", () => {
  for (const identity of ["a".repeat(39), "a".repeat(41), "g".repeat(40), `-${"a".repeat(39)}`, "A".repeat(40)])
    assert.throws(() => createGitCommittedSnapshot({ repositoryRoot: "/unused", repository: "ak/repo", targetCommit: identity }), /lowercase full Git object identity/);
});

test("Git committed snapshot rejects format mismatch and non-commit objects before tree reads", async () => {
  const repo = repository("sha1");
  const mismatch = createGitCommittedSnapshot({ repositoryRoot: repo.root, repository: "ak/repo", targetCommit: "a".repeat(64) });
  await assert.rejects(mismatch.list(""), /width does not match/);
  const blob = createGitCommittedSnapshot({ repositoryRoot: repo.root, repository: "ak/repo", targetCommit: repo.blob });
  await assert.rejects(blob.read("file.txt"), /exact commit object/);
});
