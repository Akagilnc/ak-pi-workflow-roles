/** #922 host-native method delivery. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyMethodPathBrief,
  ensurePackagedMethodPlugin,
  hostMethodSkills,
  packagedMethodPluginDir,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

const execFileAsync = promisify(execFile);

test("#922 non-plugin hosts receive readable absolute method paths in the brief", () => {
  const path = join(packageRoot, "resources/methods/tdd/SKILL.md");
  const skills = hostMethodSkills([{ kind: "skill", path }]);
  assert.deepEqual(skills.map((skill) => skill.path), [path]);
  assert.match(applyMethodPathBrief(skills, "assignment"), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("#922 packaged plugin is build-owned for native plugin hosts", async () => {
  await execFileAsync(process.execPath, [join(packageRoot, "scripts/materialize-method-host-plugin.mjs")], { cwd: packageRoot });
  assert.equal(await ensurePackagedMethodPlugin(packageRoot), packagedMethodPluginDir(packageRoot));
  for (const method of ["tdd", "code-review", "diagnosing-bugs", "resolving-merge-conflicts"]) {
    assert.equal((await lstat(join(packagedMethodPluginDir(packageRoot), "skills", method, "SKILL.md"))).isFile(), true);
  }
  const missingRoot = await mkdtemp(worktreeTempPrefix("ak-922-no-plugin-"));
  try {
    await assert.rejects(() => ensurePackagedMethodPlugin(missingRoot), /method-host-plugin missing|must materialize/);
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});
