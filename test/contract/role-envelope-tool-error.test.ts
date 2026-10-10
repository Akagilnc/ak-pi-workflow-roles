/**
 * #1214 A1: single package-tool execute error returns isError to the calling
 * seat session; it does not abort the round as infrastructure failure.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REPORT_TICKET_TOOL_NAME } from "../../src/report-ticket-tool.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { callMcpTool, mcpTokenFromPrepared } from "../helpers/mcp-tool-call.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("#1214 A1: tool execute error returns isError without round infrastructure abort", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-1214-a1-"));
  try {
    const runDirectory = join(home, ".ak-roles", "books", "probe", "runs", "run-1214-a1@coder");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const socketPath = join(home, "mcp.sock");
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(sessionDir),
        activation: { role: "coder", phase: "apply" },
        methods: [],
        continuation: { kind: "initial", prompt: "a1 tool error" },
        cwd: packageRoot,
        home,
        agentDir: join(home, "agent"),
        runDirectory,
        stationChild: true,
        host: "codex",
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath,
      listTerminatingToolOnMcp: true,
      sessionFile: join(sessionDir, "session.jsonl"),
      principalAuthority: piDurablePrincipalAuthority,
    });
    try {
      const token = mcpTokenFromPrepared(prepared);
      // Unidentifiable ticketNumber → report-ticket throws ordinary execute Error.
      const reply = await callMcpTool({
        socketPath,
        token,
        name: REPORT_TICKET_TOOL_NAME,
        args: { ticketNumber: "not-a-ticket" },
      });
      assert.equal(reply.isError, true, "tool error must surface as isError result");
      assert.equal(
        "error" in reply && reply.error !== undefined,
        false,
        "tool execute error must not be an MCP protocol error",
      );
      const closed = await prepared.closeRound();
      assert.equal(
        "failure" in closed && closed.failure !== undefined,
        false,
        "single tool execute error must not become round infrastructure failure",
      );
      assert.equal(
        "retry" in closed && (closed as { retry?: unknown }).retry !== undefined,
        false,
        "#1214 F3: ordinary tool isError must not arm typed rejection retry",
      );
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
