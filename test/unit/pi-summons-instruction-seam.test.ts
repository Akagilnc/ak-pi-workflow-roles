/**
 * #1199: this-turn 传召词 reaches seal via HostContext / input seam — not env body,
 * not process-global body state, not argv (execve ARG_MAX / E2BIG).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiRoleHostAdapter } from "../../src/pi/adapter.ts";
import { createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { encodeUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function piCapture() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool() {},
    getAllTools() {
      return [];
    },
    setActiveTools() {},
    getActiveTools() {
      return [];
    },
    sendMessage() {},
  };
  const ctx = {
    cwd: "/tmp/pi-summons-instruction-seam",
    mode: "agent",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => "/tmp/pi-summons-instruction-seam",
      getSessionFile: () => undefined,
      getHeader: () => null,
      setSessionFile() {},
      appendCustomEntry() {},
    },
    abort() {},
  } as unknown as ExtensionContext;
  return { pi: pi as unknown as ExtensionAPI, handlers, ctx };
}

test("#1199 Pi HostContext keeps input-seam 传召词 across re-projection without env body", async () => {
  const prior = process.env.AK_ROLE_SUMMONS_INSTRUCTION;
  delete process.env.AK_ROLE_SUMMONS_INSTRUCTION;
  try {
    const { pi, handlers, ctx } = piCapture();
    const adapter = createPiRoleHostAdapter(pi);
    const seen: Array<string | undefined> = [];
    adapter.host.on("input", (event, hostCtx) => {
      hostCtx.summonsInstruction = event.text;
      seen.push(hostCtx.summonsInstruction);
      return { action: "continue" as const };
    });
    adapter.host.on("before_agent_start", (_event, hostCtx) => {
      seen.push(hostCtx.summonsInstruction);
      return {};
    });

    const body = "this-turn summons bytes for seal";
    const inputHandlers = handlers.get("input");
    assert.ok(inputHandlers);
    let inputEvent = { text: encodeUserDialogueStdin(body), source: "piped" };
    for (const inputHandler of inputHandlers) {
      const result = await inputHandler(inputEvent, ctx);
      if (result?.action === "transform") inputEvent = { ...inputEvent, text: result.text };
    }
    const start = handlers.get("before_agent_start")?.[0];
    assert.ok(start);
    await start({ prompt: body, systemPrompt: "", systemPromptOptions: {} }, ctx);

    assert.deepEqual(seen, [body, body]);
    assert.equal(process.env.AK_ROLE_SUMMONS_INSTRUCTION, undefined);
  } finally {
    if (prior === undefined) delete process.env.AK_ROLE_SUMMONS_INSTRUCTION;
    else process.env.AK_ROLE_SUMMONS_INSTRUCTION = prior;
  }
});

test("#1199 Pi spawn env must not carry summons body (stdin already holds dialogue)", async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const host = createPiRoleTurnHost({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    spawnRunner: async (_args, options) => {
      capturedEnv = options.env;
      return { code: 0, stderr: "", timedOut: false };
    },
  });
  const huge = "x".repeat(200_000);
  await host.executeTurn({
    home: "/tmp/pi-summons-no-env-body",
    agentDir: "/tmp/pi-summons-no-env-body/agent",
    cwd: "/tmp/pi-summons-no-env-body/cwd",
    runDirectory: "/tmp/pi-summons-no-env-body/run",
    principal: fixturePrincipal("/tmp/pi-summons-no-env-body/session"),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: huge },
    summonsInstruction: huge,
  });
  assert.ok(capturedEnv);
  assert.equal(capturedEnv.AK_ROLE_SUMMONS_INSTRUCTION, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(capturedEnv, "AK_ROLE_SUMMONS_INSTRUCTION"),
    false,
  );
});
