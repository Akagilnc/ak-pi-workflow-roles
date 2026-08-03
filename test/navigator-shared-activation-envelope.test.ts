import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ActivationBarrierError,
  createRoleRuntimeExtension,
  NAVIGATOR_EVIDENCE_TOOL_NAME,
  NAVIGATOR_OUTPUT_TOOL_NAME,
} from "../src/role-runtime.ts";
import { canonicalSnapshotDigestV1 } from "../src/navigator-contracts.ts";
import { sha256Hex } from "../src/sha256.ts";

const bytes = new TextEncoder().encode("frozen evidence");
const base = {
  version: 1 as const,
  capturedAt: "2025-01-01T00:00:00.000Z",
  runId: "018f22a0-7b4c-7abc-8def-0123456789ab",
  subject: { repositoryRoot: "/r", github: { owner: "o", name: "r", id: "R" }, parent: { number: 1, id: "I" } },
  children: [],
  parentObservation: { state: "open" as const, labels: [], observedAt: "2025-01-01T00:00:00.000Z", query: { transport: "github_rest" as const, operation: "issue" } },
  labelPolicy: [],
  workspaces: [{ id: "w", root: "/r", relation: "repository" as const, head: "a".repeat(40), target: "a".repeat(40) }],
  evidence: [{ id: "e", kind: "input" as const, sha256: sha256Hex(bytes), provenance: { kind: "declared" as const, reference: "x" }, handle: "h" }],
  positionCursor: 0,
  latestAttempt: null,
};
const snapshot = { ...base, digest: canonicalSnapshotDigestV1(base) };

type Failure = "clear" | "flag" | "soul" | "snapshot" | "evidence" | "collision" | "register-first" | "register-second" | "prompt" | "narrow" | "verify";

function harness(failure?: Failure) {
  const flags = new Map<string, unknown>([["ak-role", "navigator"], ["ak-navigator-snapshot", "snapshot.json"]]);
  if (failure === "flag") flags.delete("ak-navigator-snapshot");
  const tools = new Map<string, any>();
  if (failure === "collision") tools.set(NAVIGATOR_OUTPUT_TOOL_NAME, { name: NAVIGATOR_OUTPUT_TOOL_NAME });
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  let active = ["host-tool"];
  let registrations = 0;
  let emptyNarrowings = 0;
  let aborts = 0;
  const pi = {
    registerFlag() {},
    getFlag(name: string) { return flags.get(name); },
    registerTool(definition: any) {
      registrations += 1;
      if ((failure === "register-first" && registrations === 1) || (failure === "register-second" && registrations === 2)) throw new Error("tool registration failed");
      tools.set(definition.name, definition);
    },
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    setActiveTools(names: string[]) {
      if (names.length === 0) {
        emptyNarrowings += 1;
        if (failure === "clear" && emptyNarrowings === 1) throw new Error("initial tool clearing failed");
      }
      active = names;
      if (failure === "narrow" && names.length > 0) throw new Error("tool narrowing failed");
    },
    getActiveTools() { return failure === "verify" && active.length > 0 ? [NAVIGATOR_EVIDENCE_TOOL_NAME] : active; },
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      if (failure === "prompt" && name === "before_agent_start" && handlers.has(name)) throw new Error("prompt installation failed");
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
  };
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "unused",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    loadNavigatorSoul: async () => failure === "soul" ? "   " : "NAVIGATOR LAW",
    loadNavigatorSnapshot: async () => failure === "snapshot" ? { ...snapshot, digest: "0".repeat(64) } : snapshot,
    loadNavigatorEvidence: async () => failure === "evidence" ? new Map() : new Map([["h", bytes]]),
  })(pi as unknown as ExtensionAPI);
  const ctx = { mode: "interactive", cwd: "/r", abort() { aborts += 1; } } as unknown as ExtensionContext;
  return {
    ctx,
    active: () => active,
    aborts: () => aborts,
    tools,
    before: () => handlers.get("before_agent_start") ?? [],
    async start() {
      const starts = handlers.get("session_start") ?? [];
      assert.equal(starts.length, 1);
      await starts[0]!({}, ctx);
    },
  };
}

test("the shared envelope admits Navigator state, narrows tools, and installs its prompt", async () => {
  const h = harness();
  await h.start();
  assert.deepEqual(h.active(), [NAVIGATOR_EVIDENCE_TOOL_NAME, NAVIGATOR_OUTPUT_TOOL_NAME]);
  assert.deepEqual([...h.tools.keys()], [NAVIGATOR_EVIDENCE_TOOL_NAME, NAVIGATOR_OUTPUT_TOOL_NAME]);
  assert.equal(h.before().length, 2);
  const installed = (await Promise.all(h.before().map((before) => before({ systemPrompt: "BASE" }, {} as ExtensionContext))))
    .find((result) => result?.systemPrompt);
  assert.match(installed.systemPrompt, /NAVIGATOR LAW/);
  assert.match(installed.systemPrompt, /current_position_snapshot/);
});

for (const failure of ["clear", "flag", "soul", "snapshot", "evidence", "collision", "register-first", "register-second", "prompt", "narrow", "verify"] as const) {
  test(`Navigator ${failure} startup failure terminates through infrastructure and leaves no prompt or active tool`, async () => {
    const h = harness(failure);
    await assert.rejects(h.start());
    assert.equal(h.aborts(), 1);
    assert.equal(process.exitCode, undefined);
    assert.deepEqual(h.active(), []);
    const [barrier, prompt] = h.before();
    assert.ok(barrier);
    await assert.rejects(
      async () => barrier({ systemPrompt: "BASE" }, h.ctx),
      (error: unknown) => error instanceof ActivationBarrierError && error.code === "AK_ACTIVATION_NOT_ADMITTED",
    );
    if (prompt !== undefined) assert.equal(await prompt({ systemPrompt: "BASE" }, h.ctx), undefined);
    for (const tool of h.tools.values()) {
      if (typeof tool.execute === "function") await assert.rejects(tool.execute("x", { evidenceId: "e" }), /not activated/);
    }
  });
}
