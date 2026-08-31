/**
 * Mid-tier: real git worktree + faux Grok binary + inspect→provenance→host activation.
 * Proves HEAD-matched projectInstructions leave privateActive; dirty / symlink-replaced /
 * untracked stay fail-closed before connect. Not a unit test (cross-process + filesystem).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
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

test("inspect→host: HEAD match and Claude.md case-fold clear privateActive; dirty, HEAD-path symlink replace, and untracked stay private-config-active before connect", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-head-match-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "test"]);
    const claudePath = join(root, "CLAUDE.md");
    const twinPath = join(root, "TWIN.md");
    const agentsPath = join(root, "AGENTS.md");
    const localPath = join(root, "CLAUDE.local.md");
    const homePath = join(root, "home-claude.md");
    // Identical bytes so a CLAUDE.md→TWIN.md symlink would hash-match HEAD without the symlink guard.
    await writeFile(claudePath, "# shared law\n", "utf8");
    await writeFile(twinPath, "# shared law\n", "utf8");
    await writeFile(agentsPath, "# agents\n", "utf8");
    git(root, ["add", "CLAUDE.md", "TWIN.md", "AGENTS.md"]);
    git(root, ["commit", "-m", "seed"]);

    const packageRoot = join(root, "pkg");
    const faux = join(root, "grok-faux.mjs");
    await writeFile(faux, `#!/usr/bin/env node
const paths = JSON.parse(process.env.AK_FAUX_PROJECT_INSTRUCTIONS ?? "[]");
process.stdout.write(JSON.stringify({
  skills: [{ name: "ak-method", source: { type: "project", path: process.env.AK_PACKAGE_ROOT + "/resources/method/SKILL.md" } }],
  projectInstructions: paths.map((path) => ({ path, scope: "project" })),
}));
`, "utf8");
    await chmod(faux, 0o755);

    const matchedInspect = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: {
        ...process.env,
        AK_PACKAGE_ROOT: packageRoot,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath, agentsPath]),
      },
      packageRoot,
    });
    assert.deepEqual(matchedInspect, {
      privateActive: [],
      akActive: [`skills:ak-method`],
    });

    let connected = false;
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => {
        connected = true;
        return {
          async request(method) {
            if (method === "initialize") {
              return {
                _meta: {
                  modelState: { availableModels: [{ modelId: "grok-4.5" }] },
                },
              };
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
      inspect: async () => matchedInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.deepEqual(await host.executeTurn(request), { code: 0, stderr: "", timedOut: false });
    assert.equal(connected, true);

    // Grok may report Claude.md while HEAD stores CLAUDE.md — bytes read via HEAD path casing.
    const grokCasePath = join(root, "Claude.md");
    const casedInspect = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: {
        ...process.env,
        AK_PACKAGE_ROOT: packageRoot,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([grokCasePath]),
      },
      packageRoot,
    });
    assert.deepEqual(casedInspect.privateActive, []);

    // Replace the HEAD path itself with a same-bytes symlink. HEAD mapping still finds CLAUDE.md;
    // without the symlink guard, hash-object would follow the link and falsely match.
    await unlink(claudePath);
    await symlink(twinPath, claudePath);
    const symlinkInspect = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: {
        ...process.env,
        AK_PACKAGE_ROOT: packageRoot,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]),
      },
      packageRoot,
    });
    assert.deepEqual(symlinkInspect.privateActive, [`projectInstructions:${claudePath}`]);
    connected = false;
    const symlinkRejected = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => symlinkInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.equal((await symlinkRejected.executeTurn(request)).knownFailure?.identity?.code, "private-config-active");
    assert.equal(connected, false);
    await unlink(claudePath);
    await writeFile(claudePath, "# shared law\n", "utf8");

    await writeFile(claudePath, "# dirty local rewrite\n", "utf8");
    await writeFile(localPath, "# untracked local\n", "utf8");
    await writeFile(homePath, "# global-shaped\n", "utf8");
    const dirtyInspect = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: {
        ...process.env,
        AK_PACKAGE_ROOT: packageRoot,
        AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath, localPath, homePath]),
      },
      packageRoot,
    });
    assert.deepEqual(dirtyInspect.privateActive, [
      `projectInstructions:${claudePath}`,
      `projectInstructions:${homePath}`,
      `projectInstructions:${localPath}`,
    ].sort());
    assert.deepEqual(dirtyInspect.akActive, [`skills:ak-method`]);

    connected = false;
    const rejected = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => dirtyInspect,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    const failure = await rejected.executeTurn(request);
    assert.equal(failure.knownFailure?.identity?.code, "private-config-active");
    assert.equal(connected, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
