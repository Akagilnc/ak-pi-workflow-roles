import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { AuditMaterialsUnavailableError, JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";

function auditContext(sessionManager: SessionManager): ExtensionContext {
  const faux = fauxProvider({ provider: "test" });
  return {
    model: faux.getModel(),
    modelRegistry: {
      getProvider() { return faux.provider; },
      async getProviderAuth() { return { auth: { apiKey: "k" } }; },
      async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "k" }; },
    },
    sessionManager,
  } as unknown as ExtensionContext;
}

function seedJudgeSubjects(sessionManager: SessionManager): void {
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT: adjudicate issue 233",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "v1",
      name: JUDGE_OUTPUT_TOOL_NAME,
      arguments: { judgeStatus: "converged" },
    }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

test("judge auditor bare-Pi seam proceeds when subjects are on the books", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-bare-pi-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  let calls = 0;
  try {
    const sessionManager = SessionManager.inMemory();
    seedJudgeSubjects(sessionManager);
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "test"),
    });
    const auditor = createPiJudgeAuditor(async () => {
      calls += 1;
      return fauxAssistantMessage(
        fauxToolCall(JUDGE_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      );
    });
    const decision = await auditor({ context: auditContext(sessionManager) });
    assert.equal(decision.status, "pass");
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor throws missing-dossier when AK_ROLE_RUN_DIR points at a nonexistent path", async () => {
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = join(tmpdir(), "ak-missing-run-dir-does-not-exist");
  let calls = 0;
  try {
    const auditor = createPiJudgeAuditor(async () => {
      calls += 1;
      throw new Error("model must not run");
    });
    await assert.rejects(
      () => auditor({ context: auditContext(SessionManager.inMemory()) }),
      (error: unknown) => {
        assert.ok(error instanceof AuditMaterialsUnavailableError);
        assert.deepEqual(error.observation, { kind: "missing-dossier" });
        return true;
      },
    );
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
  }
});

test("judge auditor throws missing-subject when candidate verdict is not on the books", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-missing-subject-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  let calls = 0;
  try {
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage({
      role: "user",
      content: "assignment only",
      timestamp: Date.now(),
    });
    const auditor = createPiJudgeAuditor(async () => {
      calls += 1;
      throw new Error("model must not run");
    });
    await assert.rejects(
      () => auditor({ context: auditContext(sessionManager) }),
      (error: unknown) => {
        assert.ok(error instanceof AuditMaterialsUnavailableError);
        assert.deepEqual(error.observation, { kind: "missing-subject", subject: "candidate-verdict" });
        return true;
      },
    );
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor spawn carries no projected materials in the user prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-zero-input-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  try {
    const sessionManager = SessionManager.inMemory(root);
    seedJudgeSubjects(sessionManager);
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "test"),
    });
    let userPrompt = "";
    const auditor = createPiJudgeAuditor(async (_model, request: Context) => {
      userPrompt = request.messages
        .filter((message) => message.role === "user")
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.type === "text" ? part.text : "").join(""))
        .join("\n");
      return fauxAssistantMessage(
        fauxToolCall(JUDGE_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      );
    });
    const decision = await auditor({ context: auditContext(sessionManager) });
    assert.equal(decision.status, "pass");
    assert.equal(/judge_soul|adjudication_record|proposed_verdict|THE JUDGE LAW|OWNER ASSIGNMENT/.test(userPrompt), false);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
