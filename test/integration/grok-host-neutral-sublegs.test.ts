/**
 * #590 tracer: Grok envelope entry → doctor terminal → production-wired doctor
 * auditor → institutional child → typed pass. No free-text oracles.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import type { DoctorCase } from "../../src/doctor-contracts.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { createGrokRoleRuntimeDependencies } from "../../src/grok/production-host.ts";
import { prepareGrokRoleEnvelope } from "../../src/grok/role-envelope.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { callThroughMcp, type GrokMcpServer } from "../helpers/grok-mcp-harness.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { packageRoot, withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

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

test("Grok envelope doctor terminal drives production auditor to typed pass with booked candidate", async () => {
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

    const faux = fauxProvider({ provider: "grok-audit-tracer", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection(model.provider, model.id),
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(DOCTOR_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      ),
    ]);

    const deps = createGrokRoleRuntimeDependencies(packageRoot);
    let bookedCandidate = false;
    const traced = {
      ...deps,
      loadDoctorCase: async () => caseBody,
      async auditDoctorCompliance(options: Parameters<NonNullable<typeof deps.auditDoctorCompliance>>[0]) {
        const entries = [...options.context.sessionManager.getEntries()];
        bookedCandidate = entries.some((entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { type?: unknown; customType?: unknown }).type === "custom"
          && (entry as { customType?: unknown }).customType === "ak_doctor_audit_candidate");
        return deps.auditDoctorCompliance!(options);
      },
    };

    await withInstitutionalProviderFixture(faux, async () => {
      const socketPath = join(root, "mcp.sock");
      const request = {
        principal: {},
        activation: { role: "doctor", casePath },
        methods: [],
        continuation: { kind: "initial", prompt: "diagnose the case" },
        model: { provider: model.provider, model: model.id },
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
        const server = prepared.mcpServers[0] as GrokMcpServer;
        const refusal = {
          status: "refused",
          reason: "Session bytes are incomplete.",
          missingEvidence: [{ need: "session header", targetKeys: ["case"] }],
        };
        const reply = await callThroughMcp(server, DOCTOR_OUTPUT_TOOL_NAME, refusal);
        assert.equal(reply.error, undefined);
        const result = reply.result as {
          isError?: boolean;
          structuredContent?: { submissionDisposition?: unknown; status?: unknown };
        };
        // Tool face is not infrastructure-error; round seal owns acceptance (envelope contract).
        assert.equal(result?.isError, undefined);
        assert.equal(result?.structuredContent?.submissionDisposition, "pending-round-closure");
        assert.equal(bookedCandidate, true);

        const closure = await prepared.closeRound();
        assert.equal(closure.accepted, true);
      } finally {
        await prepared.dispose?.();
      }
    });
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    if (priorEngine === undefined) delete process.env.AK_ROLE_ENGINE; else process.env.AK_ROLE_ENGINE = priorEngine;
    await rm(root, { recursive: true, force: true });
  }
});
