/**
 * #813 / #820: external last-mile adapters resume with shared-envelope retry.message.
 * Tracer enters both ACP and headless RoleTurnHost.executeTurn faces; asserts the
 * external-visible next-round prompt only (change-locator middle owns the loop).
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
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

function preparedCloseRound(retryMessage: string) {
  let closeRoundCalls = 0;
  return async () => {
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
  };
}

function preparedTurn(prompt: string, closeRound: () => Promise<unknown>) {
  return {
    mcpServers: [{ name: "ak-probe", type: "stdio" as const, command: "/usr/bin/true", args: [] }],
    systemPrompt: { body: "probe", materials: [] as const },
    prompt,
    jsonSchema: { type: "object" },
    terminatingToolName: "ak_judge_output",
    async ingestStructuredOutput() {},
    closeRound: closeRound as never,
  };
}

async function captureAcpResumePrompts(runDirectory: string, retryMessage: string): Promise<string[]> {
  const prompts: string[] = [];
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
      async load() { return undefined; },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => connection,
    prepare: async () => preparedTurn("initial-assignment", preparedCloseRound(retryMessage)),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure, undefined, JSON.stringify(result));
  assert.equal(result.code, 0);
  return prompts;
}

/**
 * Minimal fake headless binary: records each `-p` prompt, emits one success envelope.
 * Production spawn path — no inject seam on the adapter.
 */
async function writeFakeHeadlessBinary(runDirectory: string, promptLog: string): Promise<string> {
  const binary = join(runDirectory, "fake-headless.sh");
  await writeFile(
    binary,
    `#!/bin/sh
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$arg"; fi
  prev="$arg"
done
printf '%s\\n' "$prompt" >> ${JSON.stringify(promptLog)}
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-headless","structured_output":{"ok":true}}'
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  return binary;
}

const HEADLESS_PROBE_DESCRIPTION: HeadlessHostDescription = {
  binaryFromHome: ["unused"],
  sessionBindingFile: "probe-headless-session.json",
  fixedArgs: [],
  promptFlag: "-p",
  modelFlag: "--model",
  effortFlag: "--effort",
  systemPromptFlag: "--system-prompt-file",
  jsonSchemaFlag: "--json-schema",
  mcpConfigFlag: "--mcp-config",
  sessionIdFlag: "--session-id",
  resumeFlag: "--resume",
};

async function captureHeadlessResumePrompts(runDirectory: string, retryMessage: string): Promise<string[]> {
  const promptLog = join(runDirectory, "prompts.log");
  const binary = await writeFakeHeadlessBinary(runDirectory, promptLog);
  const host = createHeadlessRoleTurnHost({
    description: HEADLESS_PROBE_DESCRIPTION,
    binary,
    sessionIdentity: {
      async load() { return undefined; },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    prepare: async () => preparedTurn("initial-assignment", preparedCloseRound(retryMessage)),
  });
  const result = await host.executeTurn(baseRequest(runDirectory));
  assert.equal(result.knownFailure, undefined, JSON.stringify(result));
  assert.equal(result.code, 0);
  const text = await readFile(promptLog, "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

test("ACP resume delivers opaque retry.message unchanged", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-820-acp-relay-"));
  try {
    const prompts = await captureAcpResumePrompts(runDirectory, OPAQUE_RETRY_MESSAGE);
    assert.deepEqual(prompts, ["initial-assignment", OPAQUE_RETRY_MESSAGE]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("headless resume delivers opaque retry.message unchanged", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-820-headless-relay-"));
  try {
    const prompts = await captureHeadlessResumePrompts(runDirectory, OPAQUE_RETRY_MESSAGE);
    assert.deepEqual(prompts, ["initial-assignment", OPAQUE_RETRY_MESSAGE]);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
