/**
 * #590: one production-deps root proves four sub-legs through Grok wiring.
 * Shared: createGrokRoleRuntimeDependencies + withInstitutionalProviderFixture + MCP harness.
 * No free-text oracles; no parallel MCP clone.
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
import { DOCTOR_CANDIDATE_ENTRY_TYPE, JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { createGrokRoleRuntimeDependencies } from "../../src/grok/production-host.ts";
import { prepareGrokRoleEnvelope } from "../../src/grok/role-envelope.ts";
import type { HostContext, RoleTurnRequest } from "../../src/host-contracts.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { callThroughMcp, type GrokMcpServer } from "../helpers/grok-mcp-harness.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { packageRoot, seedGitRepository, withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

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

function hostContext(root: string, runDirectory: string, entries: unknown[]): HostContext {
  const sessionFile = join(runDirectory, "session", "session.jsonl");
  return {
    cwd: root,
    mode: "print",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => entries.at(-1) as never,
      getLeafId: () => "leaf",
      getEntries: () => entries as never,
      getSessionDir: () => join(runDirectory, "session"),
      getSessionFile: () => sessionFile,
      appendCustomEntry() {},
    },
    abort() {},
  };
}

test("production Grok deps: four sub-legs reach typed results from one institutional root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-four-legs-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorEngine = process.env.AK_ROLE_ENGINE;
  process.env.HOME = root;
  delete process.env.AK_ROLE_ENGINE;
  try {
    seedGitRepository(root);
    const runDirectory = join(root, "runs", "four-legs");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    process.env.AK_ROLE_RUN_DIR = runDirectory;

    const faux = fauxProvider({ provider: "grok-four-legs", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection(model.provider, model.id),
      navigator: seatSelection(model.provider, model.id),
      evidenceChild: seatSelection(model.provider, model.id),
    });

    // Shared scripted audit pass for judge + doctor institutional children.
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(JUDGE_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(DOCTOR_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        { stopReason: "toolUse" },
      ),
    ]);

    const deps = createGrokRoleRuntimeDependencies(packageRoot);
    assert.equal(typeof deps.auditSoulCompliance, "function");
    assert.equal(typeof deps.auditDoctorCompliance, "function");
    assert.equal(typeof deps.runReviewerDispatch, "function");
    assert.equal(typeof deps.createNavigatorAttendance, "function");

    await withInstitutionalProviderFixture(faux, async () => {
      // —— 1. Judge soul audit (production wiring) ——
      const judgeEntries = [
        { type: "message", message: { role: "user", content: "OWNER ASSIGNMENT" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "v1",
              name: JUDGE_OUTPUT_TOOL_NAME,
              arguments: { judgeStatus: "converged" },
            }],
          },
        },
      ];
      const judgeDecision = await deps.auditSoulCompliance({
        context: hostContext(root, runDirectory, judgeEntries),
      });
      assert.equal(judgeDecision.status, "pass");

      // —— 2. Doctor audit (production wiring) ——
      const doctorEntries = [
        { type: "custom", customType: DOCTOR_CANDIDATE_ENTRY_TYPE, data: { version: 1 } },
      ];
      const doctorDecision = await deps.auditDoctorCompliance!({
        context: hostContext(root, runDirectory, doctorEntries),
      });
      assert.equal(doctorDecision.status, "pass");

      // —— 3. Navigator attendance (production factory) ——
      let navigatorEvent = false;
      const nav = await deps.createNavigatorAttendance!({
        context: hostContext(root, runDirectory, []),
        role: "doctor",
        phase: null,
        subjectKey: "subject",
        subject: "work subject",
        authority: "typed authority material for navigator",
        invocationId: "inv-four-legs",
        onEvent: () => { navigatorEvent = true; },
      });
      assert.equal(typeof nav.prepare, "function");
      assert.equal(typeof nav.settle, "function");
      await nav.settle({ kind: "arrival", role: "lander", phase: null, message: "ok" });
      assert.equal(navigatorEvent, true);
      if (typeof (nav as { dispose?: () => void }).dispose === "function") {
        (nav as { dispose: () => void }).dispose();
      }

      // —— 4. Reviewer dispatch (production runner) ——
      await assert.rejects(
        () => deps.runReviewerDispatch!(
          { recipe: "not-a-valid-recipe", identity: "x", targetSnapshot: {}, legs: [] } as never,
          { context: hostContext(root, runDirectory, []) },
        ),
        (error: unknown) =>
          error instanceof Error
          && error.message.includes("Invalid accepted Reviewer dispatch"),
      );
    });

    // —— Grok envelope entry: doctor terminal still seals via production auditor ——
    const runsPath = join(root, "case-runs");
    await mkdir(runsPath, { recursive: true });
    const casePath = join(root, "case.json");
    const caseBody = patient(runsPath);
    await writeFile(casePath, `${JSON.stringify(caseBody)}\n`, "utf8");

    const envelopeFaux = fauxProvider({ provider: "grok-envelope-leg", api: "openai-completions" });
    const envelopeModel = envelopeFaux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection(envelopeModel.provider, envelopeModel.id),
      navigator: seatSelection(envelopeModel.provider, envelopeModel.id),
    });
    envelopeFaux.setResponses([
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

    let navigatorFromEnvelope = false;
    let bookedCandidate = false;
    const traced = {
      ...deps,
      loadDoctorCase: async () => caseBody,
      createNavigatorAttendance: async (options: Parameters<NonNullable<typeof deps.createNavigatorAttendance>>[0]) => {
        navigatorFromEnvelope = true;
        return deps.createNavigatorAttendance!(options);
      },
      async auditDoctorCompliance(options: Parameters<NonNullable<typeof deps.auditDoctorCompliance>>[0]) {
        bookedCandidate = [...options.context.sessionManager.getEntries()].some((entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { type?: unknown; customType?: unknown }).type === "custom"
          && (entry as { customType?: unknown }).customType === DOCTOR_CANDIDATE_ENTRY_TYPE);
        return deps.auditDoctorCompliance!(options);
      },
    };

    await withInstitutionalProviderFixture(envelopeFaux, async () => {
      const prepared = await prepareGrokRoleEnvelope({
        request: {
          principal: {},
          activation: { role: "doctor", casePath },
          methods: [],
          continuation: { kind: "initial", prompt: "diagnose" },
          model: { provider: envelopeModel.provider, model: envelopeModel.id },
          cwd: process.cwd(),
          home: root,
          agentDir: join(root, "agent"),
          runDirectory,
        } as RoleTurnRequest,
        socketPath: join(root, "mcp.sock"),
        dependencies: traced,
      });
      try {
        assert.equal(navigatorFromEnvelope, true);
        const reply = await callThroughMcp(prepared.mcpServers[0] as GrokMcpServer, DOCTOR_OUTPUT_TOOL_NAME, {
          status: "refused",
          reason: "Session bytes are incomplete.",
          missingEvidence: [{ need: "session header", targetKeys: ["case"] }],
        });
        assert.equal(reply.error, undefined);
        const result = reply.result as { isError?: boolean; structuredContent?: { submissionDisposition?: unknown } };
        assert.equal(result?.isError, undefined);
        assert.equal(result?.structuredContent?.submissionDisposition, "pending-round-closure");
        assert.equal(bookedCandidate, true);
        assert.equal((await prepared.closeRound()).accepted, true);
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
