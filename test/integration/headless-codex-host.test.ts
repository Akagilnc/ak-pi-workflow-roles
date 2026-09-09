/**
 * #646 codex headless host entry seam (medium): fake CLI subprocess.
 * Spawns a local fake `codex` binary twice — not a unit test.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

/**
 * Fake codex binary → createHeadlessRoleTurnHost entry seam.
 * Covers new→thread bind→structured receipt, then resume argv + second receipt.
 * Asserts external visible results + critical argv facts (not full shape lock).
 */
test("codex headless executeTurn: new binds thread_id, resume reuses it, receipt accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-codex-host-"));
  const argvLog = join(root, "argv.log");
  const fakeBin = join(root, "fake-codex");
  // Node script: log argv; emit JSONL receipt. resume vs new distinguished by argv.
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
const isResume = args[0] === "exec" && args[1] === "resume";
const thread = isResume ? args[2] : "thread-fake-1";
const report = isResume ? "resumed-ok" : "first-ok";
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: thread }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: JSON.stringify({ status: "completed", report }) },
  }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
];
process.stdout.write(lines.join("\\n") + "\\n");
process.exit(0);
`,
    "utf8",
  );
  await chmod(fakeBin, 0o755);

  try {
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    let bound: string | undefined;
    let ingested: unknown;
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: fakeBin,
      sessionIdentity: {
        async load() {
          return bound;
        },
        async bind(_principal, sessionId) {
          bound = sessionId;
        },
        resolveSessionFile: () => join(root, "session.jsonl"),
      },
      prepare: async () => ({
        mcpServers: [
          {
            name: "ak-probe",
            command: "/usr/bin/node",
            args: ["/tmp/relay.mjs"],
            env: [{ name: "AK_ACP_MCP_SOCKET", value: "/tmp/s.sock" }],
          },
        ],
        systemPrompt: { body: "sys", materials: [] },
        prompt: "do-work",
        jsonSchema: {
          type: "object",
          properties: { status: { type: "string" }, report: { type: "string" } },
          required: [],
          additionalProperties: true,
        },
        terminatingToolName: "ak_probe_output",
        async ingestStructuredOutput(params) {
          ingested = params;
        },
        async closeRound() {
          if (
            typeof ingested === "object"
            && ingested !== null
            && (ingested as { status?: unknown }).status === "completed"
          ) {
            return { accepted: true as const };
          }
          return {
            accepted: false as const,
            failure: {
              cause: "output" as const,
              identity: { name: "MissingSubmission", code: "round-ended-without-submission" },
            },
          };
        },
      }),
    });

    const baseRequest: RoleTurnRequest = {
      principal: fixturePrincipal(join(root, "session")),
      activation: { role: "inspector" },
      methods: [],
      continuation: { kind: "initial", prompt: "do-work" },
      model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
      cwd: root,
      home: root,
      agentDir: join(root, "agent"),
      runDirectory: root,
    };

    const first = await host.executeTurn(baseRequest);
    assert.equal(first.knownFailure, undefined, JSON.stringify(first));
    assert.equal(first.code, 0);
    assert.equal(bound, "thread-fake-1");
    assert.deepEqual(ingested, { status: "completed", report: "first-ok" });

    // Closed schema file materialized for --output-schema.
    const schemaRaw = await readFile(join(root, "headless-output-schema.json"), "utf8");
    const schema = JSON.parse(schemaRaw) as { additionalProperties?: unknown; required?: unknown };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["status", "report"]);

    const firstArgv = JSON.parse((await readFile(argvLog, "utf8")).trim().split("\n")[0]!) as string[];
    assert.equal(firstArgv[0], "exec");
    assert.notEqual(firstArgv[1], "resume");
    assert.ok(firstArgv.includes("--json"));
    assert.ok(firstArgv.includes("--ignore-user-config"));
    assert.ok(firstArgv.includes("--ignore-rules"));
    // --ignore-user-config/--ignore-rules do not stop AGENTS.md discovery
    // (official codex exec --help); project_doc_max_bytes=0 is required too.
    assert.ok(firstArgv.some((a) => a === "project_doc_max_bytes=0"));
    assert.ok(firstArgv.includes("--output-schema"));
    assert.ok(firstArgv.includes("--sandbox"));
    assert.ok(firstArgv.includes("-m"));
    assert.ok(firstArgv.includes("gpt-test"));
    // MCP injection rides -c mcp_servers.*; required=true so silent drop is impossible.
    assert.ok(firstArgv.some((a) => a.startsWith("mcp_servers.ak-probe.command=")));
    assert.ok(firstArgv.some((a) => a === "mcp_servers.ak-probe.required=true"));
    assert.ok(firstArgv.some((a) => a.startsWith("model_instructions_file=")));
    assert.ok(firstArgv.some((a) => a.startsWith("approval_policy=")));
    assert.ok(firstArgv.some((a) => a.startsWith("sandbox_mode=")));
    assert.ok(firstArgv.some((a) => a.startsWith("model_reasoning_effort=")));
    // Option terminator before positional prompt (dash-prefixed prompts).
    const firstPromptAt = firstArgv.lastIndexOf("do-work");
    assert.ok(firstPromptAt > 0);
    assert.equal(firstArgv[firstPromptAt - 1], "--");
    // Worktree git common dir is injected as an extra writable root when present.
    // (Temp dir here is not a git worktree — absence is lawful; presence asserted in true worktree runs.)

    // Resume turn: bound thread_id must become `exec resume <id>`.
    ingested = undefined;
    const second = await host.executeTurn({
      ...baseRequest,
      continuation: { kind: "resume", prompt: "continue" },
    });
    assert.equal(second.knownFailure, undefined, JSON.stringify(second));
    assert.equal(second.code, 0);
    assert.equal(bound, "thread-fake-1");
    assert.deepEqual(ingested, { status: "completed", report: "resumed-ok" });

    const lines = (await readFile(argvLog, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const resumeArgv = JSON.parse(lines[1]!) as string[];
    assert.equal(resumeArgv[0], "exec");
    assert.equal(resumeArgv[1], "resume");
    assert.equal(resumeArgv[2], "thread-fake-1");
    assert.ok(resumeArgv.includes("--output-schema"));
    assert.ok(resumeArgv.includes("--ignore-user-config"));
    assert.ok(resumeArgv.some((a) => a === "project_doc_max_bytes=0"));
    // resume has no --sandbox flag; permissions still via -c
    assert.equal(resumeArgv.includes("--sandbox"), false);
    assert.ok(resumeArgv.some((a) => a.startsWith("sandbox_mode=")));
    assert.ok(resumeArgv.some((a) => a === "mcp_servers.ak-probe.required=true"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
