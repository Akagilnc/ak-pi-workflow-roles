import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { openPiInstitutionalSession } from "../../src/pi/in-process-session.ts";
import type { HostInstitutionalSessionEvent } from "../../src/host-contracts.ts";

test("Pi institutional session: open, turn with usage stream event, and normal close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-test-pi-session-"));
  try {
    const faux = fauxProvider({ provider: "test-provider" });
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 0.1, output: 0.05, cacheRead: 0.02, cacheWrite: 0.01, total: 0.18 },
    };
    const response = fauxAssistantMessage("Hello from institutional session");
    response.usage = usage;
    faux.setResponses([response]);

    const sessionManager = SessionManager.inMemory(cwd);
    const mockModelRegistry = {
      find(provider: string, model: string) {
        return faux.getModel();
      },
      getProvider(provider: string) {
        return faux.provider;
      },
      async getProviderAuth(provider: string) {
        return { auth: { apiKey: "test-key" } };
      },
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "test-key" };
      },
    };

    const handle = await openPiInstitutionalSession({
      cwd,
      selection: { provider: "test-provider", model: "test-model" },
      systemPrompt: "You are a test officer.",
      sessionManager,
      modelRegistry: mockModelRegistry as any,
    });

    const events: HostInstitutionalSessionEvent[] = [];
    const unsubscribe = handle.subscribe((event) => {
      events.push(event);
    });

    const turn = await handle.prompt("Start turn");
    assert.ok(turn.usage !== undefined && turn.usage.input > 0);
    assert.ok(turn.usage.output > 0);

    // Verify stream event union received message_end with usage
    const msgEnd = events.find((e) => e.type === "message_end" && e.role === "assistant");
    assert.ok(msgEnd !== undefined && "usage" in msgEnd);
    assert.deepEqual(msgEnd.usage, turn.usage);

    unsubscribe();
    await handle.close();

    // Verify handle does not leak AgentSession / ModelRuntime / Provider
    assert.equal("session" in handle, false);
    assert.equal("modelRuntime" in handle, false);
    assert.equal("runtime" in handle, false);
    assert.equal("provider" in handle, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Pi institutional session: missing provider auth fails loud with original cause and no ambient fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-test-pi-session-auth-"));
  try {
    const sessionManager = SessionManager.inMemory(cwd);
    const authCause = new Error("credential lookup unavailable");
    const mockModelRegistry = {
      find() {
        return { provider: "unconfigured-prov", id: "unconfigured-model" };
      },
      getProvider() {
        return undefined;
      },
      async getProviderAuth() {
        throw authCause;
      },
      async getApiKeyAndHeaders() {
        return { ok: false as const, error: "No API key configured for unconfigured-prov" };
      },
    };

    await assert.rejects(
      () => openPiInstitutionalSession({
        cwd,
        selection: { provider: "unconfigured-prov", model: "unconfigured-model" },
        systemPrompt: "Officer prompt",
        sessionManager,
        modelRegistry: mockModelRegistry as any,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, authCause);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
