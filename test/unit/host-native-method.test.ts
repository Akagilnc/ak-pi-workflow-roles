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

test("#922 workspace catalog: two children first-install both hold; one release keeps catalog", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-2child-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  const barrier = join(cwd, "barrier");
  const scriptPath = join(cwd, "child.mjs");
  await writeFile(
    scriptPath,
    `
import { installWorkspaceAgentsSkillsLink } from ${JSON.stringify(`${packageRoot}/src/host-native-method.ts`)};
import { writeFile, access, realpath, appendFile } from "node:fs/promises";
const cwd = process.argv[2];
const packageRoot = process.argv[3];
const barrier = process.argv[4];
const methods = process.argv[5];
const id = process.argv[6];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (path) => { for (let i = 0; i < 500; i++) { try { await access(path); return; } catch { await sleep(10); } } throw new Error("timeout " + path); };
await appendFile(barrier + ".ready", id + "\\n");
await waitFor(barrier);
const link = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
if (!link.held) { console.error("not held", id); process.exit(3); }
if ((await realpath(link.path)) !== methods) { console.error("bad target", id); process.exit(4); }
await appendFile(barrier + ".held", id + "\\n");
await waitFor(barrier + ".release-" + id);
await link.release();
await appendFile(barrier + ".done", id + "\\n");
`,
  );
  const spawnChild = (id: string) =>
    spawn(process.execPath, ["--import", "tsx", scriptPath, cwd, packageRoot, barrier, methods, id], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  const c1 = spawnChild("1");
  const c2 = spawnChild("2");
  let err = "";
  c1.stderr.on("data", (d) => { err += d; });
  c2.stderr.on("data", (d) => { err += d; });
  const waitClose = (c: ReturnType<typeof spawn>) =>
    new Promise<number>((resolve) => {
      if (c.exitCode !== null) resolve(c.exitCode);
      else c.on("close", (code) => resolve(code ?? 1));
    });
  const waitFileHas = async (path: string, needle: string) => {
    for (let i = 0; i < 500; i++) {
      try {
        if ((await readFile(path, "utf8")).includes(needle)) return;
      } catch { /* */ }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting ${needle} in ${path}; stderr=${err}`);
  };
  try {
    await waitFileHas(`${barrier}.ready`, "1");
    await waitFileHas(`${barrier}.ready`, "2");
    await writeFile(barrier, "go");
    await waitFileHas(`${barrier}.held`, "1");
    await waitFileHas(`${barrier}.held`, "2");
    assert.equal(await realpath(join(cwd, ".agents", "skills")), methods);
    await writeFile(`${barrier}.release-1`, "1");
    await waitFileHas(`${barrier}.done`, "1");
    assert.equal(await realpath(join(cwd, ".agents", "skills")), methods);
    await writeFile(`${barrier}.release-2`, "1");
    const [code1, code2] = await Promise.all([waitClose(c1), waitClose(c2)]);
    assert.equal(code1, 0, err);
    assert.equal(code2, 0, err);
    await assert.rejects(() => lstat(join(cwd, ".agents", "skills")), { code: "ENOENT" });
  } finally {
    c1.kill();
    c2.kill();
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
    const code = await new Promise<number>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.on("close", (c) => resolve(c ?? 1));
    });
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
