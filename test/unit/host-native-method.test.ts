/**
 * #922 host-native method delivery: workspace catalog lifecycle + pack-safe plugin.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  assertHermesProjectSkillsTrusted,
  ensurePackagedMethodPlugin,
  installWorkspaceAgentsSkillsLink,
  parseHermesTrustedProjectDirs,
  packagedMethodPluginDir,
  packagedMethodsDir,
  WORKSPACE_AGENTS_SKILLS_REF,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

test("#922 workspace .agents/skills: create/release, foreign same-target kept, overlap refcount", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-agents-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  try {
    const a = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(a.held, true);
    assert.equal(await realpath(a.path), methods);
    const ref = JSON.parse(await readFile(join(cwd, ".agents", WORKSPACE_AGENTS_SKILLS_REF), "utf8")) as {
      count: number;
    };
    assert.equal(ref.count, 1);

    // Overlapping hold on the same cwd keeps the link until the last release.
    const b = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(b.held, true);
    await a.release();
    assert.equal(await realpath(join(cwd, ".agents", "skills")), methods);
    await b.release();
    await assert.rejects(() => lstat(join(cwd, ".agents", "skills")), { code: "ENOENT" });

    // Pre-existing same-target link without our ref is foreign — never deleted.
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await symlink(methods, join(cwd, ".agents", "skills"));
    const foreign = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(foreign.held, false);
    await foreign.release();
    assert.equal(await realpath(join(cwd, ".agents", "skills")), methods);

    // Pre-existing directory is a loud conflict — never overwritten.
    await rm(join(cwd, ".agents", "skills"), { force: true });
    await mkdir(join(cwd, ".agents", "skills"), { recursive: true });
    await writeFile(join(cwd, ".agents", "skills", "keep.txt"), "x");
    await assert.rejects(
      () => installWorkspaceAgentsSkillsLink({ cwd, packageRoot }),
      /pre-existing directory/,
    );
    assert.equal(await readFile(join(cwd, ".agents", "skills", "keep.txt"), "utf8"), "x");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 method-host-plugin: runtime reads build output only; missing fails loud", async () => {
  await execFileAsync(process.execPath, [join(packageRoot, "scripts/materialize-method-host-plugin.mjs")], {
    cwd: packageRoot,
  });
  const dir = await ensurePackagedMethodPlugin(packageRoot);
  assert.equal(dir, packagedMethodPluginDir(packageRoot));
  const st = await lstat(join(dir, "skills", "tdd", "SKILL.md"));
  assert.equal(st.isFile(), true);

  const missingRoot = await mkdtemp(worktreeTempPrefix("ak-922-no-plugin-"));
  try {
    await assert.rejects(
      () => ensurePackagedMethodPlugin(missingRoot),
      /method-host-plugin missing|must materialize/,
    );
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});

test("#922 hermes trusted_project_dirs parse + missing trust fails loud", async () => {
  assert.deepEqual(
    [...parseHermesTrustedProjectDirs("skills:\n  trusted_project_dirs:\n    - /tmp/a\n")],
    ["/tmp/a"],
  );
  const home = await mkdtemp(worktreeTempPrefix("ak-922-hermes-home-"));
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-hermes-cwd-"));
  try {
    await mkdir(join(cwd, ".git"));
    await mkdir(join(home, ".hermes"), { recursive: true });
    await writeFile(join(home, ".hermes", "config.yaml"), "skills: {}\n");
    await assert.rejects(
      () => assertHermesProjectSkillsTrusted({ home, cwd, profileName: "ak-fixer" }),
      /not trusted|skills trust/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
