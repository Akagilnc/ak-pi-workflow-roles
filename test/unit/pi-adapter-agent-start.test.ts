import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderAgentStartMaterials } from "../../src/agent-start-materials.ts";
import { projectNotaryAuditedRunIdentity } from "../../src/notary-role.ts";
import { createPiRoleHostAdapter } from "../../src/pi/adapter.ts";
import { createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { encodeUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

/** Pi runner createContext() returns a fresh object per emit/tool (extensions runner). */
function freshExtensionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    mode: "agent",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => cwd,
      getSessionFile: () => undefined,
      getHeader: () => null,
      setSessionFile() {},
      appendCustomEntry() {},
    },
    abort() {},
  } as unknown as ExtensionContext;
}

/** Minimal Pi surface: capture handlers / tools as the adapter registration path. */
function piCapture() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  let registeredTool: ToolDefinition | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool(tool: ToolDefinition) {
      registeredTool = tool;
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
    getActiveTools() {
      return [];
    },
    sendMessage() {},
  };
  const ctx = freshExtensionContext("/tmp/pi-adapter-agent-start");
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    ctx,
    getRegisteredTool: () => registeredTool,
  };
}

test("Pi adapter folds readingMaterial into provider systemPrompt and strips the typed field", async () => {
  const bound = projectNotaryAuditedRunIdentity({
    sourceRun: {
      runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
      runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
      role: "judge",
    },
  });
  const otherBound = projectNotaryAuditedRunIdentity({
    sourceRun: {
      runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@coder",
      runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
      role: "coder",
    },
  });

  async function providerVisible(returnValue: {
    systemPrompt?: string;
    readingMaterial?: unknown;
  }): Promise<{ systemPrompt?: string } & Record<string, unknown>> {
    const { pi, handlers, ctx } = piCapture();
    const adapter = createPiRoleHostAdapter(pi);
    adapter.host.on("before_agent_start", () => returnValue);
    const handler = handlers.get("before_agent_start")?.[0];
    assert.ok(handler);
    const result = await handler(
      { prompt: "", systemPrompt: "BASE", systemPromptOptions: {} },
      ctx,
    );
    assert.ok(result && typeof result === "object");
    return result as { systemPrompt?: string } & Record<string, unknown>;
  }

  const bodyOnly = await providerVisible({ systemPrompt: "BASE" });
  const withBound = await providerVisible({
    systemPrompt: "BASE",
    readingMaterial: bound,
  });
  const withOther = await providerVisible({
    systemPrompt: "BASE",
    readingMaterial: otherBound,
  });
  const { pi, handlers, ctx } = piCapture();
  const adapter = createPiRoleHostAdapter(pi);
  adapter.host.on("before_agent_start", () => ({ readingMaterial: bound }));
  adapter.host.on("before_agent_start", () => ({ readingMaterial: otherBound }));
  let currentSystemPrompt = "BASE";
  for (const handler of handlers.get("before_agent_start") ?? []) {
    const result = await handler(
      { prompt: "", systemPrompt: currentSystemPrompt, systemPromptOptions: {} },
      ctx,
    );
    if (result?.systemPrompt !== undefined) currentSystemPrompt = result.systemPrompt;
  }

  // Empty materials: body passthrough; typed field never reaches Pi.
  assert.equal(bodyOnly.systemPrompt, "BASE");
  assert.equal("readingMaterial" in bodyOnly, false);

  // Materials change the provider-visible prompt; distinct materials differ.
  // No free-text/substring lock — only external equality/inequality on the wire form.
  assert.equal("readingMaterial" in withBound, false);
  assert.equal(typeof withBound.systemPrompt, "string");
  assert.notEqual(withBound.systemPrompt, bodyOnly.systemPrompt);
  assert.notEqual(withBound.systemPrompt, withOther.systemPrompt);
  assert.equal(
    currentSystemPrompt,
    renderAgentStartMaterials(
      renderAgentStartMaterials("BASE", [bound]),
      [otherBound],
    ),
  );
});

