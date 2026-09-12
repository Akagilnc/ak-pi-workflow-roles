import assert from "node:assert/strict";
import test from "node:test";

import { AK_ROLE_ENGINE_ENV, resolveEngineName } from "../../src/engine-detour.ts";
import type { HostEventRegistration, HostToolDefinition, RoleEnvelopeHost, RoleHost } from "../../src/host-contracts.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";

test("shared envelope configures every public seat on a non-Pi host", () => {
  const tools = new Map<string, HostToolDefinition>();
  const flags = new Map<string, { value: boolean | string | undefined; description: string }>();
  const handlers: HostEventRegistration[] = [];
  let active: string[] = [];
  const host: RoleHost = {
    registerFlag(name, definition) { flags.set(name, { value: definition.default, description: definition.description }); },
    getFlag(name) { return flags.get(name)?.value; },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    setActiveTools(names) { active = names; },
    getActiveTools() { return active; },
    on(...registration: HostEventRegistration) { handlers.push(registration); },
  };
  const envelopeHost: RoleEnvelopeHost = {
    host,
    appendEntry() {},
    async sendMessage() {},
    startKeepalive() {},
    stopKeepalive() {},
  };

  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
  })(envelopeHost);

  assert.ok(flags.has("ak-role"));
  assert.ok(handlers.some(([event]) => event === "session_start"));
  assert.ok(handlers.some(([event]) => event === "turn_end"));
});

/**
 * Default Pi writes registerFlag defaults into flagValues (loader.js).
 * ak-engine must stay unset so resolveEngineName can fall through to child env.
 */
test("#879 default Pi empty ak-engine flag must not block AK_ROLE_ENGINE", () => {
  const registered = new Map<string, { default?: boolean | string }>();
  const flagValues = new Map<string, boolean | string>();
  const host: RoleHost = {
    registerFlag(name, definition) {
      registered.set(name, definition);
      if (definition.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, definition.default);
      }
    },
    getFlag(name) {
      if (!registered.has(name)) return undefined;
      return flagValues.get(name);
    },
    registerTool() {},
    getAllTools() { return []; },
    setActiveTools() {},
    getActiveTools() { return []; },
    on() {},
  };
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
  })({
    host,
    appendEntry() {},
    async sendMessage() {},
    startKeepalive() {},
    stopKeepalive() {},
  });

  assert.equal(registered.has("ak-engine-model"), true, "Pi must accept --ak-engine-model");
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "cursor";
  try {
    assert.equal(
      resolveEngineName((name) => host.getFlag(name)),
      "cursor",
      "unset ak-engine flag must fall through to child-process env",
    );
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});
