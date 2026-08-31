/**
 * Mid-tier: real git worktree + faux inspect JSON → classify HEAD provenance.
 * Host private-config-active / accept gates stay in unit (existing shortest contracts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectControlledGrok } from "../../src/grok/role-turn-host.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("inspectControlledGrok: HEAD match, case-fold, and same-byte symlink leave privateActive empty; dirty, different-byte symlink, untracked stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-head-match-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "test"]);
    const claudePath = join(root, "CLAUDE.md");
    const twinPath = join(root, "TWIN.md");
    const otherPath = join(root, "OTHER.md");
    const localPath = join(root, "CLAUDE.local.md");
    await writeFile(claudePath, "# shared law\n", "utf8");
    await writeFile(twinPath, "# shared law\n", "utf8");
    await writeFile(otherPath, "# other bytes\n", "utf8");
    git(root, ["add", "CLAUDE.md", "TWIN.md", "OTHER.md"]);
    git(root, ["commit", "-m", "seed"]);

    const packageRoot = join(root, "pkg");
    const skillPath = join(packageRoot, "resources", "methods", "tdd", "SKILL.md");
    await mkdir(join(packageRoot, "resources", "methods", "tdd"), { recursive: true });
    await writeFile(skillPath, "# tdd\n", "utf8");

    const faux = join(root, "grok-faux.mjs");
    await writeFile(faux, `#!/usr/bin/env node
const paths = JSON.parse(process.env.AK_FAUX_PROJECT_INSTRUCTIONS ?? "[]");
const skillPath = process.env.AK_FAUX_PACKAGE_SKILL_PATH;
process.stdout.write(JSON.stringify({
  skills: skillPath ? [{ name: "tdd", source: { type: "project", path: skillPath } }] : [],
  projectInstructions: paths.map((path) => ({ path, scope: "project" })),
}));
`, "utf8");
    await chmod(faux, 0o755);

    const envBase = { ...process.env, AK_FAUX_PACKAGE_SKILL_PATH: skillPath };
    const inspect = (paths: string[]) => inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: { ...envBase, AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify(paths) },
      packageRoot,
    });

    assert.deepEqual(await inspect([claudePath]), {
      privateActive: [],
      akActive: ["skills:tdd"],
    });
    assert.deepEqual((await inspect([join(root, "Claude.md")])).privateActive, []);

    // Same bytes via final-component symlink: still HEAD-carried path + matching read bytes.
    await unlink(claudePath);
    await symlink(twinPath, claudePath);
    assert.deepEqual((await inspect([claudePath])).privateActive, []);

    // Different bytes via symlink → private (local rewrite).
    await unlink(claudePath);
    await symlink(otherPath, claudePath);
    assert.deepEqual((await inspect([claudePath])).privateActive, [
      `projectInstructions:${claudePath}`,
    ]);

    await unlink(claudePath);
    await writeFile(claudePath, "# dirty\n", "utf8");
    await writeFile(localPath, "# local\n", "utf8");
    assert.deepEqual((await inspect([claudePath, localPath])).privateActive, [
      `projectInstructions:${claudePath}`,
      `projectInstructions:${localPath}`,
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
