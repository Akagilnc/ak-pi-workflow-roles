/** #922 host-native method delivery. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyCodexSkillInvocation,
  applyHostSlashSkillInvocation,
  hostMethodSkills,
  installWorkspaceMethodSkills,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("#922 Claude plugin projection keeps the bound packaged method identity", () => {
  const path = join(packageRoot, "resources/methods/tdd/SKILL.md");
  const skills = hostMethodSkills([{ kind: "skill", path }]);
  assert.deepEqual(skills, [{ name: "tdd", dir: join(packageRoot, "resources/methods/tdd"), path }]);
  assert.equal(applyCodexSkillInvocation([{ kind: "skill", path }], "task"), "$tdd task");
  assert.equal(applyHostSlashSkillInvocation("tdd", "task"), "/tdd task");
});

test("#922 project Skill catalog is stable and never replaces existing entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-922-"));
  const workspace = join(root, "workspace");
  const packaged = join(root, "package");
  await mkdir(join(workspace, ".agents"), { recursive: true });
  await mkdir(join(packaged, "resources", "methods"), { recursive: true });
  try {
    await installWorkspaceMethodSkills(workspace, packaged);
    await installWorkspaceMethodSkills(workspace, packaged);

    await rm(join(workspace, ".agents", "skills"));
    await mkdir(join(workspace, ".agents", "skills"));
    await assert.rejects(() => installWorkspaceMethodSkills(workspace, packaged), /non-symlink entry/);

    await rm(join(workspace, ".agents", "skills"), { recursive: true });
    const missing = join(root, "removed-methods");
    await symlink(missing, join(workspace, ".agents", "skills"));
    await assert.rejects(() => installWorkspaceMethodSkills(workspace, packaged), /symlink to/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
