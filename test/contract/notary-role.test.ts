import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTARY_OUTPUT_TOOL_NAME,
  projectLawfulNotaryOutput,
  retainNotarySubmission,
} from "../../src/notary-contracts.ts";
import {
  createNotaryRoleRuntime,
  NOTARY_SESSION_BOUND_ENTRY,
  projectNotarySessionBound,
  readNotaryTicketFlag,
} from "../../src/notary-role.ts";
import type { HostContext } from "../../src/host-contracts.ts";

const LOCATOR = {
  runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
  runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
  role: "judge",
} as const;

/** Shared mock-Pi harness for the Notary runtime (reused by contract tests). */
function notaryHarness() {
  const flags = new Map<string, string>();
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  const customEntries: Array<{ type: string; data: unknown }> = [];
  let beforeStart:
    | ((event: { systemPrompt: string }, ctx: HostContext) => unknown)
    | undefined;
  const pi = {
    registerFlag(name: string) { flags.set(name, ""); },
    getFlag(name: string) { return flags.get(name); },
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on(
      event: string,
      handler: (event: { systemPrompt: string }, ctx: HostContext) => unknown,
    ) {
      if (event === "before_agent_start") beforeStart = handler;
    },
    getAllTools() { return [{ name: NOTARY_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }]; },
  };
  function makeCtx(): HostContext {
    return {
      cwd: "/tmp",
      mode: "test",
      model: undefined,
      sessionManager: {
        getLeafEntry: () => undefined,
        getLeafId: () => null,
        getEntries: () => [],
        getSessionDir: () => "/tmp",
        getSessionFile: () => undefined,
        appendCustomEntry(type: string, data?: unknown) {
          customEntries.push({ type, data });
          return undefined;
        },
      },
      abort() {},
    };
  }
  return { flags, tools, pi, beforeStart: () => beforeStart, customEntries, makeCtx };
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

test("Notary activate flag→before_agent_start writes typed session bound with ticket", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  h.flags.set("ak-notary-ticket-number", "582");
  await runtime.activate();
  assert.ok(h.tools.has(NOTARY_OUTPUT_TOOL_NAME));

  const handler = h.beforeStart();
  assert.ok(handler);
  // Real agent-start path: handler runs and retains typed bound on the session ledger.
  handler!({ systemPrompt: "BASE" }, h.makeCtx());
  assert.equal(h.customEntries.length, 1);
  assert.equal(h.customEntries[0]!.type, NOTARY_SESSION_BOUND_ENTRY);
  const bound = h.customEntries[0]!.data as ReturnType<typeof projectNotarySessionBound>;
  assert.equal(bound.ticketNumber, 582);
  assert.deepEqual(bound.sourceRun, LOCATOR);
  assert.deepEqual(
    bound,
    projectNotarySessionBound({ sourceRun: LOCATOR, ticketNumber: 582 }),
  );
});

test("Notary activate rejects invalid ticket flag; blank stays unbound in session bound", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  await runtime.activate();
  h.beforeStart()!({ systemPrompt: "BASE" }, h.makeCtx());
  const unbound = h.customEntries[0]!.data as { ticketNumber?: number };
  assert.equal(unbound.ticketNumber, undefined);

  h.flags.set("ak-notary-ticket-number", "nope");
  await assert.rejects(() => runtime.activate());
  assert.equal(readNotaryTicketFlag("582"), 582);
  assert.equal(readNotaryTicketFlag(""), undefined);
});
