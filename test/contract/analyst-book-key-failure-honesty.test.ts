import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #412 r4 + #413 r2 — failure honesty at the single projectRoot→bookKey true source.
 * A *confirmed* no-repository verdict keeps the r4-adjudicated synthetic `root:`
 * fallback: absent/non-directory root, ENOTDIR mid-path, and an existing plain
 * directory that git itself rejects with "not a git repository". Unconfirmed
 * git failures — dubious ownership exit 128 and any other diagnostic that does
 * not certify "non repository" (#413 r2 U5) — must stay loud with their real
 * cause, never washed into a valid book identity. Git infrastructure failures
 * (missing binary → ENOENT) stay loud too.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { resolveAnalystBookKey } from "../../src/analyst-book-key.ts";

test("resolveAnalystBookKey: absent projectRoot keeps the established synthetic root: identity", () => {
  const absent = worktreeTempPrefix(`analyst-book-key-absent-${process.pid}-${Date.now()}`);
  assert.equal(resolveAnalystBookKey(absent), `root:${physicalPathIdentity(absent)}`);
});

test("resolveAnalystBookKey: plain file mid-path (ENOTDIR) is the same cannot-be-a-repo fallback, not infrastructure", () => {
  const parent = mkdtempSync(worktreeTempPrefix("analyst-book-key-"));
  const filePath = join(parent, "file");
  const child = join(filePath, "child");
  try {
    writeFileSync(filePath, "plain file", "utf8");
    // statSync on file/child throws ENOTDIR — structurally no Git repository can
    // exist there, so it joins ENOENT on the root:<identity> fallback face.
    assert.equal(resolveAnalystBookKey(child), `root:${physicalPathIdentity(child)}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveAnalystBookKey: git executable unavailable stays loud ENOENT, never a root: key", () => {
  const dir = mkdtempSync(worktreeTempPrefix("analyst-book-key-"));
  const realPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.throws(
      () => resolveAnalystBookKey(dir),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    process.env.PATH = realPath;
  }
});

test("resolveAnalystBookKey: existing plain non-git directory keeps the established root: fallback (r4-adjudicated face)", () => {
  // A real existing directory that is not a Git repository: git rev-parse exits
  // nonzero with its own "not a git repository" diagnostic — a *confirmed*
  // no-repo verdict at the single classification owner — so the legitimate
  // `root:<identity>` fallback applies exactly as adjudicated in r4.
  const dir = mkdtempSync(worktreeTempPrefix("analyst-book-key-"));
  try {
    assert.equal(resolveAnalystBookKey(dir), `root:${physicalPathIdentity(dir)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAnalystBookKey: dubious-ownership exit 128 stays loud with its real cause, never a root: key (#413 r2 U5)", () => {
  // Dubious ownership shares exit 128 with the non-repo verdict but is NOT a
  // no-repo certification — git found a repository-shaped situation and refused
  // to adjudicate it. The single classification owner marks it unconfirmed, so
  // Analyst must not synthesize a book identity behind the failure's back.
  // Stable counterexample: a PATH-injected git emitting the real diagnostic.
  const dir = mkdtempSync(worktreeTempPrefix("analyst-book-key-"));
  const bin = mkdtempSync(worktreeTempPrefix("analyst-book-key-bin-"));
  const fakeGit = join(bin, "git");
  writeFileSync(
    fakeGit,
    '#!/bin/sh\nprintf \'fatal: detected dubious ownership in repository at "%s"\\n\' "$PWD" >&2\nexit 128\n',
    "utf8",
  );
  chmodSync(fakeGit, 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath ?? ""}`;
  try {
    assert.throws(
      () => resolveAnalystBookKey(dir),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ActivationGitRepositoryRequiredError");
        assert.ok(
          error.message.includes("dubious ownership"),
          "the real git cause must ride the loud carrier",
        );
        assert.equal(
          (error as { confirmedNonRepository?: boolean }).confirmedNonRepository,
          false,
          "dubious ownership must stay unconfirmed — never the root: fallback face",
        );
        return true;
      },
      "unconfirmed git failure must propagate loudly, not become a synthetic key",
    );
  } finally {
    process.env.PATH = realPath;
  }
});
