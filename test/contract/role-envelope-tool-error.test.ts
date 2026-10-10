/**
 * #1214 A1: single package-tool execute error returns isError to the calling
 * seat session; it does not abort the round as infrastructure failure.
 * #1214 R1/R1b: real ledger / ticket-bind / report-ticket accounting failures
 * close the round as typed InfrastructureFailure (not plain isError).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { REPORT_TICKET_TOOL_NAME } from "../../src/report-ticket-tool.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { callMcpTool, mcpTokenFromPrepared } from "../helpers/mcp-tool-call.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { seedCurrentSection } from "../helpers/run-dossier-fixture.ts";

const R1B_TICKET = 1214;

/** Unbound leaf + durable identity pages so bind/relocate can start, then fail on I/O. */
async function prepareUnboundEnvelope(
  home: string,
  leaf: string,
  role: "coder" | "diarist",
) {
  const bookRoot = join(home, ".ak-roles", "books", "probe");
  const runDirectory = join(bookRoot, "unbound", "runs", leaf);
  const sessionDir = join(runDirectory, "session");
  await mkdir(sessionDir, { recursive: true });
  const runId = leaf.includes("@") ? leaf.slice(0, leaf.lastIndexOf("@")) : leaf;
  const identity = {
    role,
    runId,
    bookKey: "probe",
    projectRoot: packageRoot,
  };
  seedCurrentSection(runDirectory, "invocation", identity);
  seedCurrentSection(runDirectory, "admitted", identity);
  const socketPath = join(home, `mcp-${role}.sock`);
  const prepared = await prepareRoleEnvelope({
    request: {
      principal: fixturePrincipal(sessionDir),
      activation: role === "coder"
        ? { role: "coder", phase: "apply" }
        : { role: "diarist" },
      methods: [],
      continuation: { kind: "initial", prompt: leaf },
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
  return { prepared, socketPath, bookRoot, runDirectory };
}

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

test("#1214 R1b: independent ak_report_ticket bind/relocate I/O failure is round infrastructure failure", async () => {
  const priorExitCode = process.exitCode;
  const home = await mkdtemp(join(tmpdir(), "ak-1214-r1b-rt-"));
  try {
    const { prepared, socketPath, bookRoot } = await prepareUnboundEnvelope(
      home,
      "run-1214-r1b-rt@coder",
      "coder",
    );
    try {
      // Block the ticket subject path so relocate cannot create the destination tree.
      await writeFile(join(bookRoot, String(R1B_TICKET)), "blocked-ticket-leaf");
      const token = mcpTokenFromPrepared(prepared);
      await callMcpTool({
        socketPath,
        token,
        name: REPORT_TICKET_TOOL_NAME,
        args: { ticketNumber: R1B_TICKET },
      });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "report-ticket I/O failure must not close as accepted");
      assert.equal(
        "failure" in closed ? closed.failure?.identity?.name : undefined,
        "InfrastructureFailure",
        "report-ticket bind/relocate I/O must surface as typed round infrastructure failure",
      );
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    await rm(home, { recursive: true, force: true });
  }
});

test("#1214 R1b: submission-time ticket bind/relocate I/O failure is round infrastructure failure", async () => {
  const priorExitCode = process.exitCode;
  const home = await mkdtemp(join(tmpdir(), "ak-1214-r1b-sub-"));
  try {
    const { prepared, socketPath, bookRoot } = await prepareUnboundEnvelope(
      home,
      "run-1214-r1b-sub@coder",
      "coder",
    );
    try {
      await writeFile(join(bookRoot, String(R1B_TICKET)), "blocked-ticket-leaf");
      const token = mcpTokenFromPrepared(prepared);
      await callMcpTool({
        socketPath,
        token,
        name: CODER_OUTPUT_TOOL_NAME,
        args: { status: "completed", ticketNumber: R1B_TICKET },
      });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "submission ticket bind I/O failure must not close as accepted");
      assert.equal(
        "failure" in closed ? closed.failure?.identity?.name : undefined,
        "InfrastructureFailure",
        "submission-time ticket bind/relocate I/O must surface as typed round infrastructure failure",
      );
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    await rm(home, { recursive: true, force: true });
  }
});

test("#1214 R1b: diarist commitDiaristProjection I/O failure is round infrastructure failure", async () => {
  // Distinct from ticket-bind members: already-on-ticket leaf, fail the diary append.
  const priorExitCode = process.exitCode;
  const home = await mkdtemp(join(tmpdir(), "ak-1214-r1b-di-"));
  try {
    const bookKey = resolveBookKeyFromGit(packageRoot);
    const bookRoot = join(home, ".ak-roles", "books", bookKey);
    const runDirectory = join(bookRoot, String(R1B_TICKET), "runs", "run-1214-r1b-di@diarist");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const dialogueDir = join(home, ".claude", "projects", "probe");
    await mkdir(dialogueDir, { recursive: true });
    const dialoguePath = join(dialogueDir, "dialogue.jsonl");
    await writeFile(
      dialoguePath,
      `${JSON.stringify({
        type: "message",
        role: "user",
        content: [{ type: "text", text: "owner note" }],
        id: "m1",
      })}\n`,
    );
    const identity = {
      role: "diarist",
      runId: "run-1214-r1b-di",
      bookKey,
      projectRoot: packageRoot,
      ticketNumber: R1B_TICKET,
    };
    seedCurrentSection(runDirectory, "invocation", identity);
    seedCurrentSection(runDirectory, "admitted", identity);
    // Block the ticket records file so commit append cannot open it.
    await mkdir(join(bookRoot, String(R1B_TICKET), "records.jsonl"));
    const socketPath = join(home, "mcp-diarist-commit.sock");
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(sessionDir),
        activation: { role: "diarist" },
        methods: [],
        continuation: { kind: "initial", prompt: "diarist commit I/O" },
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
      await callMcpTool({
        socketPath,
        token,
        name: DIARIST_OUTPUT_TOOL_NAME,
        args: {
          status: "completed",
          ticketNumber: R1B_TICKET,
          sessions: [{ path: dialoguePath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
        },
      });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "diarist commit I/O failure must not close as accepted");
      assert.equal(
        "failure" in closed ? closed.failure?.identity?.name : undefined,
        "InfrastructureFailure",
        "diarist commitDiaristProjection I/O must surface as typed round infrastructure failure",
      );
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    await rm(home, { recursive: true, force: true });
  }
});

test("#1214 R1c: diarist durable coordinate read failure before commit is round infrastructure failure", async () => {
  // Same-shape member of R1b: the admitted page that carries projectRoot is unreadable
  // after prepare, so the diary record cannot locate its book. Must not wash to isError.
  const priorExitCode = process.exitCode;
  const home = await mkdtemp(join(tmpdir(), "ak-1214-r1c-"));
  try {
    const { prepared, socketPath, runDirectory } = await prepareUnboundEnvelope(home, "run-1214-r1c@diarist", "diarist");
    try {
      await rm(join(runDirectory, "state.jsonl"), { force: true });
      const token = mcpTokenFromPrepared(prepared);
      await callMcpTool({
        socketPath,
        token,
        name: DIARIST_OUTPUT_TOOL_NAME,
        args: { status: "completed", ticketNumber: null, sessions: [] },
      });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "unreadable diary coordinates must not close as accepted");
      assert.equal(
        "failure" in closed ? closed.failure?.identity?.name : undefined,
        "InfrastructureFailure",
        "diary coordinate read failure must surface as typed round infrastructure failure",
      );
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    await rm(home, { recursive: true, force: true });
  }
});
