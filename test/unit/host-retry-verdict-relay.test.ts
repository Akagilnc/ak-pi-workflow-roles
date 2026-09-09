/**
 * #813: non-pi last-mile adapters resume with shared-envelope retry.message.
 * Transport only: opaque payload passthrough. No free-text presentation locks.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import {
  createHeadlessRoleTurnHost,
  type HeadlessTurnSpawn,
} from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { mechanicalSubmissionRejectionResumeMessage } from "../../src/submission-correctable-error.ts";
import { projectCorrectableExecuteRejection } from "../../src/submission-correctable-error.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

/** Opaque officer payload — not a production free-text template under test. */
const OFFICER_VERDICT = JSON.stringify({
  status: "bounce",
  findings: ["missing commit evidence"],
  reason: "HEAD unchanged after claimed fix",
});

/** Opaque mechanical payload supplied by the shared envelope, observed as transport bytes. */
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

function promptFlagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag}`);
  return args[index + 1] ?? "";
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

async function captureHeadlessResumePrompts(input: {
  readonly runDirectory: string;
  readonly firstRetryMessage: string;
}): Promise<string[]> {
  const prompts: string[] = [];
  let closeRoundCalls = 0;
  const description: HeadlessHostDescription = {
    binaryFromHome: ["fake"],
    sessionBindingFile: "binding.json",
    fixedArgs: ["--output-format", "json"],
    promptFlag: "-p",
    modelFlag: "--model",
    effortFlag: "--effort",
    systemPromptFlag: "--system-prompt-file",
    jsonSchemaFlag: "--json-schema",
    mcpConfigFlag: "--mcp-config",
    sessionIdFlag: "--session-id",
    resumeFlag: "--resume",
  };
  const spawnTurn: HeadlessTurnSpawn = async (options) => {
    prompts.push(promptFlagValue(options.args, "-p"));
    return {
      code: 0,
      stdout: `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "headless-sess-813",
        structured_output: { status: "completed", report: "ok" },
      })}\n`,
      stderr: "",
      timedOut: false,
    };
  };
  const host = createHeadlessRoleTurnHost({
    description,
    binary: "fake-binary",
    spawnTurn,
    sessionIdentity: {
      async load() {
        return undefined;
      },
      async bind() {},
      resolveSessionFile: () => join(input.runDirectory, "session", "session.jsonl"),
    },
    prepare: async () => ({
      mcpServers: [],
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

test("headless resume delivers opaque retry.message unchanged", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-headless-"));
  try {
    const prompts = await captureHeadlessResumePrompts({
      runDirectory,
      firstRetryMessage: OFFICER_VERDICT,
    });
    assert.deepEqual(prompts, ["initial-assignment", OFFICER_VERDICT]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("mechanical non-sole code selects a dedicated resume branch", () => {
  // Structured branch only: non-sole is not the identity path used for unknown codes.
  // Does not lock presentation bytes of the dedicated branch.
  const unknown = mechanicalSubmissionRejectionResumeMessage("other-code");
  assert.equal(unknown, "other-code");
  const nonSole = mechanicalSubmissionRejectionResumeMessage("non-sole-round");
  assert.notEqual(nonSole, "non-sole-round");
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
