/**
 * #813: ACP last-mile resumes with shared-envelope retry.message.
 * Fake ACP connection only — single process, no spawn (unit size).
 * Headless dual-entry proof: test/integration/host-retry-verdict-relay.test.ts (#820).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

/** Opaque payload — not a production free-text template under test. */
const OPAQUE_RETRY_MESSAGE = JSON.stringify({
  status: "bounce",
  findings: ["opaque finding"],
  reason: "opaque retry payload",
});

function baseRequest(runDirectory: string): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "initial-assignment" },
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

async function captureAcpResumePrompts(runDirectory: string, retryMessage: string): Promise<string[]> {
  const prompts: string[] = [];
  let closeRoundCalls = 0;
  const connection: AcpConnection = {
    async request(method, params) {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "sess-813" };
      if (method === "session/prompt") {
        const parts = params.prompt as ReadonlyArray<{ type?: string; text?: string }> | undefined;
        prompts.push(parts?.map((part) => part.text ?? "").join("") ?? "");
        return { stopReason: "end_turn" };
      }
      if (method === "session/close") return {};
      return {};
    },
    notify() {},
    async close() {},
  };
  const host = createAcpRoleTurnHost({
    modelPassing: "argv",
    boundResume: "session/new",
    sessionIdentity: {
      async load() {
        return undefined;
      },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => connection,
    prepare: async () => ({
      mcpServers: [{ name: "ak-probe", type: "stdio" }],
      systemPrompt: { body: "probe", materials: [] },
      prompt: "initial-assignment",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() {
        closeRoundCalls += 1;
        if (closeRoundCalls === 1) {
          return {
            accepted: false as const,
            retry: {
              code: "bounce",
              toolCallIds: ["call-1"],
              message: retryMessage,
            },
          };
        }
        return { accepted: true as const };
      },
    }),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure, undefined, JSON.stringify(result));
  assert.equal(result.code, 0);
  return prompts;
}

test("ACP resume delivers opaque retry.message unchanged", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-acp-relay-"));
  try {
    const prompts = await captureAcpResumePrompts(runDirectory, OPAQUE_RETRY_MESSAGE);
    assert.deepEqual(prompts, ["initial-assignment", OPAQUE_RETRY_MESSAGE]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
