import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiRoleHostAdapter } from "../../src/pi/adapter.ts";
import { projectNotarySessionBound } from "../../src/notary-role.ts";
import { encodeUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";

/** Minimal Pi surface: capture before_agent_start as the provider-visible return path. */
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
    cwd: "/tmp/pi-adapter-agent-start",
    mode: "agent",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => "/tmp/pi-adapter-agent-start",
      getSessionFile: () => undefined,
      getHeader: () => null,
      setSessionFile() {},
      appendCustomEntry() {},
    },
    abort() {},
  } as unknown as ExtensionContext;
  return { pi: pi as unknown as ExtensionAPI, handlers, ctx };
}

test("Pi adapter folds readingMaterial into provider systemPrompt and strips the typed field", async () => {
  const bound = projectNotarySessionBound({
    sourceRun: {
      runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
      runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
      role: "judge",
    },
    ticketNumber: 582,
  });
  const otherBound = projectNotarySessionBound({
    sourceRun: bound.sourceRun,
    ticketNumber: 999,
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

  // Empty materials: body passthrough; typed field never reaches Pi.
  assert.equal(bodyOnly.systemPrompt, "BASE");
  assert.equal("readingMaterial" in bodyOnly, false);

  // Materials change the provider-visible prompt; distinct materials differ.
  // No free-text/substring lock — only external equality/inequality on the wire form.
  assert.equal("readingMaterial" in withBound, false);
  assert.equal(typeof withBound.systemPrompt, "string");
  assert.notEqual(withBound.systemPrompt, bodyOnly.systemPrompt);
  assert.notEqual(withBound.systemPrompt, withOther.systemPrompt);
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
