import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_OBSERVE_TOOL, createCollectorRoleRuntime } from "../../src/collector-role.ts";
import type { CollectorClock } from "../../src/collector-evidence.ts";
import { createFakeGitHubTransport, samplePull, sampleUser } from "../helpers/fake-github-transport.ts";

function clock(): CollectorClock {
  return { wallNow: () => new Date("2026-01-01T00:00:00Z"), monoNow: () => 0, sleep: async () => undefined };
}

test("Collector failed reactivation clears a previously successful real role activation", async () => {
  const flags = new Map<string, unknown>([["ak-collector-repo", "acme/widgets"], ["ak-collector-pr", "1"]]);
  const tools = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => flags.get(name),
    getCommands: () => [],
    getAllTools: () => [...tools.values()],
    registerTool: (tool: any) => tools.set(tool.name, tool),
    setActiveTools: (names: string[]) => { active = names; },
    getActiveTools: () => active,
    on() {},
  };
  const runtime = createCollectorRoleRuntime(pi as any, {
    loadSoul: async () => "Collector soul",
    createTransport: () => createFakeGitHubTransport({ user: sampleUser(), pullRequest: samplePull(), reviews: [], issueComments: [], reviewComments: [] }),
    createClock: clock,
  }, { failInfrastructure(error: unknown): never { throw error; } });
  const context = { mode: "print" } as any;

  await runtime.activate(context, { reason: "new" });
  flags.delete("ak-collector-repo");
  await assert.rejects(() => runtime.activate(context, { reason: "new" }), /requires --ak-collector-repo/);
  await assert.rejects(() => tools.get(COLLECTOR_OBSERVE_TOOL).execute("call", {}, undefined, undefined), /not activated/);
});
