/**
 * Mid-tier: production isolation bind + real git worktree + faux Grok that honors
 * GROK_HOME/config.toml skills.paths (no AK_PACKAGE_ROOT skill forgery).
 * Proves: HEAD-matched projectInstructions leave privateActive; production
 * skills.paths makes packageRoot method skills appear as akActive; dirty /
 * HEAD-path symlink replace / untracked stay private-config-active before connect.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindProductionGrokIsolation,
  openProductionGrokHome,
  writeProductionGrokPackageSkillPaths,
} from "../../src/grok/production-host.ts";
import {
  controlledGrokChildEnv,
  createGrokRoleTurnHost,
  inspectControlledGrok,
  type GrokPreparedTurn,
} from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const sessionIds = new WeakMap<object, string>();
const sessionIdentity = {
  async load(principal: object) { return sessionIds.get(principal); },
  async bind(principal: object, sessionId: string) { sessionIds.set(principal, sessionId); },
};

const request = {
  principal: {}, activation: { role: "judge" }, methods: [],
  continuation: { kind: "initial", prompt: "decide" },
  model: { provider: "xai", model: "grok-4.5" }, cwd: "/work", home: "/home/user",
  agentDir: "/agent", runDirectory: "/run",
} as RoleTurnRequest;

function prepared(
  closeRound: GrokPreparedTurn["closeRound"],
  mcpServers: Readonly<Record<string, unknown>>[] = [{}],
): GrokPreparedTurn {
  return { mcpServers, systemPrompt: "law", prompt: "decide", closeRound };
}

/** Faux grok inspect: skills only from GROK_HOME config.toml skills.paths; projectInstructions from env. */
async function writeFauxGrokBinary(path: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const home = process.env.GROK_HOME || process.env.HOME || "";
const skills = [];
try {
  const toml = readFileSync(join(home, "config.toml"), "utf8");
  const block = /\\[skills\\][\\s\\S]*?(?=\\n\\[|$)/.exec(toml)?.[0] ?? "";
  for (const match of block.matchAll(/"([^"]+)"/g)) {
    const dir = match[1];
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const skillMd = join(dir, name, "SKILL.md");
      try {
        statSync(skillMd);
        skills.push({ name, source: { type: "configToml", path: skillMd } });
      } catch { /* skip */ }
    }
  }
} catch { /* no config */ }
const projectInstructions = JSON.parse(process.env.AK_FAUX_PROJECT_INSTRUCTIONS ?? "[]")
  .map((path) => ({ path, scope: "project" }));
