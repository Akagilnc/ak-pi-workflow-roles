/**
 * #813: non-pi last-mile adapters resume with shared-envelope retry.message.
 * Transport only: opaque payload passthrough at the ACP host seam.
 * Headless last-mile is the same assignment (`prompt = closure.retry.message`);
 * class scan + delivery true-run cover it — no parallel production spawn inject.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { projectCorrectableExecuteRejection } from "../../src/submission-correctable-error.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

/** Opaque payload — not a production free-text template under test. */
const OFFICER_VERDICT = JSON.stringify({
  status: "bounce",
  findings: ["missing commit evidence"],
  reason: "HEAD unchanged after claimed fix",
});

const MECHANICAL_RETRY_TEXT = "mechanical-retry-payload";

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

async function captureAcpResumePrompts(input: {
  readonly runDirectory: string;
  readonly firstRetryMessage: string;
  readonly firstRetryCode?: string;
}): Promise<string[]> {
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
      resolveSessionFile: () => join(input.runDirectory, "session", "session.jsonl"),
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
              code: input.firstRetryCode ?? "bounce",
              toolCallIds: ["call-1"],
              message: input.firstRetryMessage,
            },
          };
        }
        return { accepted: true as const };
      },
    }),
  });
  const result = await host.executeTurn(baseRequest(input.runDirectory));
  assert.equal(result.knownFailure, undefined, JSON.stringify(result));
  assert.equal(result.code, 0);
  return prompts;
}

test("ACP resume delivers opaque officer retry.message unchanged", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-acp-officer-"));
  try {
    const prompts = await captureAcpResumePrompts({
      runDirectory,
      firstRetryMessage: OFFICER_VERDICT,
    });
    assert.deepEqual(prompts, ["initial-assignment", OFFICER_VERDICT]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("ACP resume delivers opaque mechanical retry.message unchanged", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-acp-mech-"));
  try {
    const prompts = await captureAcpResumePrompts({
      runDirectory,
      firstRetryCode: "non-sole-round",
      firstRetryMessage: MECHANICAL_RETRY_TEXT,
    });
    assert.deepEqual(prompts, ["initial-assignment", MECHANICAL_RETRY_TEXT]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("correctable bounce projection keeps officer receipt as diagnostic text", () => {
  const receipt = {
    status: "bounce",
    findings: ["missing commit evidence"],
    reason: "HEAD unchanged after claimed fix",
  };
  const projected = projectCorrectableExecuteRejection(
    new GatekeeperDecisionError({
      status: "bounce",
      officer: "inspector",
      receipt,
    }),
  );
  assert.equal(projected.diagnostic, JSON.stringify(receipt));
  assert.equal(projected.details.status, "bounce");
});
