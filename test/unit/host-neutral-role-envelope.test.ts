import assert from "node:assert/strict";
import test from "node:test";

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
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(envelopeHost);

  assert.ok(flags.has("ak-role"));
  assert.ok(handlers.some(([event]) => event === "session_start"));
  assert.ok(handlers.some(([event]) => event === "turn_end"));
});
