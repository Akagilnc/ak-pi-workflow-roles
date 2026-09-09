/**
 * #813: non-pi last-mile adapters resume with shared-envelope retry.message.
 * No host-invented "Resubmit it" line; officer/correctable text is delivery-only.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { projectCorrectableExecuteRejection } from "../../src/submission-correctable-error.ts";
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

test("ACP resume prompt is shared retry.message (no host-invented resubmit line)", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-acp-"));
  const prompts: string[] = [];
  let closeRoundCalls = 0;
  try {
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
                message: OFFICER_VERDICT,
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
    assert.deepEqual(prompts, ["initial-assignment", OFFICER_VERDICT]);
    assert.equal(prompts.some((text) => text.includes("Resubmit it")), false);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("headless resume prompt is shared retry.message (no host-invented resubmit line)", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-813-headless-"));
  const promptsPath = join(runDirectory, "prompts.jsonl");
  const binaryPath = join(runDirectory, "fake-headless.sh");
  let closeRoundCalls = 0;
  try {
    // Shell fake stays under unit budget; no second Node cold-start per turn.
    await writeFile(
      binaryPath,
      `#!/bin/sh
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then
    prompt="$arg"
  fi
  prev="$arg"
done
printf '%s\n' "$prompt" >> ${JSON.stringify(promptsPath)}
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"headless-sess-813","structured_output":{"status":"completed","report":"ok"}}'
`,
      "utf8",
    );
    await chmod(binaryPath, 0o755);

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

    const host = createHeadlessRoleTurnHost({
      description,
      binary: binaryPath,
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
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
                message: OFFICER_VERDICT,
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

    const lines = (await readFile(promptsPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.deepEqual(lines, ["initial-assignment", OFFICER_VERDICT]);
    assert.equal(lines.some((text) => text.includes("Resubmit it")), false);
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
