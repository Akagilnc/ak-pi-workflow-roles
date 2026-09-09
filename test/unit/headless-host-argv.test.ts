import assert from "node:assert/strict";
import test from "node:test";

import {
  closeJsonSchemaForCodex,
  codexTurnArgs,
  headlessMcpConfigDocument,
} from "../../src/headless-host/description.ts";
import {
  parseCodexExecJsonl,
  parseCodexStructuredReceipt,
  parseHeadlessCliStdout,
} from "../../src/headless-host/role-turn-host.ts";
import { lookupHeadlessHostDescription, packagedExternalHostNames } from "../../src/host-descriptions.ts";

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

test("parseHeadlessCliStdout reads one json result envelope", () => {
  const doc = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sid",
    structured_output: { status: "completed", report: "ok" },
  });
  const result = parseHeadlessCliStdout(doc);
  assert.equal(result?.session_id, "sid");
  assert.deepEqual(result?.structured_output, { status: "completed", report: "ok" });
});

test("codex is a registered headless host row", () => {
  assert.ok(packagedExternalHostNames().includes("codex"));
  const row = lookupHeadlessHostDescription("codex");
  assert.equal(row?.protocol, "codex-exec");
  assert.equal(row?.sessionBindingFile, "codex-headless-session.json");
});

test("closeJsonSchemaForCodex closes objects and nulls every property", () => {
  const open = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "refused"] },
      report: { type: "string" },
      nested: {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        required: [],
        additionalProperties: true,
      },
    },
    required: [],
    additionalProperties: true,
  };
  const closed = closeJsonSchemaForCodex(open);
  assert.equal(closed.additionalProperties, false);
  assert.deepEqual(closed.required, ["status", "report", "nested"]);
  const props = closed.properties as Record<string, Record<string, unknown>>;
  const status = props.status!;
  const report = props.report!;
  const nested = props.nested!;
  // every property is anyOf[...typed leaves, null] — no untyped intermediate shells
  assert.ok(Array.isArray(status.anyOf));
  const statusBranches = status.anyOf as Record<string, unknown>[];
  assert.equal(statusBranches.at(-1)?.type, "null");
  assert.equal(statusBranches[0]!.type, "string");
  assert.deepEqual(statusBranches[0]!.enum, ["completed", "refused"]);
  assert.ok(Array.isArray(report.anyOf));
  assert.equal((report.anyOf as Record<string, unknown>[])[0]!.type, "string");
  assert.ok(Array.isArray(nested.anyOf));
  const nestedObject = (nested.anyOf as Record<string, unknown>[])[0]!;
  assert.equal(nestedObject.type, "object");
  assert.equal(nestedObject.additionalProperties, false);
  assert.deepEqual(nestedObject.required, ["note"]);
});

test("closeJsonSchemaForCodex maps Type.Unknown leaves to free JSON ref, not string", () => {
  // navigator-shaped open schema: candidates is description-only (Type.Unknown).
  const open = {
    type: "object",
    properties: {
      status: { description: "advice — shape guide" },
      candidates: { description: "ordered route advice array" },
    },
    required: [],
    additionalProperties: true,
  };
  const closed = closeJsonSchemaForCodex(open);
  const props = closed.properties as Record<string, Record<string, unknown>>;
  const candidates = props.candidates!;
  assert.ok(Array.isArray(candidates.anyOf));
  const branches = candidates.anyOf as Record<string, unknown>[];
  assert.equal(branches.at(-1)?.type, "null");
  // Must not coerce Unknown → string (lawful candidates are arrays).
  assert.equal(branches[0]!.$ref, "#/$defs/codexJsonValue");
  assert.notEqual(branches[0]!.type, "string");
  const defs = closed.$defs as Record<string, Record<string, unknown>>;
  assert.ok(defs.codexJsonValue);
  assert.ok(Array.isArray(defs.codexJsonValue.anyOf));
});

test("codexTurnArgs terminates options before positional prompt", () => {
  const args = codexTurnArgs({
    prompt: "- 准奏",
    systemPromptPath: "/tmp/sys.txt",
    outputSchemaPath: "/tmp/schema.json",
    mcpServers: [],
    session: { kind: "new" },
  });
  const promptAt = args.lastIndexOf("- 准奏");
  assert.ok(promptAt > 0);
  assert.equal(args[promptAt - 1], "--");
  // resume path also gets the terminator
  const resume = codexTurnArgs({
    prompt: "--sandbox none",
    systemPromptPath: "/tmp/sys.txt",
    outputSchemaPath: "/tmp/schema.json",
    mcpServers: [],
    session: { kind: "resume", id: "thread-1" },
  });
  assert.equal(resume[0], "exec");
  assert.equal(resume[1], "resume");
  const resumePromptAt = resume.lastIndexOf("--sandbox none");
  assert.equal(resume[resumePromptAt - 1], "--");
});

test("parseCodexExecJsonl takes thread_id, final agent_message, turn.failed", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "{\"status\":\"completed\",\"report\":\"ok\"}" },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n");
  const ok = parseCodexExecJsonl(stdout);
  assert.equal(ok.threadId, "thread-1");
  assert.equal(ok.turnCompleted, true);
  assert.equal(ok.finalMessage, "{\"status\":\"completed\",\"report\":\"ok\"}");
  assert.equal(ok.failureDiagnostic, undefined);
  assert.deepEqual(parseCodexStructuredReceipt(ok.finalMessage!), {
    status: "completed",
    report: "ok",
  });

  const failed = parseCodexExecJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thread-2" }),
    JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
  ].join("\n"));
  assert.equal(failed.threadId, "thread-2");
  assert.equal(failed.turnCompleted, false);
  assert.equal(failed.failureDiagnostic, "boom");

  // Non-terminal top-level error then turn.completed must not poison the receipt.
  const recovered = parseCodexExecJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thread-3" }),
    JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "{\"status\":\"completed\"}" },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n"));
  assert.equal(recovered.threadId, "thread-3");
  assert.equal(recovered.turnCompleted, true);
  assert.equal(recovered.failureDiagnostic, undefined);
  assert.equal(recovered.finalMessage, "{\"status\":\"completed\"}");
});
