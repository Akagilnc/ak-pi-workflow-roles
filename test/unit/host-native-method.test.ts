/**
 * #922 host-native method delivery: workspace catalog lifecycle + pack-safe plugin.
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
  setAgentsSkillsLockHooksForTest,
  withAgentsSkillsLock,
  WORKSPACE_AGENTS_SKILLS_REF,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("#922 lock: mutual exclusion + token release + dead lock fails loud", async () => {
  const dir = await mkdtemp(worktreeTempPrefix("ak-922-lock-"));
  const lockPath = join(dir, "lock");
  try {
    let depth = 0;
    let maxDepth = 0;
    setAgentsSkillsLockHooksForTest({
      onEnter: () => {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      },
      onLeave: () => {
        depth -= 1;
      },
    });
    await Promise.all([
      withAgentsSkillsLock(lockPath, async () => {
        await sleep(30);
      }),
      withAgentsSkillsLock(lockPath, async () => {
        await sleep(30);
      }),
      withAgentsSkillsLock(lockPath, async () => {
        await sleep(30);
      }),
    ]);
    assert.equal(maxDepth, 1, "lock bodies must not overlap");
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" });

    // Dead-owner lock is not auto-stolen — loud path for operator rm.
    await writeFile(lockPath, "999999999\ndead-token\n");
    await assert.rejects(
      () => withAgentsSkillsLock(lockPath, async () => "nope"),
      /stale workspace agents skills lock|dead pid/,
    );
    assert.equal(await readFile(lockPath, "utf8"), "999999999\ndead-token\n");
  } finally {
    setAgentsSkillsLockHooksForTest(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("#922 workspace .agents/skills: ownership, overlap, install↔last-release", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-agents-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  const linkPath = join(cwd, ".agents", "skills");
  try {
    const a = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(a.held, true);
    assert.equal(await realpath(a.path), methods);

    const b = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(b.held, true);
    await a.release();
    assert.equal(await realpath(linkPath), methods);
    await b.release();
    await assert.rejects(() => lstat(linkPath), { code: "ENOENT" });

    // install concurrently with last release — success path keeps a live catalog.
    const c = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    const [d] = await Promise.all([
      installWorkspaceAgentsSkillsLink({ cwd, packageRoot }),
      c.release(),
    ]);
    assert.equal(await realpath(d.path), methods);
    await d.release();
    await assert.rejects(() => lstat(linkPath), { code: "ENOENT" });

    // Foreign same-target without our ref — never deleted.
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await symlink(methods, linkPath);
    const foreign = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(foreign.held, false);
    await foreign.release();
    assert.equal(await realpath(linkPath), methods);
    await assert.rejects(() => readFile(join(cwd, ".agents", WORKSPACE_AGENTS_SKILLS_REF), "utf8"));

    // Directory conflict.
    await rm(linkPath, { force: true });
    await mkdir(linkPath, { recursive: true });
    await writeFile(join(linkPath, "keep.txt"), "x");
    await assert.rejects(
      () => installWorkspaceAgentsSkillsLink({ cwd, packageRoot }),
      /pre-existing directory/,
    );
    assert.equal(await readFile(join(linkPath, "keep.txt"), "utf8"), "x");
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
  assert.equal((await lstat(join(dir, "skills", "tdd", "SKILL.md"))).isFile(), true);

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
