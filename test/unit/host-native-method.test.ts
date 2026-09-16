/** #922 host-native method delivery. */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost } from "../../src/acp-host/role-turn-host.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import { hostMethodSkills } from "../../src/host-native-method.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("#922 Claude plugin projection keeps the bound packaged method identity", () => {
  const path = join(packageRoot, "resources/methods/tdd/SKILL.md");
  const skills = hostMethodSkills([{ kind: "skill", path }]);
  assert.deepEqual(skills, [{ name: "tdd", dir: join(packageRoot, "resources/methods/tdd"), path }]);
});

test("#922 unsupported native loaders fail typed before host startup", async () => {
  const codex = lookupHeadlessHostDescription("codex");
  assert.ok(codex?.protocol === "codex-exec");
  let starts = 0;
  const sessionIdentity = {
    load: async () => undefined,
    bind: async () => {},
    resolveSessionFile: () => "/tmp/session.jsonl",
  };
  const hosts = [
    createHeadlessRoleTurnHost({
      description: codex,
      sessionIdentity,
      hostName: "codex",
      binary: "/must-not-start",
      prepare: async () => { starts += 1; throw new Error("prepare must not run"); },
    }),
    createAcpRoleTurnHost({
      sessionIdentity,
      hostName: "grok-build",
      boundResume: "session/load",
      modelPassing: "argv",
      connect: async () => { starts += 1; throw new Error("connect must not run"); },
      prepare: async () => { starts += 1; throw new Error("prepare must not run"); },
    }),
  ];
  const request = {
    principal: fixturePrincipal("/tmp/ak-922/session"),
    activation: { role: "coder" as const, phase: "apply" as const, taskPath: "/tmp/task.md" },
    methods: [{ kind: "skill" as const, path: "/package/resources/methods/tdd/SKILL.md" }],
    continuation: { kind: "initial" as const, prompt: "assignment" },
    cwd: "/tmp",
    home: "/tmp",
    agentDir: "/tmp/agent",
    runDirectory: "/tmp/ak-922",
  };
  for (const host of hosts) {
    const result = await host.executeTurn(request);
    assert.equal(result.knownFailure?.identity?.name, "UnsupportedHostMethod");
    assert.equal(result.knownFailure?.identity?.code, "unsupported-method");
  }
  assert.equal(starts, 0);
});
