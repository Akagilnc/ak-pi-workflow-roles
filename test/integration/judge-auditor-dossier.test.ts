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
import { withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";
import { testTmpdir } from "../helpers/worktree-temp.ts";

function auditContext(sessionManager: SessionManager, faux = fauxProvider({ provider: "test" })): ExtensionContext {
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
  const root = await mkdtemp(join(testTmpdir(), "ak-judge-bare-pi-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  let calls = 0;
  try {
    const sessionManager = SessionManager.inMemory();
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    seedJudgeSubjects(sessionManager);
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "test"),
    });
    const faux = fauxProvider({ provider: "test" });
    faux.setResponses([
      () => {
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
      },
    ]);
    const auditor = createPiJudgeAuditor();
    const decision = await withInstitutionalProviderFixture(faux, () => auditor({ context: auditContext(sessionManager, faux) }));
    assert.equal(decision.status, "pass");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor throws missing-dossier when AK_ROLE_RUN_DIR points at a nonexistent path", async () => {
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = join(testTmpdir(), "ak-missing-run-dir-does-not-exist");
  let calls = 0;
  try {
    const auditor = createPiJudgeAuditor();
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
  const root = await mkdtemp(join(testTmpdir(), "ak-judge-missing-subject-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  let calls = 0;
  try {
    const sessionManager = SessionManager.inMemory(root);
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    sessionManager.appendMessage({
      role: "user",
      content: "assignment only",
      timestamp: Date.now(),
    });
    const auditor = createPiJudgeAuditor();
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
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor spawn carries no projected materials in the user prompt", async () => {
  const root = await mkdtemp(join(testTmpdir(), "ak-judge-zero-input-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = SessionManager.inMemory(root);
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    seedJudgeSubjects(sessionManager);
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "test"),
    });
    let userPrompt = "";
    const faux = fauxProvider({ provider: "test" });
    faux.setResponses([
      (request: any) => {
        userPrompt = (request?.messages ?? [])
          .filter((message: any) => message.role === "user")
          .map((message: any) => typeof message.content === "string"
            ? message.content
            : message.content.map((part: any) => part.type === "text" ? part.text : "").join(""))
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
      },
    ]);
    const auditor = createPiJudgeAuditor();
    const decision = await withInstitutionalProviderFixture(faux, () => auditor({ context: auditContext(sessionManager, faux) }));
    assert.equal(decision.status, "pass");
    // Zero-projection contract: the child user prompt must never carry soul,
    // adjudication record, proposed verdict, or the owner assignment. The only
    // user text is the fixed dossier-ready envelope.
    assert.equal(/judge_soul|adjudication_record|proposed_verdict|THE JUDGE LAW|OWNER ASSIGNMENT/.test(userPrompt), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
