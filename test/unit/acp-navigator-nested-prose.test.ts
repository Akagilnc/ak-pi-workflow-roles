/**
 * #959: ACP standard nested session/update must reach navigator prose ingest.
 * Real entry = createAcpRoleTurnHost; nested shape matches host-session-acp-write-fail fixture.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

const NESTED_PROSE = "下一步送 reviewer 独立审阅";

function baseRequest(runDirectory: string, home: string): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "navigator" },
    methods: [],
    continuation: { kind: "initial", prompt: "route?" },
    cwd: home,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

test("ACP nested agent_message_chunk reaches navigator prose ingest", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-959-acp-nested-prose-",
    runName: "run@navigator",
  });
  try {
    const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    let ingested: unknown;

    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-nav-sess" };
        if (method === "session/prompt") {
          for (const handler of notificationHandlers) {
            // Standard ACP shape (same nest as host-session-acp-write-fail.test.ts).
            handler("session/update", {
              sessionId: "acp-nav-sess",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: NESTED_PROSE },
              },
            });
          }
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        notificationHandlers.push(handler);
      },
      async close() {},
    };

    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      boundResume: "session/new",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => ledger.sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "navigator", materials: [] },
        prompt: "route?",
        jsonSchema: { type: "object" },
        terminatingToolName: NAVIGATOR_OUTPUT_TOOL_NAME,
        async ingestStructuredOutput(value) {
          ingested = value;
        },
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const result = await host.executeTurn(baseRequest(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.deepEqual(ingested, { prose: NESTED_PROSE });
  } finally {
    ledger.dispose();
  }
});

test("ACP flat sessionUpdate agent_message still reaches navigator prose ingest", async () => {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-959-acp-flat-prose-",
    runName: "run@navigator",
  });
  try {
    const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    let ingested: unknown;

    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-flat-sess" };
        if (method === "session/prompt") {
          for (const handler of notificationHandlers) {
            handler("session/update", {
              sessionId: "acp-flat-sess",
              sessionUpdate: "agent_message",
              content: { type: "text", text: "flat prose" },
            });
          }
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        notificationHandlers.push(handler);
      },
      async close() {},
    };

    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      boundResume: "session/new",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => ledger.sessionFile,
      },
      connect: async () => connection,
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio" }],
        systemPrompt: { body: "navigator", materials: [] },
        prompt: "route?",
        jsonSchema: { type: "object" },
        terminatingToolName: NAVIGATOR_OUTPUT_TOOL_NAME,
        async ingestStructuredOutput(value) {
          ingested = value;
        },
        async closeRound() {
          return { accepted: true as const };
        },
      }),
    });

    const result = await host.executeTurn(baseRequest(ledger.runDirectory, ledger.home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.deepEqual(ingested, { prose: "flat prose" });
  } finally {
    ledger.dispose();
  }
});
