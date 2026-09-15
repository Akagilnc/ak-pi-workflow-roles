/** #922 host-native method delivery (catalog ownership shape frozen pending design). */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createProductionAcpRoleTurnHost } from "../../src/acp-host/production-host.ts";
import { HOST_DESCRIPTIONS } from "../../src/host-descriptions.ts";
import {
  assertHermesProjectSkillsTrusted,
  ensurePackagedMethodPlugin,
  installWorkspaceAgentsSkillsLink,
  packagedMethodPluginDir,
  packagedMethodsDir,
} from "../../src/host-native-method.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

const execFileAsync = promisify(execFile);

test("#922 workspace .agents/skills: create/release, overlap, idempotent, foreign, conflict", async () => {
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-agents-"));
  const methods = await realpath(packagedMethodsDir(packageRoot));
  const linkPath = join(cwd, ".agents", "skills");
  try {
    const a = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(a.created, true);
    assert.equal(await realpath(a.path), methods);
    const b = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(b.created, true);
    await a.release();
    await a.release();
    assert.equal(await realpath(linkPath), methods);
    await b.release();
    await assert.rejects(() => lstat(linkPath), { code: "ENOENT" });

    await mkdir(join(cwd, ".agents"), { recursive: true });
    await symlink(methods, linkPath);
    const foreign = await installWorkspaceAgentsSkillsLink({ cwd, packageRoot });
    assert.equal(foreign.created, false);
    await foreign.release();
    assert.equal(await realpath(linkPath), methods);

    await rm(linkPath, { force: true });
    await mkdir(linkPath, { recursive: true });
    await writeFile(join(linkPath, "keep.txt"), "x");
    await assert.rejects(() => installWorkspaceAgentsSkillsLink({ cwd, packageRoot }), /pre-existing directory/);
    assert.equal(await readFile(join(linkPath, "keep.txt"), "utf8"), "x");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#922 hermes untrusted + I/O honesty at production connect; plugin build-only", async () => {
  const hermes = HOST_DESCRIPTIONS.hermes;
  assert.ok(hermes);

  const home = await mkdtemp(worktreeTempPrefix("ak-922-hermes-home-"));
  const cwd = await mkdtemp(worktreeTempPrefix("ak-922-hermes-cwd-"));
  const runDirectory = await mkdtemp(worktreeTempPrefix("ak-922-hermes-run-"));
  try {
    await mkdir(join(cwd, ".git"));
    await mkdir(join(runDirectory, "session"), { recursive: true });
    await mkdir(join(home, ".hermes"), { recursive: true });
    // Comment-only "trust" must not pass; empty dirs = untrusted.
    await writeFile(join(home, ".hermes", "config.yaml"), "skills:\n  # trusted_project_dirs:\n  #   - /tmp/fake\n");

    const host = createProductionAcpRoleTurnHost({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      description: hermes,
      hostName: "hermes",
    });
    const skillPath = join(packageRoot, "resources/methods/tdd/SKILL.md");
    const request = {
      principal: fixturePrincipal(join(runDirectory, "session")),
      activation: { role: "judge" as const },
      methods: [{ kind: "skill" as const, path: skillPath }],
      continuation: { kind: "initial" as const, prompt: "probe" },
      cwd,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
      host: "hermes",
    };

    // Production ACP entry: connect checks trust before spawning hermes binary.
    await assert.rejects(() => host.executeTurn(request), /not trusted|skills trust/);

    // Non-ENOENT read fault must not be laundered as "not trusted".
    await rm(join(home, ".hermes", "config.yaml"), { force: true });
    await mkdir(join(home, ".hermes", "config.yaml")); // EISDIR on readFile
    await assert.rejects(
      () => assertHermesProjectSkillsTrusted({ home, cwd, profileName: "ak-judge" }),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "EISDIR");
        assert.equal(/not trusted|skills trust/.test(String(error)), false);
        return true;
      },
    );
  } finally {
    await chmod(join(home, ".hermes"), 0o755).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(runDirectory, { recursive: true, force: true });
  }

  await execFileAsync(process.execPath, [join(packageRoot, "scripts/materialize-method-host-plugin.mjs")], {
    cwd: packageRoot,
  });
  assert.equal(await ensurePackagedMethodPlugin(packageRoot), packagedMethodPluginDir(packageRoot));
  for (const method of ["tdd", "code-review", "diagnosing-bugs", "resolving-merge-conflicts"]) {
    assert.equal(
      (await lstat(join(packagedMethodPluginDir(packageRoot), "skills", method, "SKILL.md"))).isFile(),
      true,
    );
  }
  const missingRoot = await mkdtemp(worktreeTempPrefix("ak-922-no-plugin-"));
  try {
    await assert.rejects(() => ensurePackagedMethodPlugin(missingRoot), /method-host-plugin missing|must materialize/);
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});
