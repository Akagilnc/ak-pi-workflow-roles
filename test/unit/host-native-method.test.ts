/**
 * #922 host-native method delivery: workspace catalog link lifecycle + pack-safe plugin.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

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

test("#922 workspace .agents/skills: create, release, conflict, orphan adopt", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-agents-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  try {
    const first = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(await realpath(first.path), methods);
    await first.release();
    await assert.rejects(() => lstat(first.path), { code: "ENOENT" });

    // Orphan pointing at packaged methods is adopted and cleaned.
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await symlink(methods, join(cwd, ".agents", "skills"));
    const adopted = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(adopted.created, true);
    await adopted.release();
    await assert.rejects(() => lstat(join(cwd, ".agents", "skills")), { code: "ENOENT" });

    // Pre-existing directory is a loud conflict — never overwritten.
    await mkdir(join(cwd, ".agents", "skills"), { recursive: true });
    await writeFile(join(cwd, ".agents", "skills", "keep.txt"), "x");
    await assert.rejects(
      () => installWorkspaceAgentsSkillsLink({ cwd, packageRoot }),
      /pre-existing directory/,
    );
    assert.equal(await readlink(join(cwd, ".agents", "skills")).catch(() => "dir"), "dir");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 method-host-plugin materialize carries real SKILL.md bodies", async () => {
  const dir = await ensurePackagedMethodPlugin(packageRoot);
  assert.equal(dir, packagedMethodPluginDir(packageRoot));
  const skill = join(dir, "skills", "tdd", "SKILL.md");
  const st = await lstat(skill);
  assert.equal(st.isFile(), true);
  assert.equal(st.isSymbolicLink(), false);
});

test("#922 hermes trusted_project_dirs parse + missing trust fails loud", async () => {
  const dirs = parseHermesTrustedProjectDirs(`
skills:
  trusted_project_dirs:
    - /tmp/trusted-a
    - "/tmp/trusted-b"
other: 1
`);
  assert.deepEqual([...dirs], ["/tmp/trusted-a", "/tmp/trusted-b"]);

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
