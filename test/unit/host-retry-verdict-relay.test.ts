/**
 * #813: non-pi last-mile adapters resume with shared-envelope retry.message.
 * No host-invented "Resubmit it" line; officer/correctable text is delivery-only.
 * Mechanical non-sole keeps the shared actionable resume text (not bare code).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  mechanicalSubmissionRejectionResumeMessage,
  NON_SOLE_ROUND_RESUME_MESSAGE,
  projectCorrectableExecuteRejection,
} from "../../src/submission-correctable-error.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

const OFFICER_VERDICT = JSON.stringify({
  status: "bounce",
  findings: ["missing commit evidence"],
  reason: "HEAD unchanged after claimed fix",
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

async function captureAcpResumePrompts(input: {
  readonly runDirectory: string;
  readonly firstRetry: {
    readonly code: string;
    readonly toolCallIds: readonly string[];
    readonly message: string;
  };
}): Promise<string[]> {
  const prompts: string[] = [];
  let closeRoundCalls = 0;
  const connection: AcpConnection = {
    async request(method, params) {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "sess-813" };
      if (method === "session/prompt") {
        const parts = params.prompt as ReadonlyArray<{ type?: string; text?: string }> | undefined;
        const text = parts?.map((part) => part.text ?? "").join("") ?? "";
        prompts.push(text);
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
          return { accepted: false as const, retry: input.firstRetry };
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

test("ACP resume prompt is shared officer retry.message (no host-invented resubmit line)", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-acp-officer-"));
  try {
    const prompts = await captureAcpResumePrompts({
      runDirectory,
      firstRetry: {
        code: "bounce",
        toolCallIds: ["call-1"],
        message: OFFICER_VERDICT,
      },
    });
    assert.deepEqual(prompts, ["initial-assignment", OFFICER_VERDICT]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("ACP resume prompt keeps shared mechanical non-sole message", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-acp-nonssole-"));
  try {
    const message = mechanicalSubmissionRejectionResumeMessage("non-sole-round");
    const prompts = await captureAcpResumePrompts({
      runDirectory,
      firstRetry: {
        code: "non-sole-round",
        toolCallIds: ["a", "b"],
        message,
      },
    });
    assert.deepEqual(prompts, ["initial-assignment", NON_SOLE_ROUND_RESUME_MESSAGE]);
    assert.notEqual(message, "non-sole-round");
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("mechanical non-sole resume message stays actionable and shared", () => {
  assert.equal(
    mechanicalSubmissionRejectionResumeMessage("non-sole-round"),
    NON_SOLE_ROUND_RESUME_MESSAGE,
  );
  // Not the bare internal code the bounce finding rejected.
  assert.notEqual(NON_SOLE_ROUND_RESUME_MESSAGE, "non-sole-round");
  assert.ok(NON_SOLE_ROUND_RESUME_MESSAGE.length > "non-sole-round".length);
  assert.equal(mechanicalSubmissionRejectionResumeMessage("other-code"), "other-code");
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
