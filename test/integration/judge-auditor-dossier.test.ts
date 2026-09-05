import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { AuditMaterialsUnavailableError, JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

function countingAuditContext(
  sessionManager: SessionManager,
  faux = fauxProvider({ provider: "test" }),
  counters: { providerTouches: number } = { providerTouches: 0 },
): ExtensionContext {
  return {
    model: faux.getModel(),
    modelRegistry: {
      getProvider() {
        counters.providerTouches += 1;
        return faux.provider;
      },
      async getProviderAuth() {
        counters.providerTouches += 1;
        return { auth: { apiKey: "k" } };
      },
      async getApiKeyAndHeaders() {
        counters.providerTouches += 1;
        return { ok: true as const, apiKey: "k" };
      },
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
  const root = await mkdtemp(worktreeTempPrefix("ak-judge-bare-pi-"));
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
    const decision = await withInstitutionalProviderFixture(faux, () =>
      auditor({ context: countingAuditContext(sessionManager, faux) }),
    );
    assert.equal(decision.status, "pass");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor throws missing-dossier when AK_ROLE_RUN_DIR points at a nonexistent path", async () => {
  const previous = process.env.AK_ROLE_RUN_DIR;
  // Path string only — do not create the missing root.
  process.env.AK_ROLE_RUN_DIR = worktreeTempPrefix("ak-missing-run-dir-does-not-exist");
  const counters = { providerTouches: 0 };
  try {
    const auditor = createPiJudgeAuditor();
    await assert.rejects(
      () => auditor({ context: countingAuditContext(SessionManager.inMemory(), fauxProvider({ provider: "test" }), counters) }),
      (error: unknown) => {
        assert.ok(error instanceof AuditMaterialsUnavailableError);
        assert.deepEqual(error.observation, { kind: "missing-dossier" });
        return true;
      },
    );
    // Real provider/auth seam: missing dossier must not touch the model registry.
    assert.equal(counters.providerTouches, 0);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
  }
});

test("judge auditor throws missing-subject when candidate verdict is not on the books", async () => {
  const root = await mkdtemp(worktreeTempPrefix("ak-judge-missing-subject-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  const counters = { providerTouches: 0 };
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
      () => auditor({ context: countingAuditContext(sessionManager, fauxProvider({ provider: "test" }), counters) }),
      (error: unknown) => {
        assert.ok(error instanceof AuditMaterialsUnavailableError);
        assert.deepEqual(error.observation, { kind: "missing-subject", subject: "candidate-verdict" });
        return true;
      },
    );
    assert.equal(counters.providerTouches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor spawn carries no projected materials in the user prompt", async () => {
  const root = await mkdtemp(worktreeTempPrefix("ak-judge-zero-input-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = SessionManager.inMemory(root);
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    seedJudgeSubjects(sessionManager);
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "test"),
    });
    let userPromptSeen = false;
    const faux = fauxProvider({ provider: "test" });
    faux.setResponses([
      (request: any) => {
        userPromptSeen = true;
        // Zero-projection contract: child user turns must not carry projected
        // materials as structured message roles — only the fixed envelope path.
        // Do not regex-lock generated prompt prose (#685 C3).
        const userMessages = (request?.messages ?? []).filter((message: any) => message.role === "user");
        assert.ok(Array.isArray(userMessages));
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
    const decision = await withInstitutionalProviderFixture(faux, () =>
      auditor({ context: countingAuditContext(sessionManager, faux) }),
    );
    assert.equal(decision.status, "pass");
    assert.equal(userPromptSeen, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
