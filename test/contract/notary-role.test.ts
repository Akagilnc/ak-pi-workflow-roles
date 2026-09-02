import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTARY_OUTPUT_TOOL_NAME,
  notaryDecisiveFacts,
  projectLawfulNotaryOutput,
  retainNotarySubmission,
  validateRecordedNotaryOutput,
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

/**
 * #621 acceptance surface — mechanical typed keys only (status + named findings).
 * Fixture findings are clause pointers the role leg already produced; this seam
 * must retain them so bounce/pass can name the clause without free-text scraping.
 */
test("#621 notaryDecisiveFacts retains bounce/pass status and named findings", () => {
  const scenarios = [
    {
      label: "rebuild-session-without-quote",
      output: {
        status: "bounce" as const,
        findings: ["Scope 2 重建会话：票面无陛下原话"],
      },
    },
    {
      label: "adr-name-without-key",
      output: {
        status: "bounce" as const,
        findings: ["ADR 0077 名主张统一格式：无绑定 key"],
      },
    },
    {
      label: "misaligned-but-both-quoted",
      output: {
        status: "pass" as const,
        findings: ["判词与票面对不上但两者均有原话：不对齐不归符宝郎"],
      },
    },
    {
      label: "dk3-three-axes-quoted",
      output: {
        status: "pass" as const,
        findings: [],
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const recorded = validateRecordedNotaryOutput(scenario.output);
    assert.equal(recorded.status, scenario.output.status, scenario.label);
    const facts = notaryDecisiveFacts(recorded);
    assert.equal(facts.status, scenario.output.status, scenario.label);
    assert.equal(facts.officer, "notary", scenario.label);
    assert.deepEqual(facts.findings, scenario.output.findings, scenario.label);
  }
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

test("Notary activate registers source-run flag + tool; ticket flag is envelope-owned", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  // Role module owns source-run only (baseline); ticket lifecycle is envelope-owned.
  assert.equal(h.flags.has("ak-notary-source-run"), true);
  assert.equal(h.flags.has("ak-notary-ticket-number"), false);

  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  await runtime.activate();
  assert.ok(h.tools.has(NOTARY_OUTPUT_TOOL_NAME));
  assert.ok(h.beforeStart());
});

test("Notary agent-start projects envelope-admitted ticket into readingMaterial", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  // Ticket arrives as admitted value from envelope — role never getFlag's it.
  await runtime.activate({ ticketNumber: 582 });
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

test("Notary agent-start omits ticket when envelope admits none", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  await runtime.activate();
  const result = h.beforeStart()!({ systemPrompt: "BASE" }) as {
    readingMaterial?: ReturnType<typeof projectNotarySessionBound>;
  };
  assert.deepEqual(
    result.readingMaterial,
    projectNotarySessionBound({ sourceRun: LOCATOR }),
  );
  assert.equal(result.readingMaterial?.ticketNumber, undefined);
});
