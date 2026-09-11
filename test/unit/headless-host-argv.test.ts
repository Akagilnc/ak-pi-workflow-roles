import assert from "node:assert/strict";
import test from "node:test";

import { headlessMcpConfigDocument } from "../../src/headless-host/description.ts";
import { parseHeadlessCliStdout } from "../../src/headless-host/role-turn-host.ts";

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
