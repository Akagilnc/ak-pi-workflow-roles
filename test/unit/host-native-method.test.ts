/**
 * #922 host-native method delivery (stable workspace catalog + pack plugin).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertHermesProjectSkillsTrusted,
  ensurePackagedMethodPlugin,
  installWorkspaceAgentsSkillsLink,
  parseHermesTrustedProjectDirs,
  packagedMethodPluginDir,
  packagedMethodsDir,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

const execFileAsync = promisify(execFile);

test("#922 workspace .agents/skills: create-if-absent, stable across release, foreign/conflict", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-agents-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  const linkPath = join(cwd, ".agents", "skills");
  try {
    const a = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(a.created, true);
    assert.equal(await realpath(a.path), methods);
    const b = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(b.created, false);
    await a.release();
    await b.release();
    // Stable catalog: still present after release (concurrent-safe; no ephemeral delete).
    assert.equal(await realpath(linkPath), methods);

    await rm(linkPath, { force: true });
    await mkdir(linkPath, { recursive: true });
    await writeFile(join(linkPath, "keep.txt"), "x");
    await assert.rejects(() => installWorkspaceAgentsSkillsLink({ cwd, packageRoot }), /pre-existing directory/);
    assert.equal(await readFile(join(linkPath, "keep.txt"), "utf8"), "x");

    await rm(linkPath, { recursive: true, force: true });
    await symlink(methods, linkPath);
    const foreign = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(foreign.created, false);
    await foreign.release();
    assert.equal(await realpath(linkPath), methods);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 hermes trusted_project_dirs exact paths; comments/unrelated keys fail", async () => {
  assert.deepEqual(
    [...parseHermesTrustedProjectDirs("skills:\n  trusted_project_dirs:\n    - /tmp/trusted\n")],
    ["/tmp/trusted"],
  );
  assert.deepEqual(
    [...parseHermesTrustedProjectDirs("skills:\n  # trusted_project_dirs:\n  #   - /tmp/fake\n  other: /tmp/fake\n")],
    [],
  );
  const home = await mkdtemp(worktreeTempPrefix("ak-922-hermes-home-"));
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-hermes-cwd-"));
  try {
    await mkdir(join(cwd, ".git"));
    const root = await realpath(cwd);
    await mkdir(join(home, ".hermes"), { recursive: true });
    await writeFile(join(home, ".hermes", "config.yaml"), `skills:\n  # do not trust ${root}\n  trusted_project_dirs: []\n`);
    await assert.rejects(
      () => assertHermesProjectSkillsTrusted({ home, cwd, profileName: "ak-fixer" }),
      /not trusted|skills trust/,
    );
    await writeFile(join(home, ".hermes", "config.yaml"), `skills:\n  trusted_project_dirs:\n    - ${root}\n`);
    await assertHermesProjectSkillsTrusted({ home, cwd, profileName: "ak-fixer" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 method-host-plugin: runtime reads build output; missing fails loud", async () => {
  await execFileAsync(process.execPath, [join(packageRoot, "scripts/materialize-method-host-plugin.mjs")], {
    cwd: packageRoot,
  });
  const dir = await ensurePackagedMethodPlugin(packageRoot);
  assert.equal(dir, packagedMethodPluginDir(packageRoot));
  assert.equal((await lstat(join(dir, "skills", "tdd", "SKILL.md"))).isFile(), true);
  const missingRoot = await mkdtemp(worktreeTempPrefix("ak-922-no-plugin-"));
  try {
    await assert.rejects(() => ensurePackagedMethodPlugin(missingRoot), /method-host-plugin missing|must materialize/);
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});
