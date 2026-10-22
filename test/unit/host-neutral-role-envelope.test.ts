import assert from "node:assert/strict";
import test from "node:test";

import { AK_ROLE_ENGINE_ENV, resolveEngineName } from "../../src/engine-detour.ts";
import type { RoleHost } from "../../src/host-contracts.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";

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
    loadRoleSoul: async () => "judge",
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
