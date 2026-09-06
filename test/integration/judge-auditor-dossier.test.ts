import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { AuditMaterialsUnavailableError, JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { AUDITOR_DOSSIER_PROMPT } from "../../src/compliance-transport.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

/** Host context for auditor. Child session builds its own ModelRegistry (#518) — do not fake parent registry touch counters. */
function auditContext(
  sessionManager: SessionManager,
  faux = fauxProvider({ provider: "test" }),
): ExtensionContext {
  return {
    model: faux.getModel(),
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

/**
 * Shared child-provider observation for healthy + negative auditor paths.
 * Counts faux provider HTTP responses only (not full child/auth open).
 * Negatives omit institutional seat; healthy arms seat + pass response.
 * C3 #685: proves provider request count === 0 on materials gate; stronger
 * 「整个 child/auth 未打开」/原 audit-failure-subprocess 矩阵未结 —
 * docs/research/issue-685-c3-deleted-contract-handoff.md §J.
 */
async function withAuditorChildObservation<T>(
  run: (ctx: {
    faux: ReturnType<typeof fauxProvider>;
    childCalls: () => number;
    armPassResponse: () => void;
  }) => Promise<T>,
): Promise<T> {
  let childCalls = 0;
  const faux = fauxProvider({ provider: "test" });
  const armPassResponse = () => {
    faux.setResponses([
      () => {
        childCalls += 1;
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
  };
  // Arm a tripwire even when the body expects zero calls — any unexpected
  // provider HTTP response increments the same counter the healthy path uses.
  armPassResponse();
  return withInstitutionalProviderFixture(faux, () =>
    run({ faux, childCalls: () => childCalls, armPassResponse }),
  );
}

test("judge auditor bare-Pi seam proceeds when subjects are on the books", async () => {
  const root = await mkdtemp(worktreeTempPrefix("ak-judge-bare-pi-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = SessionManager.inMemory();
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    seedJudgeSubjects(sessionManager);
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "test"),
    });
    const auditor = createPiJudgeAuditor();
    const { decision, childCalls } = await withAuditorChildObservation(async ({ faux, childCalls }) => {
      const decision = await auditor({ context: auditContext(sessionManager, faux) });
      return { decision, childCalls: childCalls() };
    });
    assert.equal(decision.status, "pass");
    // Same observation the negative paths assert stays at zero.
    assert.equal(childCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("judge auditor throws missing-dossier when AK_ROLE_RUN_DIR points at a nonexistent path", async () => {
  const previous = process.env.AK_ROLE_RUN_DIR;
  // Path string only — do not create the missing root.
  process.env.AK_ROLE_RUN_DIR = worktreeTempPrefix("ak-missing-run-dir-does-not-exist");
  try {
    const auditor = createPiJudgeAuditor();
    await withAuditorChildObservation(async ({ childCalls }) => {
      await assert.rejects(
        () => auditor({ context: auditContext(SessionManager.inMemory()) }),
        (error: unknown) => {
          // Typed materials gate fires before child session / provider open.
          assert.ok(error instanceof AuditMaterialsUnavailableError);
          assert.deepEqual(error.observation, { kind: "missing-dossier" });
          return true;
        },
      );
      assert.equal(childCalls(), 0, "missing-dossier keeps provider HTTP responses at zero");
    });
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
  }
});

test("judge auditor throws missing-subject when candidate verdict is not on the books", async () => {
  const root = await mkdtemp(worktreeTempPrefix("ak-judge-missing-subject-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = SessionManager.inMemory(root);
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    sessionManager.appendMessage({
      role: "user",
      content: "assignment only",
      timestamp: Date.now(),
    });
    const auditor = createPiJudgeAuditor();
    await withAuditorChildObservation(async ({ faux, childCalls }) => {
      await assert.rejects(
        () => auditor({ context: auditContext(sessionManager, faux) }),
        (error: unknown) => {
          assert.ok(error instanceof AuditMaterialsUnavailableError);
          assert.deepEqual(error.observation, { kind: "missing-subject", subject: "candidate-verdict" });
          return true;
        },
      );
      assert.equal(childCalls(), 0, "missing-subject keeps provider HTTP responses at zero");
    });
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
    let observedUserTexts: string[] | undefined;
    const faux = fauxProvider({ provider: "test" });
    faux.setResponses([
      (request: any) => {
        // Zero-projection: child user turn is exactly the fixed dossier-ready envelope
        // (AUDITOR_DOSSIER_PROMPT call-input), never parent assignment / soul / verdict text.
        observedUserTexts = (request?.messages ?? [])
          .filter((message: any) => message.role === "user")
          .map((message: any) =>
            typeof message.content === "string"
              ? message.content
              : (message.content ?? [])
                .map((part: any) => (part?.type === "text" ? part.text : ""))
                .join(""),
          );
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
      auditor({ context: auditContext(sessionManager, faux) }),
    );
    assert.equal(decision.status, "pass");
    assert.ok(observedUserTexts !== undefined, "auditor child must issue one provider turn");
    // Fixed production call-input envelope only (zero projection of parent materials).
    assert.deepEqual(observedUserTexts, [AUDITOR_DOSSIER_PROMPT]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
