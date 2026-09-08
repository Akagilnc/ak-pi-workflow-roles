import assert from "node:assert/strict";
import test from "node:test";

import {
  headlessMcpConfigDocument,
  headlessTurnArgs,
} from "../../src/headless-host/description.ts";
import {
  extractSystemInitEvent,
  parseHeadlessCliStdout,
} from "../../src/headless-host/role-turn-host.ts";
import { HEADLESS_HOST_DESCRIPTIONS } from "../../src/host-descriptions.ts";
import { terminatingToolJsonSchema } from "../../src/acp-host/role-envelope.ts";

test("claude headless argv carries schema, system-prompt file, mcp-config, model, effort, session", () => {
  const description = HEADLESS_HOST_DESCRIPTIONS.claude;
  assert.ok(description);
  const args = headlessTurnArgs({
    description,
    prompt: "do the work",
    systemPromptPath: "/tmp/sys.txt",
    jsonSchema: { type: "object", properties: { status: { type: "string" } } },
    mcpConfigPath: "/tmp/mcp.json",
    model: "sonnet",
    effort: "low",
    session: { kind: "new", id: "11111111-1111-1111-1111-111111111111" },
  });
  assert.equal(args[0], "-p");
  assert.equal(args[1], "do the work");
  assert.ok(args.includes("--system-prompt-file"));
  assert.equal(args[args.indexOf("--system-prompt-file") + 1], "/tmp/sys.txt");
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--mcp-config"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/mcp.json");
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.ok(args.includes("--effort"));
  assert.equal(args[args.indexOf("--effort") + 1], "low");
  assert.ok(args.includes("--session-id"));
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("bypassPermissions"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--setting-sources"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  // resume uses --resume, not --session-id
  const resumeArgs = headlessTurnArgs({
    description,
    prompt: "again",
    systemPromptPath: "/tmp/sys.txt",
    jsonSchema: { type: "object" },
    session: { kind: "resume", id: "22222222-2222-2222-2222-222222222222" },
  });
  assert.ok(resumeArgs.includes("--resume"));
  assert.ok(!resumeArgs.includes("--session-id"));
});

test("headless MCP config projects ACP env rows into Claude object shape", () => {
  const doc = headlessMcpConfigDocument([
    {
      name: "ak-fixer",
      command: "/usr/bin/node",
      args: ["/path/mcp-relay.mjs"],
      env: [
        { name: "AK_ACP_MCP_SOCKET", value: "/tmp/s.sock" },
        { name: "AK_ACP_MCP_TOKEN", value: "tok" },
      ],
    },
  ]);
  assert.deepEqual(doc, {
    mcpServers: {
      "ak-fixer": {
        command: "/usr/bin/node",
        args: ["/path/mcp-relay.mjs"],
        env: {
          AK_ACP_MCP_SOCKET: "/tmp/s.sock",
          AK_ACP_MCP_TOKEN: "tok",
        },
      },
    },
  });
});

test("parseHeadlessCliStdout prefers result envelope; extractSystemInit finds init", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", mcp_servers: [], plugins: [] }),
    JSON.stringify({ type: "assistant", message: { content: "x" } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sid",
      structured_output: { status: "completed", report: "ok" },
    }),
  ].join("\n");
  const result = parseHeadlessCliStdout(stream);
  assert.equal(result?.session_id, "sid");
  assert.deepEqual(result?.structured_output, { status: "completed", report: "ok" });
  const init = extractSystemInitEvent(stream) as { subtype?: string; mcp_servers?: unknown };
  assert.equal(init?.subtype, "init");
  assert.deepEqual(init?.mcp_servers, []);
});

test("terminatingToolJsonSchema forces draft-07 even when parameters declare another meta-schema", () => {
  const schema = terminatingToolJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { status: { type: "string" } },
  });
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.type, "object");
});
