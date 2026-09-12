/**
 * #820 change-locator headless face: shared retry loop via real executeTurn spawn.
 * ACP face (same opaque retry.message assertion, fake connection, unit size):
 * test/unit/host-retry-verdict-relay.test.ts — together they cover both families.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

/** Same opaque payload as the unit ACP tracer — not a free-text template. */
const OPAQUE_RETRY_MESSAGE = JSON.stringify({
  status: "bounce",
  findings: ["opaque finding"],
  reason: "opaque retry payload",
});

function baseRequest(runDirectory: string, home: string): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "initial-assignment" },
    cwd: runDirectory,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

const HEADLESS_PROBE_DESCRIPTION: HeadlessHostDescription = {
  protocol: "claude-print",
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

async function writeFakeHeadlessBinary(runDirectory: string, promptLog: string): Promise<string> {
  const binary = join(runDirectory, "fake-headless.sh");
  await writeFile(
    binary,
    `#!/bin/sh
prompt=$(cat)
printf '%s\\n' "$prompt" >> ${JSON.stringify(promptLog)}
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-headless","structured_output":{"ok":true}}'
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  return binary;
}

test("headless executeTurn delivers opaque retry.message on resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-820-headless-relay-"));
  const runDirectory = join(home, ".ak-roles", "books", "probe", "runs", "run-headless");
  await mkdir(runDirectory, { recursive: true });
  try {
    const promptLog = join(runDirectory, "prompts.log");
    const binary = await writeFakeHeadlessBinary(runDirectory, promptLog);
    let closeRoundCalls = 0;
    const host = createHeadlessRoleTurnHost({
      description: HEADLESS_PROBE_DESCRIPTION,
      hostName: "claude",
      binary,
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
      },
      prepare: async () => ({
        mcpServers: [{ name: "ak-probe", type: "stdio", command: "/usr/bin/true", args: [] }],
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
                message: OPAQUE_RETRY_MESSAGE,
              },
            };
          }
          return { accepted: true as const };
        },
      }),
    });
    const result = await host.executeTurn(baseRequest(runDirectory, home));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
    const prompts = (await readFile(promptLog, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    assert.deepEqual(prompts, ["initial-assignment", OPAQUE_RETRY_MESSAGE]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
