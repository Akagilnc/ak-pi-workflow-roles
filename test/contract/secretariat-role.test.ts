/**
 * #924 Secretariat (中书省) — envelope-assembled tools; output records any payload as-is.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { SECRETARIAT_OUTPUT_TOOL_NAME, type SecretariatVerdict, type SecretariatVerdictParameters } from "../../src/secretariat-role.ts";
import type { SecretariatVerdict as TerminatingSecretariatVerdict } from "../../src/package-contracts/terminating-tools.ts";
import { createSecretariatRoleRuntime } from "../../src/role-runtime.ts";

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
  readonly activeTools: () => readonly string[];
};

async function activateSecretariat(options?: {
  /** Optional pre-existing host-surface tool names (no Pi-name hardcode in role). */
  readonly hostSurfaceTools?: readonly string[];
  readonly activationCount?: number;
}): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  let active: string[] = [...(options?.hostSurfaceTools ?? [])];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      const packageNames = [...tools.values()].map((t) => ({ name: t.name }));
      const hostOnly = (options?.hostSurfaceTools ?? [])
        .filter((name) => !tools.has(name))
        .map((name) => ({ name }));
      return [...hostOnly, ...packageNames];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
    getActiveTools() {
      return [...active];
    },
    getFlag() {
      return undefined;
    },
  };
  const runtime = createSecretariatRoleRuntime(roleHost as never, {
    loadSoul: async () => "中书省法",
  });
  for (let i = 0; i < (options?.activationCount ?? 1); i += 1) {
    await runtime.activate();
  }
  return { tools, activeTools: () => active };
}

const ctx = {
  cwd: "/work",
  mode: "json",
  model: undefined,
  sessionManager: {} as never,
  runDirectory: "/home/books/x/runs/01parent@secretariat",
  abort() {},
};

test("secretariat activation exposes only the terminating package tool (G6)", async () => {
  const { activeTools } = await activateSecretariat({
    hostSurfaceTools: ["host_read", "host_shell"],
    activationCount: 2,
  });
  const active = activeTools();
  assert.equal([...active].filter((name) => name === SECRETARIAT_OUTPUT_TOOL_NAME).length, 1);
  // Host surface preserved without role hardcoding builtin names.
  assert.ok(active.includes("host_read"));
  assert.ok(active.includes("host_shell"));
});

test("secretariat output records any status without shape reject (仓内 CLAUDE.md 开篇)", async () => {
  const { tools } = await activateSecretariat();
  const convergedReceipt: SecretariatVerdictParameters = { secretariatStatus: "converged", ticketNumber: "#924" };
  const converged = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c1",
    convergedReceipt,
    undefined,
    undefined,
    ctx,
  );
  assert.equal(converged.terminate, true);
  assert.deepEqual(converged.details, convergedReceipt);

  const receipt: SecretariatVerdict = {
    secretariatStatus: "escalate",
    ticketNumber: "#924",
    decisionGate: [
      { question: "拆不拆席？", options: ["暂不", "拆"] },
      { question: "留不留旧稿？", options: ["留", "不留"] },
    ],
    note: { answers: [], grounds: [], locations: [] },
    summary: { questionsPending: true },
    extra: [1, 2],
  };
  const parameters: SecretariatVerdictParameters = receipt;
  const terminatingReceipt: TerminatingSecretariatVerdict = parameters;
  const escalated = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c2",
    terminatingReceipt,
    undefined,
    undefined,
    ctx,
  );
  assert.equal(escalated.terminate, true);
  assert.deepEqual(escalated.details, receipt);

  // 仓内 CLAUDE.md 开篇 / #924: tool only records; non-canonical status is not code-rejected.
  const otherReceipt: SecretariatVerdictParameters = { secretariatStatus: "unexpected" };
  const other = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c3",
    otherReceipt,
    undefined,
    undefined,
    ctx,
  );
  assert.equal(other.terminate, true);
  assert.equal(
    (other.details as { secretariatStatus: string }).secretariatStatus,
    "unexpected",
  );
});
