/**
 * #980 / #922 Codex project Skill catalog at the real FS IO seam.
 * Existing complete catalogs stay put; only true conflicts fail loud.
 */
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  applyCodexSkillInvocation,
  hostMethodSkills,
  installWorkspaceMethodSkills,
  packagedMethodsDir,
} from "../../src/host-native-method.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function writeSkill(methodsRoot: string, name: string, body = `# ${name}\n`): Promise<void> {
  const dir = join(methodsRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
}

async function seedPackagedMethods(packageRoot: string, names: readonly string[]): Promise<string> {
  const methods = packagedMethodsDir(packageRoot);
  for (const name of names) await writeSkill(methods, name);
  return realpath(methods);
}

test("#980 codex skill tokens keep bound method identity", () => {
  const path = join("/pkg", "resources/methods/tdd/SKILL.md");
  assert.deepEqual(hostMethodSkills([{ kind: "skill", path }]), [{ name: "tdd" }]);
  assert.equal(applyCodexSkillInvocation([{ kind: "skill", path }], "task"), "$tdd task");
  assert.equal(
    applyCodexSkillInvocation(
      [
        { kind: "skill", path: join("/pkg", "resources/methods/diagnosing-bugs/SKILL.md") },
        { kind: "skill", path },
      ],
      "task",
    ),
    "$diagnosing-bugs $tdd task",
  );
});

test("#980 project Skill catalog creates once, keeps existing complete catalogs, rejects true conflicts", async () => {
  await withTempRoot("ak-980-catalog-", async (root) => {
    const packageRoot = join(root, "package");
    const workspace = join(root, "workspace");
    const foreignComplete = join(root, "foreign-complete-methods");
    const partialMethods = join(root, "partial-methods");
    const skillsLink = join(workspace, ".agents", "skills");
    const methodNames = ["tdd", "diagnosing-bugs", "resolving-merge-conflicts", "ak-cross-m-review"] as const;

    await mkdir(join(workspace, ".agents"), { recursive: true });
    const packagedReal = await seedPackagedMethods(packageRoot, methodNames);
    for (const name of methodNames) await writeSkill(foreignComplete, name, `# foreign ${name}\n`);
    await writeSkill(partialMethods, "tdd");

    // Missing → create permanent link to packaged methods; second call is a no-op.
    await installWorkspaceMethodSkills(workspace, packageRoot);
    assert.equal(await realpath(skillsLink), packagedReal);
    const created = await readlink(skillsLink);
    await installWorkspaceMethodSkills(workspace, packageRoot);
    assert.equal(await readlink(skillsLink), created);
    assert.equal(await realpath(skillsLink), packagedReal);

    // Existing complete catalog at a different path (this-repo worktree shape) stays put.
    await rm(skillsLink, { force: true });
    await symlink(foreignComplete, skillsLink);
    const beforeComplete = await readlink(skillsLink);
    await installWorkspaceMethodSkills(workspace, packageRoot);
    assert.equal(await readlink(skillsLink), beforeComplete);
    assert.equal(await realpath(skillsLink), await realpath(foreignComplete));

    // Non-symlink entry is a true conflict and is left untouched.
    await rm(skillsLink, { force: true });
    await mkdir(skillsLink);
    await assert.rejects(
      () => installWorkspaceMethodSkills(workspace, packageRoot),
      (error: unknown) =>
        error instanceof Error &&
        /workspace method catalog conflict/.test(error.message) &&
        /non-symlink entry/.test(error.message),
    );
    assert.equal((await lstat(skillsLink)).isDirectory(), true);

    // Partial catalog (missing packaged skills) is a true conflict and stays put.
    await rm(skillsLink, { recursive: true, force: true });
    await symlink(partialMethods, skillsLink);
    const beforePartial = await readlink(skillsLink);
    await assert.rejects(
      () => installWorkspaceMethodSkills(workspace, packageRoot),
      /workspace method catalog conflict/,
    );
    assert.equal(await readlink(skillsLink), beforePartial);

    // Broken symlink is a true conflict and stays put.
    await rm(skillsLink, { force: true });
    await symlink(join(root, "missing-methods"), skillsLink);
    const beforeBroken = await readlink(skillsLink);
    await assert.rejects(
      () => installWorkspaceMethodSkills(workspace, packageRoot),
      /workspace method catalog conflict/,
    );
    assert.equal(await readlink(skillsLink), beforeBroken);
  });
});