process.stdout.write(JSON.stringify({ skills, projectInstructions }));
`, "utf8");
  await chmod(path, 0o755);
}

test("production bind skills.paths + HEAD projectInstructions: akActive from package methods; private cleared; dirty/symlink/untracked fail closed before connect", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ak-grok-prod-prov-"));
  const operatorHome = join(scratch, "operator");
  const packageRoot = join(scratch, "pkg");
  const repo = join(scratch, "repo");
  let controlledHomes: string[] = [];
  try {
    await mkdir(join(operatorHome, ".grok", "bin"), { recursive: true });
    await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", "utf8");
    const faux = join(operatorHome, ".grok", "bin", "grok");
    await writeFauxGrokBinary(faux);

    await mkdir(join(packageRoot, "resources", "methods", "tdd"), { recursive: true });
    await writeFile(join(packageRoot, "resources", "methods", "tdd", "SKILL.md"), "# tdd\n", "utf8");

    await mkdir(repo, { recursive: true });
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    const claudePath = join(repo, "CLAUDE.md");
    const twinPath = join(repo, "TWIN.md");
    await writeFile(claudePath, "# shared law\n", "utf8");
    await writeFile(twinPath, "# shared law\n", "utf8");
    git(repo, ["add", "CLAUDE.md", "TWIN.md"]);
    git(repo, ["commit", "-m", "seed"]);

    // Red: controlled home without skills.paths → no package skills observed (akActive empty).
    const bareHome = await openProductionGrokHome(operatorHome);
    controlledHomes.push(bareHome);
    const bareEnv = {
      ...controlledGrokChildEnv(process.env, bareHome),
      AK_PACKAGE_ROOT: packageRoot,
      AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]),
    };
    const bareInspect = await inspectControlledGrok({
      binary: faux,
      cwd: repo,
      env: bareEnv,
      packageRoot,
    });
    assert.deepEqual(bareInspect.akActive, []);
    assert.deepEqual(bareInspect.privateActive, []); // HEAD CLAUDE.md still shared

    // Green: production bind writes skills.paths → inspect observes package method under packageRoot.
    const binding = await bindProductionGrokIsolation(operatorHome, packageRoot);
    controlledHomes.push(binding.controlledHome);
    assert.equal(binding.binary, faux);
    const boundEnv = {
      ...binding.env,
      AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]),
    };
    const boundInspect = await inspectControlledGrok({
      binary: binding.binary,
      cwd: repo,
      env: boundEnv,
      packageRoot,
    });
    assert.deepEqual(boundInspect.privateActive, []);
    assert.ok(
      boundInspect.akActive.includes("skills:tdd"),
      `expected skills:tdd in akActive, got ${JSON.stringify(boundInspect.akActive)}`,
    );
    assert.ok(
      boundInspect.akActive.every((id) => !id.startsWith("projectInstructions:")),
      "HEAD projectInstructions must not be mislabeled as AK injection",
    );

    let connected = false;
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => {
        connected = true;
        return {
          async request(method) {
            if (method === "initialize") {
              return { _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } } };
            }
            if (method === "session/new") return { sessionId: "s-head" };
            if (method === "session/prompt") return { stopReason: "end_turn" };
            if (method === "session/close") return {};
            throw new Error(method);
          },
          notify() {},
          async close() {},
        };
      },
      inspect: async () => boundInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.deepEqual(await host.executeTurn(request), { code: 0, stderr: "", timedOut: false });
    assert.equal(connected, true);

    // ak-config-missing when private clear but akActive empty (bare inspect).
    connected = false;
    const missingAk = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => bareInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.equal((await missingAk.executeTurn(request)).knownFailure?.identity?.code, "ak-config-missing");
    assert.equal(connected, false);

    // Case-fold inspect path Claude.md still clears private via HEAD path bytes.
    const casedInspect = await inspectControlledGrok({
      binary: binding.binary,
      cwd: repo,
      env: {
        ...binding.env,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([join(repo, "Claude.md")]),
      },
      packageRoot,
    });
    assert.deepEqual(casedInspect.privateActive, []);
    assert.ok(casedInspect.akActive.includes("skills:tdd"));

    // HEAD path replaced with same-bytes symlink → private-config-active (hash would match without guard).
    await unlink(claudePath);
    await symlink(twinPath, claudePath);
    const symlinkInspect = await inspectControlledGrok({
      binary: binding.binary,
      cwd: repo,
      env: {
        ...binding.env,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]),
      },
      packageRoot,
    });
    assert.deepEqual(symlinkInspect.privateActive, [`projectInstructions:${claudePath}`]);
    connected = false;
    const symlinkHost = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => symlinkInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.equal((await symlinkHost.executeTurn(request)).knownFailure?.identity?.code, "private-config-active");
    assert.equal(connected, false);
    await unlink(claudePath);
    await writeFile(claudePath, "# shared law\n", "utf8");

    // Dirty + untracked fail closed.
    await writeFile(claudePath, "# dirty\n", "utf8");
    const localPath = join(repo, "CLAUDE.local.md");
    await writeFile(localPath, "# local\n", "utf8");
    const dirtyInspect = await inspectControlledGrok({
      binary: binding.binary,
      cwd: repo,
      env: {
        ...binding.env,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath, localPath]),
      },
      packageRoot,
    });
    assert.deepEqual(dirtyInspect.privateActive, [
      `projectInstructions:${claudePath}`,
      `projectInstructions:${localPath}`,
    ].sort());
    connected = false;
    const dirtyHost = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => dirtyInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.equal((await dirtyHost.executeTurn(request)).knownFailure?.identity?.code, "private-config-active");
    assert.equal(connected, false);

    // Same bare home: writing skills.paths alone is what makes package methods observable.
    await writeFile(claudePath, "# shared law\n", "utf8");
    await writeProductionGrokPackageSkillPaths(bareHome, packageRoot);
    const afterWrite = await inspectControlledGrok({
      binary: faux,
      cwd: repo,
      env: {
        ...controlledGrokChildEnv(process.env, bareHome),
        AK_PACKAGE_ROOT: packageRoot,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]),
      },
      packageRoot,
    });
    assert.ok(afterWrite.akActive.includes("skills:tdd"));
    assert.deepEqual(afterWrite.privateActive, []);
  } finally {
    for (const home of controlledHomes) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
