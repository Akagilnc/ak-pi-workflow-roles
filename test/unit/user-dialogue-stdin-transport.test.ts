/**
 * #879: user dialogue body reaches Pi/headless providers without occupying
 * one execve argv element (Linux MAX_ARG_STRLEN / E2BIG).
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codexTurnArgs,
  headlessTurnArgs,
} from "../../src/headless-host/description.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const BODY = JSON.stringify({
  status: "completed",
  report: "officer-peer-body",
  pad: "x".repeat(2048),
});

function turnRequest(runDirectory: string): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "inspector" },
    methods: [],
    continuation: { kind: "initial", prompt: BODY },
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

test("#879 Pi user dialogue rides stdin, not argv", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-879-pi-stdin-"));
  let captured:
    | { args: readonly string[]; stdin: string | undefined }
    | undefined;
  const host = createPiRoleTurnHost({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    spawnRunner: async (args, options) => {
      captured = { args, stdin: options.stdin };
      return { code: 0, stderr: "", timedOut: false };
    },
  });
  try {
    const result = await host.executeTurn(turnRequest(runDirectory));
    assert.equal(result.knownFailure, undefined);
    assert.ok(captured);
    assert.equal(captured.stdin, BODY);
    assert.equal(captured.args.includes(BODY), false);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("#879 Claude print argv keeps -p and omits the user body", () => {
  const description = lookupHeadlessHostDescription("claude");
  assert.ok(description && description.protocol === "claude-print");
  const argv = headlessTurnArgs({
    description,
    systemPromptPath: "/tmp/sys.txt",
    jsonSchema: { type: "object" },
    mcpConfigPath: "/tmp/mcp.json",
    session: { kind: "new", id: "sid" },
  });
  assert.ok(argv.includes("-p"));
  assert.equal(argv.includes(BODY), false);
});

test("#879 Codex exec argv asks stdin instead of embedding the user body", () => {
  const argv = codexTurnArgs({
    systemPromptPath: "/tmp/sys.txt",
    outputSchemaPath: "/tmp/out.json",
    mcpServers: [],
    session: { kind: "new" },
  });
  assert.equal(argv.includes(BODY), false);
  assert.deepEqual(argv.slice(-2), ["--", "-"]);
});

test("#879 Claude print executeTurn writes the user body on stdin", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-879-claude-stdin-"));
  const argvLog = join(runDirectory, "argv.log");
  const stdinLog = join(runDirectory, "stdin.log");
  const binary = join(runDirectory, "fake-claude");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
writeFileSync(${JSON.stringify(stdinLog)}, readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  session_id: "sid", structured_output: { status: "completed", report: "ok" },
}) + "\\n");
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  const description = lookupHeadlessHostDescription("claude");
  assert.ok(description);
  const host = createHeadlessRoleTurnHost({
    description,
    hostName: "claude",
    binary,
    sessionIdentity: {
      async load() { return undefined; },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    prepare: async (request) => ({
      mcpServers: [{ name: "ak-probe", command: process.execPath, args: ["-e", ""] }],
      systemPrompt: { body: "system", materials: [] },
      prompt: request.continuation.prompt,
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_inspector_output",
      async ingestStructuredOutput() {},
      async closeRound() { return { accepted: true as const }; },
    }),
  });
  try {
    const result = await host.executeTurn(turnRequest(runDirectory));
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(argv.includes(BODY), false);
    assert.equal(await readFile(stdinLog, "utf8"), BODY);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
