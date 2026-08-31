import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTARY_OUTPUT_TOOL_NAME,
  projectLawfulNotaryOutput,
  retainNotarySubmission,
} from "../../src/notary-contracts.ts";
import {
  createNotaryRoleRuntime,
  projectNotaryBoundFromFlags,
  projectNotarySessionBound,
  readNotaryTicketFlag,
} from "../../src/notary-role.ts";

const LOCATOR = {
  runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
  runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
  role: "judge",
} as const;

/** Shared mock-Pi harness for the Notary runtime. */
function notaryHarness() {
  const flags = new Map<string, string>();
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const pi = {
    registerFlag(name: string) { flags.set(name, ""); },
    getFlag(name: string) { return flags.get(name); },
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) {
      if (event === "before_agent_start") beforeStart = handler;
    },
    getAllTools() { return [{ name: NOTARY_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }]; },
  };
  return { flags, tools, pi, beforeStart: () => beforeStart };
}

test("projectLawfulNotaryOutput projects pass/bounce; non-release retained as-is", () => {
  assert.equal(projectLawfulNotaryOutput({ status: "pass", findings: [] })?.status, "pass");
  const bounce = projectLawfulNotaryOutput({ status: "bounce", findings: ["x"] });
  assert.equal(bounce?.status, "bounce");
  assert.equal(projectLawfulNotaryOutput({ status: "incomplete", reason: "missing draft" }), undefined);
  assert.equal(projectLawfulNotaryOutput({ status: "maybe" }), undefined);
  assert.equal(projectLawfulNotaryOutput(null), undefined);
  const raw = { status: "maybe", note: "not an explicit release" };
  assert.deepEqual(retainNotarySubmission(raw), raw);
});

test("projectNotaryBoundFromFlags + ticket reader: blank unbound; valid binds; invalid throws", () => {
  assert.equal(readNotaryTicketFlag(undefined), undefined);
  assert.equal(readNotaryTicketFlag(""), undefined);
  assert.equal(readNotaryTicketFlag("582"), 582);
  assert.throws(() => readNotaryTicketFlag("nope"));

  const flags = new Map<string, string>([
    ["ak-notary-source-run", LOCATOR.runDirectory],
    ["ak-notary-ticket-number", "582"],
  ]);
  const bound = projectNotaryBoundFromFlags((name) => flags.get(name));
  assert.deepEqual(bound, {
    sourceRunPath: LOCATOR.runDirectory,
    ticketNumber: 582,
  });
  assert.deepEqual(
    projectNotarySessionBound({ sourceRun: LOCATOR, ticketNumber: 582 }).ticketNumber,
    582,
  );
});

test("Notary activate registers tool; invalid ticket flag fails on activate path", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  await runtime.activate();
  assert.ok(h.tools.has(NOTARY_OUTPUT_TOOL_NAME));
  assert.ok(h.beforeStart());

  h.flags.set("ak-notary-ticket-number", "nope");
  await assert.rejects(() => runtime.activate());
});

test("Notary agent-start returns typed readingMaterial bound; ticket optional until flagged", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  h.flags.set("ak-notary-ticket-number", "582");
  await runtime.activate();
  const result = h.beforeStart()!({ systemPrompt: "BASE" }) as {
    systemPrompt?: string;
    readingMaterial?: ReturnType<typeof projectNotarySessionBound>;
  };
  assert.equal(typeof result.systemPrompt, "string");
  assert.deepEqual(
    result.readingMaterial,
    projectNotarySessionBound({ sourceRun: LOCATOR, ticketNumber: 582 }),
  );
});
