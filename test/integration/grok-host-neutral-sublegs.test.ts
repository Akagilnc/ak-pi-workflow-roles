/**
 * #590 tracer: Grok public envelope entry triggers a real institutional audit sub-leg.
 * Doctor is the minimal seat (no gatekeeper before audit). Entry = prepareGrokRoleEnvelope
 * + MCP tools/call; production createGrokRoleRuntimeDependencies supplies the auditor.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

import type { DoctorCase } from "../../src/doctor-contracts.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { createGrokRoleRuntimeDependencies } from "../../src/grok/production-host.ts";
import { prepareGrokRoleEnvelope } from "../../src/grok/role-envelope.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const zero = { count: 0, sources: [] as string[] };
function patient(runsPath: string): DoctorCase {
  return {
    version: 1,
    identity: { issueNumber: 28, runsPath },
    evidence: [{
      id: "review/session/live.jsonl",
      kind: "session",
      byteLength: 6,
      contentLength: 2,
      sha256: "abc",
      content: "中文",
    }],
    cost: {
      invocations: zero,
      legs: zero,
      modelApiTurns: zero,
      outputTokens: zero,
      toolCalls: zero,
      retries: { ...zero, evidence: "literal run-dir naming" },
      statuses: [],
      commits: [],
      sessions: [],
      outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" },
    },
  };
}

type McpServer = { command: string; args: string[]; env: Array<{ name: string; value: string }> };

async function callThroughMcp(
  server: McpServer,
  name: string,
  args: unknown,
): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value) as { result?: Record<string, unknown>; error?: unknown };
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

test("Grok envelope doctor terminal drives production auditSoul-wired doctor auditor to institutional open", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-audit-tracer-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorEngine = process.env.AK_ROLE_ENGINE;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_ENGINE;
  try {
    const runsPath = join(root, "case-runs");
    await mkdir(runsPath, { recursive: true });
    const casePath = join(root, "case.json");
    const caseBody = patient(runsPath);
    await writeFile(casePath, `${JSON.stringify(caseBody)}\n`, "utf8");

    const runDirectory = join(root, "runs", "doctor-audit");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    // Seat page so the real auditor reaches institutional open (not missing-page).
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("ak-test-provider", "ak-test-model"),
    });

    const deps = createGrokRoleRuntimeDependencies(packageRoot);
    let auditInvoked = false;
    let bookedCandidate = false;
    const traced = {
      ...deps,
      loadDoctorCase: async () => caseBody,
      async auditDoctorCompliance(options: Parameters<NonNullable<typeof deps.auditDoctorCompliance>>[0]) {
        auditInvoked = true;
        const entries = [...options.context.sessionManager.getEntries()];
        bookedCandidate = entries.some((entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { type?: unknown; customType?: unknown }).type === "custom"
          && (entry as { customType?: unknown }).customType === "ak_doctor_audit_candidate");
        // Real production auditor (createPiDoctorAuditor) — institutional open, not not-wired stub.
        return deps.auditDoctorCompliance!(options);
      },
    };

    const socketPath = join(root, "mcp.sock");
    const request = {
      principal: {},
      activation: { role: "doctor", casePath },
      methods: [],
      continuation: { kind: "initial", prompt: "diagnose the case" },
      model: { provider: "xai", model: "grok-4.5" },
      cwd: process.cwd(),
      home: root,
      agentDir: join(root, "agent"),
      runDirectory,
    } as RoleTurnRequest;

    const prepared = await prepareGrokRoleEnvelope({
      request,
      socketPath,
      dependencies: traced,
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, DOCTOR_OUTPUT_TOOL_NAME, {
        status: "refused",
        reason: "Session bytes are incomplete.",
        missingEvidence: [{ need: "session header", targetKeys: ["case"] }],
      });

      // Production auditor ran: candidate booked on host-neutral books, then institutional open failed loud.
      assert.equal(auditInvoked, true);
      assert.equal(bookedCandidate, true);
      assert.equal(reply.error, undefined);
      const result = reply.result as { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
      assert.equal(result?.isError, true);
      const text = (result?.content ?? [])
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n");
      assert.equal(text.includes("not wired"), false, text);
      // Reached institutional open / auth (real auditor child), not a pre-wire stub.
      assert.match(text, /authentication failed|provider is not configured|institutional|Compliance|audit/i);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    // failInfrastructure stamps exitCode=1 on print-mode HostContext; clear for the test runner.
    process.exitCode = 0;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    if (priorEngine === undefined) delete process.env.AK_ROLE_ENGINE; else process.env.AK_ROLE_ENGINE = priorEngine;
    await rm(root, { recursive: true, force: true });
  }
});
