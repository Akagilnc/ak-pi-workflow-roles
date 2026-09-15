/**
 * #922 host-native method delivery.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
  WORKSPACE_AGENTS_SKILLS_REF,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

const execFileAsync = promisify(execFile);

test("#922 workspace catalog: create/overlap/idempotent release/foreign/conflict", async () => {
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
    await a.release(); // idempotent — must not consume B's hold
    assert.equal(await realpath(linkPath), methods);
    await b.release();
    await assert.rejects(() => lstat(linkPath), { code: "ENOENT" });

    // Foreign same-target without our ref — never deleted.
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await symlink(methods, linkPath);
    const foreign = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(foreign.held, false);
    await foreign.release();
    assert.equal(await realpath(linkPath), methods);
    await assert.rejects(() => readFile(join(cwd, ".agents", WORKSPACE_AGENTS_SKILLS_REF), "utf8"));

    await rm(linkPath, { force: true });
    await mkdir(linkPath, { recursive: true });
    await writeFile(join(linkPath, "keep.txt"), "x");
    await assert.rejects(() => installWorkspaceAgentsSkillsLink({ cwd, packageRoot }), /pre-existing directory/);
    assert.equal(await readFile(join(linkPath, "keep.txt"), "utf8"), "x");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 hermes trusted_project_dirs: exact paths only; comments/unrelated keys fail", async () => {
  assert.deepEqual(
    [...parseHermesTrustedProjectDirs("skills:\n  trusted_project_dirs:\n    - /tmp/trusted\n")],
    ["/tmp/trusted"],
  );
  // Comment / wrong key must not yield a trusted path.
  assert.deepEqual(
    [...parseHermesTrustedProjectDirs("skills:\n  # trusted_project_dirs:\n  #   - /tmp/fake\n  other: /tmp/fake\n")],
    [],
  );
  assert.deepEqual(
    [...parseHermesTrustedProjectDirs("skills:\n  untrusted_project_dirs:\n    - /tmp/x\n")],
    [],
  );

  const home = await mkdtemp(worktreeTempPrefix("ak-922-hermes-home-"));
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-hermes-cwd-"));
  try {
    await mkdir(join(cwd, ".git"));
    const root = await realpath(cwd);
    await mkdir(join(home, ".hermes"), { recursive: true });
    // Comment containing path must not pass.
    await writeFile(
      join(home, ".hermes", "config.yaml"),
      `skills:\n  # do not trust ${root}\n  trusted_project_dirs: []\n`,
    );
    await assert.rejects(
      () => assertHermesProjectSkillsTrusted({ home, cwd, profileName: "ak-fixer" }),
      /not trusted|skills trust/,
    );
    // Real list entry must pass.
    await writeFile(
      join(home, ".hermes", "config.yaml"),
      `skills:\n  trusted_project_dirs:\n    - ${root}\n`,
    );
    await assertHermesProjectSkillsTrusted({ home, cwd, profileName: "ak-fixer" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 workspace catalog: cross-process hold survives peer release", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-xproc-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  const ready = join(cwd, "ready");
  const go = join(cwd, "go");
  const childScript = [
    `import { installWorkspaceAgentsSkillsLink } from ${JSON.stringify(`${packageRoot}/src/host-native-method.ts`)};`,
    `import { writeFile, access, realpath } from "node:fs/promises";`,
    `const [, cwd, packageRoot, ready, go, methods] = process.argv;`,
    `const link = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });`,
    `await writeFile(ready, "1");`,
    `for (;;) { try { await access(go); break; } catch { await new Promise(r => setTimeout(r, 20)); } }`,
    `if ((await realpath(link.path)) !== methods) process.exit(2);`,
    `await link.release();`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childScript, cwd, packageRoot, ready, go, methods],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  try {
    for (let i = 0; i < 250; i++) {
      try {
        await readFile(ready, "utf8");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await readFile(ready, "utf8");
    const parent = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(parent.held, true);
    await parent.release();
    assert.equal(await realpath(join(cwd, ".agents", "skills")), methods);
    await writeFile(go, "1");
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
    assert.equal(code, 0, stderr);
  } finally {
    child.kill();
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
