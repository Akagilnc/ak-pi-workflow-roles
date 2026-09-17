/**
 * #959: ACP session/update agent speech reaches navigator prose ingest.
 * Real entry = createAcpRoleTurnHost. Nested shape matches host-session-acp-write-fail.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

const CASES = [
  {
    name: "nested agent_message_chunk",
    params: {
      sessionId: "acp-nav-sess",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "下一步送 reviewer 独立审阅" },
      },
    },
    expected: "下一步送 reviewer 独立审阅",
  },
  {
    name: "flat agent_message",
    params: {
      sessionId: "acp-flat-sess",
      sessionUpdate: "agent_message",
      content: { type: "text", text: "flat prose" },
    },
    expected: "flat prose",
  },
] as const;

async function runNavigatorProseIngest(
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const ledger = createTempPackageHomeLedger({
    prefix: "ak-959-acp-prose-",
    runName: "run@navigator",
  });
  try {
    const handlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
    let ingested: unknown;
    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "acp-sess" };
        if (method === "session/prompt") {
          for (const handler of handlers) handler("session/update", params);
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      onNotification(handler) {
        handlers.push(handler);
      },
      async close() {},
    };
    const request: RoleTurnRequest = {
      principal: fixturePrincipal(join(ledger.runDirectory, "session")),
      activation: { role: "navigator" },
      methods: [],
      continuation: { kind: "initial", prompt: "route?" },
      cwd: ledger.home,
      home: ledger.home,
      agentDir: join(ledger.runDirectory, "agent"),
      runDirectory: ledger.runDirectory,
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
    const result = await host.executeTurn(request);
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    return ingested;
  } finally {
    ledger.dispose();
  }
}

for (const sample of CASES) {
  test(`ACP ${sample.name} reaches navigator prose ingest`, async () => {
    assert.deepEqual(await runNavigatorProseIngest(sample.params), { prose: sample.expected });
  });
}
