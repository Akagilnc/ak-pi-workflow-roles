import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTARY_OUTPUT_TOOL_NAME,
  projectLawfulNotaryOutput,
  retainNotarySubmission,
} from "../../src/notary-contracts.ts";
import {
  assembleNotaryAgentStart,
  createNotaryRoleRuntime,
  projectNotarySessionBound,
  readNotaryTicketFlag,
} from "../../src/notary-role.ts";

const LOCATOR = {
  runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
  runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
  role: "judge",
} as const;

/** Shared mock-Pi harness for the Notary runtime (reused by contract tests). */
function notaryHarness() {
  const flags = new Map<string, string>();
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const pi = {
    registerFlag(name: string) { flags.set(name, ""); },
    getFlag(name: string) { return flags.get(name); },
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) { if (event === "before_agent_start") beforeStart = handler; },
    getAllTools() { return [{ name: NOTARY_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }]; },
  };
  return { flags, tools, pi, beforeStart: () => beforeStart };
}

test("projectLawfulNotaryOutput projects pass/bounce; non-release retained as-is", () => {
  assert.equal(projectLawfulNotaryOutput({ status: "pass", findings: [] })?.status, "pass");
  const bounce = projectLawfulNotaryOutput({ status: "bounce", findings: ["x"] });
  assert.equal(bounce?.status, "bounce");
  // ADR 0055 / 第 0 条: no shape admission throw — non-release stays undefined projection.
  assert.equal(projectLawfulNotaryOutput({ status: "incomplete", reason: "missing draft" }), undefined);
  assert.equal(projectLawfulNotaryOutput({ status: "maybe" }), undefined);
  assert.equal(projectLawfulNotaryOutput(null), undefined);
  const raw = { status: "maybe", note: "not an explicit release" };
  assert.deepEqual(retainNotarySubmission(raw), raw);
});

test("readNotaryTicketFlag + projectNotarySessionBound + assembleNotaryAgentStart typed ticket", () => {
  assert.equal(readNotaryTicketFlag(undefined), undefined);
  assert.equal(readNotaryTicketFlag(""), undefined);
  assert.equal(readNotaryTicketFlag("582"), 582);
  assert.throws(() => readNotaryTicketFlag("0"));
  assert.throws(() => readNotaryTicketFlag("nope"));

  const bound = projectNotarySessionBound({
    sourceRun: LOCATOR,
    ticketNumber: 582,
  });
  assert.equal(bound.ticketNumber, 582);
  assert.equal(bound.sourceRun, LOCATOR);

  const assembled = assembleNotaryAgentStart({
    baseSystemPrompt: "BASE",
    soul: "LAW",
    bound,
  });
  // Typed half of the production seam — same object encoded into systemPrompt.
  assert.equal(assembled.bound.ticketNumber, 582);
  assert.equal(assembled.bound, bound);
  assert.equal(typeof assembled.systemPrompt, "string");
  assert.ok(assembled.systemPrompt.length > 0);
});

test("Notary activate: blank ticket unbound; valid ticket wires flag; invalid ticket fails", async () => {
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

  // Valid ticket flag is accepted on re-activate (readNotaryTicketFlag on activate path).
  h.flags.set("ak-notary-ticket-number", "582");
  await runtime.activate();
  assert.ok(h.beforeStart());

  // Invalid non-empty ticket fails honestly on activate (same reader as bound assembly).
  h.flags.set("ak-notary-ticket-number", "nope");
  await assert.rejects(() => runtime.activate());
});
