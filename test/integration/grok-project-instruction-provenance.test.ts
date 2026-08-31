/**
 * Mid-tier (this package owns): inspect path → classify HEAD provenance → host
 * activation. Faux only supplies inspect JSON; it does not simulate Grok config
 * discovery. skills.paths ↔ first-party Grok is test/adjudication/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
    const localPath = join(root, "CLAUDE.local.md");
    await writeFile(claudePath, "# shared law\n", "utf8");
    await writeFile(twinPath, "# shared law\n", "utf8");
    git(root, ["add", "CLAUDE.md", "TWIN.md"]);
    git(root, ["commit", "-m", "seed"]);

    const packageRoot = join(root, "pkg");
    const skillPath = join(packageRoot, "resources", "methods", "tdd", "SKILL.md");
    await mkdir(join(packageRoot, "resources", "methods", "tdd"), { recursive: true });
    await writeFile(skillPath, "# tdd\n", "utf8");

    // Faux reports fixed inspect JSON only — package skill path is under packageRoot so
    // our classifier (not a faux config parser) places it in akActive.
    const faux = join(root, "grok-faux.mjs");
    await writeFile(faux, `#!/usr/bin/env node
const paths = JSON.parse(process.env.AK_FAUX_PROJECT_INSTRUCTIONS ?? "[]");
const skillPath = process.env.AK_FAUX_PACKAGE_SKILL_PATH;
process.stdout.write(JSON.stringify({
  skills: skillPath
    ? [{ name: "tdd", source: { type: "project", path: skillPath } }]
    : [],
  projectInstructions: paths.map((path) => ({ path, scope: "project" })),
}));
`, "utf8");
    await chmod(faux, 0o755);

    const envBase = {
      ...process.env,
      AK_FAUX_PACKAGE_SKILL_PATH: skillPath,
    };

    const matched = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: { ...envBase, AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]) },
      packageRoot,
    });
    assert.deepEqual(matched, {
      privateActive: [],
      akActive: ["skills:tdd"],
    });

    let connected = false;
    const acceptHost = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => {
        connected = true;
        return {
          async request(method) {
            if (method === "initialize") {
              return { _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } } };
            }
            if (method === "session/new") return { sessionId: "s1" };
            if (method === "session/prompt") return { stopReason: "end_turn" };
            if (method === "session/close") return {};
            throw new Error(method);
          },
          notify() {},
          async close() {},
        };
      },
      inspect: async () => matched,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.deepEqual(await acceptHost.executeTurn(request), { code: 0, stderr: "", timedOut: false });
    assert.equal(connected, true);

    const cased = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: { ...envBase, AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([join(root, "Claude.md")]) },
      packageRoot,
    });
    assert.deepEqual(cased.privateActive, []);

    await unlink(claudePath);
    await symlink(twinPath, claudePath);
    const linked = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: { ...envBase, AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath]) },
      packageRoot,
    });
    assert.deepEqual(linked.privateActive, [`projectInstructions:${claudePath}`]);
    connected = false;
    const linkHost = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => linked,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.equal((await linkHost.executeTurn(request)).knownFailure?.identity?.code, "private-config-active");
    assert.equal(connected, false);
    await unlink(claudePath);
    await writeFile(claudePath, "# dirty\n", "utf8");
    await writeFile(localPath, "# local\n", "utf8");
    const dirty = await inspectControlledGrok({
      binary: faux,
      cwd: root,
      env: { ...envBase, AK_FAUX_PROJECT_INSTRUCTIONS: JSON.stringify([claudePath, localPath]) },
      packageRoot,
    });
    assert.deepEqual(dirty.privateActive, [
      `projectInstructions:${claudePath}`,
      `projectInstructions:${localPath}`,
    ].sort());
    connected = false;
    const dirtyHost = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => dirty,
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role" }]),
    });
    assert.equal((await dirtyHost.executeTurn(request)).knownFailure?.identity?.code, "private-config-active");
    assert.equal(connected, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
