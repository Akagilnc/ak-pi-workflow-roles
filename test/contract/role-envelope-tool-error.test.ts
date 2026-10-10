/**
 * #1214 A1: single package-tool execute error returns isError to the calling
 * seat session; it does not abort the round as infrastructure failure.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
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

test("#1214 R1: ledger record write failure at submission is round infrastructure failure, not a plain tool error", async () => {
  // The declared failure seam sets process.exitCode for print hosts; keep it local to this case.
  const priorExitCode = process.exitCode;
  const home = await mkdtemp(join(tmpdir(), "ak-1214-r1-"));
  try {
    const runDirectory = join(home, ".ak-roles", "books", "probe", "runs", "run-1214-r1@coder");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const socketPath = join(home, "mcp.sock");
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(sessionDir),
        activation: { role: "coder", phase: "apply" },
        methods: [],
        continuation: { kind: "initial", prompt: "r1 record failure" },
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
      // Block the run's record file after prepare: every ledger read/append on it now fails.
      await rm(join(runDirectory, "state.jsonl"), { force: true });
      await mkdir(join(runDirectory, "state.jsonl"));
      const token = mcpTokenFromPrepared(prepared);
      await callMcpTool({
        socketPath,
        token,
        name: CODER_OUTPUT_TOOL_NAME,
        args: { status: "completed" },
      });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "a record write failure must not close the round as accepted");
      assert.equal(
        "failure" in closed ? closed.failure?.identity?.name : undefined,
        "InfrastructureFailure",
        "record write failure must surface as the typed round infrastructure failure",
      );
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    await rm(home, { recursive: true, force: true });
  }
});