test("#879 Pi adapter unpacks typed stdin once; collision body stays intact at agent-start", async () => {
  const collision = encodeUserDialogueStdin("ACTUAL");
  const wrapped = encodeUserDialogueStdin(collision);
  const { pi, handlers, ctx } = piCapture();
  const adapter = createPiRoleHostAdapter(pi);
  const seenInputs: string[] = [];
  let seenPrompt: string | undefined;
  adapter.host.on("input", (event) => {
    seenInputs.push(event.text);
    return { action: "continue" as const };
  });
  adapter.host.on("input", (event) => {
    seenInputs.push(event.text);
    return { action: "continue" as const };
  });
  adapter.host.on("before_agent_start", (event) => {
    seenPrompt = event.prompt;
    return {};
  });

  const inputHandlers = handlers.get("input");
  assert.ok(inputHandlers);
  let inputEvent = { text: wrapped, source: "piped" };
  for (const inputHandler of inputHandlers) {
    const result = await inputHandler(inputEvent, ctx);
    if (result?.action === "transform") inputEvent = { ...inputEvent, text: result.text };
  }
  assert.deepEqual(seenInputs, [collision, collision]);
  assert.equal(inputEvent.text, collision);

  const startHandler = handlers.get("before_agent_start")?.[0];
  assert.ok(startHandler);
  await startHandler(
    { prompt: collision, systemPrompt: "BASE", systemPromptOptions: {} },
    ctx,
  );
  assert.equal(seenPrompt, collision);
});

test("#1199 Pi adapter shares this-turn 传召词 across fresh ExtensionContext projections", async () => {
  const prior = process.env.AK_ROLE_SUMMONS_INSTRUCTION;
  delete process.env.AK_ROLE_SUMMONS_INSTRUCTION;
  try {
    const { pi, handlers, getRegisteredTool } = piCapture();
    const adapter = createPiRoleHostAdapter(pi);
    const seen: Array<string | undefined> = [];

    // Observe only — transport decode on the adapter sets the turn field.
    adapter.host.on("input", (_event, hostCtx) => {
      seen.push(hostCtx.summonsInstruction);
      return { action: "continue" as const };
    });
    adapter.host.on("before_agent_start", (_event, hostCtx) => {
      seen.push(hostCtx.summonsInstruction);
      return {};
    });
    adapter.host.registerTool({
      name: "ak-probe-summons",
      label: "probe",
      description: "probe this-turn summons across fresh tool ctx",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _update, hostCtx) {
        seen.push(hostCtx.summonsInstruction);
        // 催交 updates the same turn-input responsibility (no env body).
        hostCtx.summonsInstruction = "催交-same-turn";
        return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
      },
    });

    const summons = "this-turn summons bytes for seal";
    const transport = `${summons}\n\n--attach /tmp/pi-adapter-summons.json`;
    const inputHandlers = handlers.get("input");
    assert.ok(inputHandlers);
    let inputEvent = { text: encodeUserDialogueStdin(transport, summons), source: "piped" };
    const inputCtx = freshExtensionContext("/tmp/pi-adapter-summons-input");
    for (const inputHandler of inputHandlers) {
      const result = await inputHandler(inputEvent, inputCtx);
      if (result?.action === "transform") inputEvent = { ...inputEvent, text: result.text };
    }
    assert.equal(inputEvent.text, transport);

    const start = handlers.get("before_agent_start")?.[0];
    assert.ok(start);
    const startCtx = freshExtensionContext("/tmp/pi-adapter-summons-start");
    assert.notEqual(inputCtx, startCtx);
    await start({ prompt: transport, systemPrompt: "", systemPromptOptions: {} }, startCtx);

    const tool = getRegisteredTool();
    assert.ok(tool);
    const toolCtx = freshExtensionContext("/tmp/pi-adapter-summons-tool") as ExtensionToolContext;
    assert.notEqual(toolCtx, inputCtx);
    assert.notEqual(toolCtx, startCtx);
    await tool.execute("probe-1", {}, undefined, undefined, toolCtx);

    const after催交Ctx = freshExtensionContext("/tmp/pi-adapter-summons-after");
    adapter.host.on("agent_end", (_event, hostCtx) => {
      seen.push(hostCtx.summonsInstruction);
    });
    const agentEnd = handlers.get("agent_end")?.[0];
    assert.ok(agentEnd);
    await agentEnd({ messages: [] }, after催交Ctx);

    assert.deepEqual(seen, [summons, summons, summons, "催交-same-turn"]);
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
