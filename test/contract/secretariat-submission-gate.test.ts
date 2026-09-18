/**
 * #969 — non-pi Secretariat submission gate: converged → 给事中 via 既有交卷闸.
 * pi keeps mid-turn summon; only codex / claude / grok-build arm the gate on output.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SECRETARIAT_OUTPUT_TOOL_NAME } from "../../src/secretariat-contracts.ts";
import { createSecretariatRoleRuntime } from "../../src/role-runtime.ts";
import { ParentQueueReaskError } from "../../src/submission-errors.ts";

type GateCall = {
  readonly kind: string;
  readonly subject: unknown;
  readonly submission?: unknown;
};

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
  readonly gateCalls: GateCall[];
  readonly nonPass: unknown[];
};

async function activateSecretariat(options?: {
  readonly requireGate?: boolean;
}): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const gateCalls: GateCall[] = [];
  const nonPass: unknown[] = [];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      return [...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    getFlag() {
      return undefined;
    },
    ...(options?.requireGate === false
      ? {}
      : {
          async requireGatekeeperPass(call: {
            subject: { kind: string };
            submission?: unknown;
          }) {
            gateCalls.push({
              kind: call.subject.kind,
              subject: call.subject,
              ...(call.submission === undefined ? {} : { submission: call.submission }),
            });
          },
        }),
  };
  await createSecretariatRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "中书省职分（测试装载）" },
    {
      failInfrastructure(): never {
        throw new Error("fail");
      },
      bindSubmissionNonPass(_id, result) {
        nonPass.push(result);
      },
    },
  ).activate();
  return { tools, gateCalls, nonPass };
}

function ctx(host?: string) {
  return {
    cwd: "/tmp",
    mode: "json",
    model: undefined,
    sessionManager: {} as never,
    runDirectory: "/home/books/x/runs/01parent@secretariat",
    ...(host === undefined ? {} : { host }),
    abort() {},
  };
}

test("#969 codex converged arms secretariat_verdict gate with this-turn payload", async () => {
  const { tools, gateCalls } = await activateSecretariat();
  const payload = { secretariatStatus: "converged", ticketNumber: 969, note: "候选" };
  const result = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "call-codex",
    payload,
    undefined,
    undefined,
    ctx("codex"),
  );
  assert.equal(result.terminate, true);
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0]!.kind, "secretariat_verdict");
  assert.deepEqual(gateCalls[0]!.subject, { kind: "secretariat_verdict" });
  assert.deepEqual(gateCalls[0]!.submission, payload);
});

test("#969 claude and grok-build converged enter the same gate subject", async () => {
  for (const host of ["claude", "grok-build"] as const) {
    const { tools, gateCalls } = await activateSecretariat();
    await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
      `call-${host}`,
      { secretariatStatus: "converged", ticketNumber: 969 },
      undefined,
      undefined,
      ctx(host),
    );
    assert.equal(gateCalls.length, 1, `${host} must enter gate`);
    assert.equal(gateCalls[0]!.kind, "secretariat_verdict");
  }
});

test("#969 pi (and unset host) converged does not arm submission gate", async () => {
  for (const host of [undefined, "pi"] as const) {
    const { tools, gateCalls } = await activateSecretariat();
    const result = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
      "call-pi",
      { secretariatStatus: "converged", ticketNumber: 969 },
      undefined,
      undefined,
      ctx(host),
    );
    assert.equal(result.terminate, true);
    assert.equal(gateCalls.length, 0, `host=${String(host)} must keep pi mid-turn path`);
  }
});

test("#969 non-pi escalate skips gate and accepts as-is", async () => {
  const { tools, gateCalls } = await activateSecretariat();
  const payload = {
    secretariatStatus: "escalate",
    decisionGate: { question: "拆不拆？", options: ["暂不", "拆"] },
  };
  const result = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "call-esc",
    payload,
    undefined,
    undefined,
    ctx("codex"),
  );
  assert.equal(gateCalls.length, 0);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, payload);
});

test("#969 non-pi unreadable status reasks secretariat without gate", async () => {
  const { tools, gateCalls, nonPass } = await activateSecretariat();
  await assert.rejects(
    () =>
      tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
        "call-bad",
        { secretariatStatus: "unexpected" },
        undefined,
        undefined,
        ctx("codex"),
      ),
    (error: unknown) => error instanceof ParentQueueReaskError,
  );
  assert.equal(gateCalls.length, 0);
  assert.equal(nonPass.length, 0);
});
