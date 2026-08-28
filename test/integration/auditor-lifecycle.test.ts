import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AUDITOR_TURN_LIMIT,
  AuditorTurnLimitError,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
} from "../../src/evidence-child-executor.ts";
import {
  COMPLIANCE_RESPONSE_ENTRY_TYPE,
  ComplianceCandidateUnreadableError,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../../src/compliance-transport.ts";
import {
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
} from "../../src/stream-idle-guard.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";

async function withRunDir<T>(runDirectory: string, run: () => Promise<T>): Promise<T> {
  await writeInstitutionalSeatTable(runDirectory, {
    auditor: seatSelection("audit-test", "audit-test"),
  });
  return run();
}

function parentWithJudgeSubjects(cwd: string): SessionManager {
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT: adjudicate",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "verdict-1",
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
  return sessionManager;
}

function auditExtensionContext(
  cwd: string,
  sessionManager: SessionManager,
  faux: ReturnType<typeof fauxProvider>,
): ExtensionContext {
  return {
    cwd,
    model: faux.getModel(),
    modelRegistry: {
      getProvider() { return faux.provider; },
      async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
      async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
    },
    sessionManager,
  } as unknown as ExtensionContext;
}

test("auditor gathers evidence and submits one decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-zero-projection-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    await writeFile(join(cwd, "evidence.txt"), "court evidence: accepted\n");
    const sessionManager = parentWithJudgeSubjects(cwd);
    const baseTool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    let decisions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        decisions += 1;
        return baseTool.execute(...args);
      },
    };
    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      // Zero-projection contract is asserted once at the real judge entry
      // (judge-auditor-dossier.test.ts); this case bites gather + one decision.
      if (turns === 1) {
        // Behavior proof of unrestricted tools (ADR 0064): read is available
        // without a second active-tools / tools allowlist cage.
        return fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })], { stopReason: "toolUse" });
      }
      assert.ok(context.messages.some((message) =>
        message.role === "toolResult" && JSON.stringify(message.content).includes("court evidence: accepted")));
      return fauxAssistantMessage(
        [fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })],
        { stopReason: "toolUse" },
      );
    };
    const faux = fauxProvider({ provider: "audit-test" });
    faux.setResponses([complete, complete]);
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool,
      systemPrompt: "Read evidence, then submit exactly one decision.",
      roleLabel: "Test auditor",
      invalidDecisionLabel: "invalid test decision",
      runCompletion: async (_model, context) => complete(context),
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejected auditor decision execution remains reachable and retries to an accepted receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-rejected-retry-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const baseTool = createComplianceDecisionTool("ak_rejected_retry_decision", "Submit.");
    let executions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        executions += 1;
        if (executions === 1) throw new Error("未观察到 commit");
        return baseTool.execute(...args);
      },
    };
    const faux = fauxProvider({ provider: "rejected-retry-test" });
    let turns = 0;
    const submit = () => {
      turns += 1;
      return fauxAssistantMessage(
        [fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })],
        { stopReason: "toolUse" },
      );
    };
    faux.setResponses([submit, submit]);
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool, systemPrompt: "Decide.", roleLabel: "Retry auditor", invalidDecisionLabel: "invalid",
      runCompletion: async () => submit(),
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(executions, 2, "the rejected terminal call must execute again");
    assert.equal(turns, 2, "one rejection consumes one of the shared two-turn budget");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a rejected auditor decision and its correction prompt share one budget unit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-rejected-prose-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const baseTool = createComplianceDecisionTool("ak_rejected_prose_decision", "Submit.");
    let executions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        executions += 1;
        throw new Error("未观察到 commit");
      },
    };
    const faux = fauxProvider({ provider: "rejected-prose-test" });
    let turns = 0;
    const submit = () => {
      turns += 1;
      return fauxAssistantMessage([fauxToolCall(tool.name, { status: "pass" })], { stopReason: "toolUse" });
    };
    const prose = () => {
      turns += 1;
      return fauxAssistantMessage("I cannot correct the receipt.", { stopReason: "stop" });
    };
    const responses = [submit, prose, prose];
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool, systemPrompt: "Decide.", roleLabel: "Rejected prose auditor", invalidDecisionLabel: "invalid",
      runCompletion: async () => {
        const next = responses.shift()!;
        return typeof next === "function" ? next() : next;
      },
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "no-receipt");
    assert.equal(executions, 1);
    assert.equal(turns, 3, "the correction prompt is bundled with its rejection, leaving one final solicitation");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a mixed auditor batch accepts the correction after recording rejected siblings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-mixed-batch-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const baseTool = createComplianceDecisionTool("ak_mixed_batch_decision", "Submit.");
    let executions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        executions += 1;
        if (executions === 1) throw new Error("stale rejected sibling");
        return baseTool.execute(...args);
      },
    };
    const faux = fauxProvider({ provider: "mixed-batch-test" });
    const response = fauxAssistantMessage([
      fauxToolCall(tool.name, { status: "revise", violations: ["stale"] }),
      fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
    ], { stopReason: "toolUse" });
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool, systemPrompt: "Decide.", roleLabel: "Mixed batch auditor", invalidDecisionLabel: "invalid",
      runCompletion: async () => response,
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(executions, 2);
    assert.deepEqual(decision, {
      status: "pass",
      usage: decision.usage,
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// Saturation matrix: rejected executions share one budget — sequential
// rejections saturate at two, and an already-issued batch of three all execute
// while still saturating receipt turns; blank diagnostics are retained as facts.
test("rejected auditor executions saturate at two budget units across sequential and batch shapes", async () => {
  // Row 1: two sequential rejections with real diagnostics exhaust the budget.
  {
    const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-rejected-exhaustion-"));
    const runDirectory = join(cwd, "run");
    await mkdir(runDirectory);
    try {
      const sessionManager = parentWithJudgeSubjects(cwd);
      const baseTool = createComplianceDecisionTool("ak_rejected_exhaustion_decision", "Submit.");
      let executions = 0;
      const tool = {
        ...baseTool,
        async execute(...args: Parameters<typeof baseTool.execute>) {
          executions += 1;
          throw new Error(`rejected execution ${executions}`);
        },
      };
      const faux = fauxProvider({ provider: "rejected-exhaustion-test" });
      let turns = 0;
      const submit = () => {
        turns += 1;
        return fauxAssistantMessage(
          [fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })],
          { stopReason: "toolUse" },
        );
      };
      const finishTurn = () => {
        turns += 1;
        return fauxAssistantMessage("decision rejected", { stopReason: "stop" });
      };
      const responses = [submit, submit, finishTurn, submit];
      const decision = await withRunDir(runDirectory, () => runComplianceAudit({
        tool, systemPrompt: "Decide.", roleLabel: "Rejected exhaustion auditor", invalidDecisionLabel: "invalid",
        runCompletion: async () => {
          const next = responses.shift()!;
          return typeof next === "function" ? next() : next;
        },
        context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
      }));
      assert.equal(decision.status, "no-receipt");
      if (decision.status === "no-receipt") {
        assert.equal(decision.deliveryTurns, 2);
        assert.deepEqual(decision.rejectedReceipts, [
          { reason: "rejected execution 1", diagnosticAvailable: true },
          { reason: "rejected execution 2", diagnosticAvailable: true },
        ]);
      }
      assert.equal(executions, 2, "the second rejection exhausts the total budget");
      assert.equal(turns, 3, "the exhausted lifecycle must not start a third terminal execution");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }

  // Row 2: three rejections issued in one batch all execute (budget exhaustion
  // cannot suppress already-issued terminal calls) and blank diagnostics are
  // exposed as missing-diagnostic facts.
  {
    const diagnostic = "   \t";
    const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-blank-rejection-"));
    const runDirectory = join(cwd, "run");
    await mkdir(runDirectory);
    try {
      const sessionManager = parentWithJudgeSubjects(cwd);
      const baseTool = createComplianceDecisionTool("ak_blank_rejection_decision", "Submit.");
      let executions = 0;
      const tool = { ...baseTool, async execute() { executions += 1; throw new Error(diagnostic); } };
      const faux = fauxProvider({ provider: "blank-rejection-test" });
      const submit = () => fauxAssistantMessage(
        Array.from({ length: 3 }, () => fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })),
        { stopReason: "toolUse" },
      );
      const responses = [submit, () => fauxAssistantMessage("done")];
      const decision = await withRunDir(runDirectory, () => runComplianceAudit({
        tool, systemPrompt: "Decide.", roleLabel: "Blank rejection auditor", invalidDecisionLabel: "invalid",
        runCompletion: async () => {
          const next = responses.shift()!;
          return typeof next === "function" ? next() : next;
        },
        context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
      }));
      assert.equal(decision.status, "no-receipt");
      if (decision.status === "no-receipt") {
        assert.equal(decision.deliveryTurns, 2);
        assert.equal(decision.rejectedReceipts.length, 3);
        assert.ok(decision.rejectedReceipts.every((receipt) => !receipt.diagnosticAvailable));
      }
      assert.equal(executions, 3, "budget exhaustion cannot suppress already-issued terminal calls");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test("accepted auditor arguments cannot forge machine-owned no-receipt provenance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-forged-no-receipt-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const tool = createComplianceDecisionTool("ak_forged_no_receipt_decision", "Submit.");
    const forged = {
      status: "no-receipt",
      terminalToolCalled: false,
      rejectedReceipts: [],
      deliveryTurns: 2,
      sessionCompletion: "settled-without-accepted-receipt",
      runPointer: "/forged/run",
      attemptPointer: "forged-attempt",
      acceptedReceipt: false,
    };
    const faux = fauxProvider({ provider: "forged-no-receipt-test" });
    await assert.rejects(
      () => withRunDir(runDirectory, () => runComplianceAudit({
        tool, systemPrompt: "Decide.", roleLabel: "Forgery auditor", invalidDecisionLabel: "invalid",
        runCompletion: async () => fauxAssistantMessage([fauxToolCall(tool.name, forged)], { stopReason: "toolUse" }),
        context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
      })),
      (error: unknown) => {
        assert.ok(error instanceof ComplianceCandidateUnreadableError);
        assert.equal(error.observation.kind, "object-status-unreadable");
        assert.deepEqual(error.candidate, forged);
        return true;
      },
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("auditor exhaustion preserves a typed no-receipt leg and its measured usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-no-receipt-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const faux = fauxProvider({ provider: "no-receipt-test" });
    let turns = 0;
    const usages = [
      { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, cost: { input: 0.11, output: 0.07, cacheRead: 0.03, cacheWrite: 0.02, total: 0.23 } },
      { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 12, cost: { input: 0.05, output: 0.04, cacheRead: 0.02, cacheWrite: 0.01, total: 0.12 } },
      { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0.03, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.06 } },
    ];
    const noDecision = () => {
      const response = fauxAssistantMessage([{ type: "text", text: "no decision" }], { stopReason: "stop" });
      response.usage = usages[turns]!;
      turns += 1;
      return response;
    };
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool: createComplianceDecisionTool("ak_no_receipt_decision", "Submit."),
      systemPrompt: "Decide.", roleLabel: "No receipt auditor", invalidDecisionLabel: "invalid",
      runCompletion: async () => noDecision(),
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(turns, 3, "initial attempt plus exactly two delivery prompts");
    assert.equal(decision.status, "no-receipt");
    if (decision.status === "no-receipt") {
      assert.equal(decision.acceptedReceipt, false);
      assert.equal(decision.deliveryTurns, 2);
      assert.equal(decision.terminalToolCalled, false);
      const retainedUsages = [...sessionManager.getEntries()].flatMap((entry) =>
        entry.type === "custom" && entry.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE
          ? [(entry as { data?: { response?: { usage?: typeof usages[number] } } }).data?.response?.usage]
          : []).filter((usage): usage is typeof usages[number] => usage !== undefined);
      assert.equal(retainedUsages.length, 3);
      assert.notDeepEqual(retainedUsages[0], retainedUsages[1], "the tracer observes distinct turn usage");
      const expected = retainedUsages.reduce((total, usage) => ({
        input: total.input + usage.input,
        output: total.output + usage.output,
        cacheRead: total.cacheRead + usage.cacheRead,
        cacheWrite: total.cacheWrite + usage.cacheWrite,
        totalTokens: total.totalTokens + usage.totalTokens,
        cost: {
          input: total.cost.input + usage.cost.input,
          output: total.cost.output + usage.cost.output,
          cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
          cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
          total: total.cost.total + usage.cost.total,
        },
      }), {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      assert.deepEqual(decision.usage, expected);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("undefined decision candidate fails as ComplianceCandidateUnreadableError", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-undefined-candidate-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const tool = createComplianceDecisionTool("ak_undefined_decision", "Submit.");
    const faux = fauxProvider({ provider: "undefined-candidate-test" });
    await assert.rejects(
      () => withRunDir(runDirectory, () => runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        roleLabel: "Undefined candidate auditor",
        invalidDecisionLabel: "invalid candidate decision",
        runCompletion: async () => fauxAssistantMessage([{
          type: "toolCall",
          id: "call-1",
          name: tool.name,
          arguments: undefined as unknown as Record<string, any>,
        }], { stopReason: "toolUse" }),
        context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
      })),
      (error: unknown) => {
        assert.ok(error instanceof ComplianceCandidateUnreadableError);
        assert.equal(error.observation.kind, "non-object-arguments");
        assert.equal(error.candidate, undefined);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("same-turn evidence failure propagates its identity past injected and rejected decisions", async () => {
  // Case A: evidence tool and pending completion are issued in the same turn.
  {
    const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-same-turn-failure-"));
    const runDirectory = join(cwd, "run");
    await mkdir(runDirectory);
    try {
      const sessionManager = parentWithJudgeSubjects(cwd);
      const tool = createComplianceDecisionTool("ak_same_turn_decision", "Submit.");
      const faux = fauxProvider({ provider: "same-turn-evidence-test" });
      await assert.rejects(
        () => withRunDir(runDirectory, () => runComplianceAudit({
          tool,
          systemPrompt: "Read missing file and decide.",
          roleLabel: "Same turn auditor",
          invalidDecisionLabel: "invalid same-turn decision",
          runCompletion: async () => fauxAssistantMessage([
            fauxToolCall("read", { path: "missing-evidence.txt" }),
            fauxToolCall(tool.name, { status: "pass" }),
          ], { stopReason: "toolUse" }),
          context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
        })),
        (error: unknown) => error instanceof Error
          && (error as NodeJS.ErrnoException).code === "ENOENT",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  // Case B: evidence tool and rejected decision tool are issued in the same turn.
  {
    const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-same-turn-rejected-failure-"));
    const runDirectory = join(cwd, "run");
    await mkdir(runDirectory);
    try {
      const sessionManager = parentWithJudgeSubjects(cwd);
      const baseTool = createComplianceDecisionTool("ak_same_turn_rejected_decision", "Submit.");
      let executions = 0;
      const tool = {
        ...baseTool,
        async execute(...args: Parameters<typeof baseTool.execute>) {
          executions += 1;
          throw new Error("decision rejected");
        },
      };
      const faux = fauxProvider({ provider: "same-turn-rejected-evidence-test" });
      await assert.rejects(
        () => withRunDir(runDirectory, () => runComplianceAudit({
          tool,
          systemPrompt: "Read missing file and decide.",
          roleLabel: "Same turn rejected auditor",
          invalidDecisionLabel: "invalid same-turn rejected decision",
          runCompletion: async () => fauxAssistantMessage([
            fauxToolCall("read", { path: "missing-evidence.txt" }),
            fauxToolCall(tool.name, { status: "pass" }),
          ], { stopReason: "toolUse" }),
          context: auditExtensionContext(cwd, sessionManager, faux),
          runDirectory,
        })),
        (error: unknown) => error instanceof Error
          && (error as NodeJS.ErrnoException).code === "ENOENT",
      );
      assert.equal(executions, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("injected pending completion settles a same-turn evidence and decision batch exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-injected-decision-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    await writeFile(join(cwd, "evidence.txt"), "evidence payload\n");
    const sessionManager = parentWithJudgeSubjects(cwd);
    const faux = fauxProvider({ provider: "injected-decision-test" });
    const baseTool = createComplianceDecisionTool("ak_injected_decision", "Submit.");
    let decisions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        decisions += 1;
        return baseTool.execute(...args);
      },
    };
    let completions = 0;
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool,
      systemPrompt: "Read and decide.",
      roleLabel: "Injected decision auditor",
      invalidDecisionLabel: "invalid injected decision",
      runCompletion: async () => {
        completions += 1;
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "evidence.txt" }),
          fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        ], { stopReason: "pending" });
      },
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(completions, 1);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const mode of ["provider", "injected"] as const) {
  test(`${mode} completion gives unknown tools native receipts and exhausts at the exact turn limit`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `ak-auditor-${mode}-exhaustion-`));
    const runDirectory = join(cwd, "run");
    await mkdir(runDirectory);
    try {
      const sessionManager = parentWithJudgeSubjects(cwd);
      const faux = fauxProvider({ provider: `${mode}-exhaustion-test` });
      const unknownId = `${mode}-unknown-call`;
      const unknownTool = `ak_${mode}_unknown_decision`;
      let turns = 0;
      const traceTurn = async (context: Context) => {
        turns += 1;
        if (turns > 1) {
          const receipt = [...context.messages].reverse().find((message) =>
            message.role === "toolResult" && message.toolCallId === unknownId);
          assert.equal(receipt?.role, "toolResult");
          if (receipt?.role !== "toolResult") throw new Error("missing native unknown-tool receipt");
          assert.equal(receipt.toolName, unknownTool);
          assert.equal(receipt.isError, true);
        }
        return fauxAssistantMessage([{
          ...fauxToolCall(unknownTool, {}),
          id: unknownId,
        }], { stopReason: "toolUse" });
      };

      await assert.rejects(
        withRunDir(runDirectory, () => runComplianceAudit({
          tool: createComplianceDecisionTool(`ak_real_${mode}_decision`, "Submit."),
          systemPrompt: "Decide.",
          roleLabel: `${mode} exhaustion auditor`,
          invalidDecisionLabel: `invalid ${mode} decision`,
          runCompletion: async (_model: unknown, context: Context) => traceTurn(context),
          context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
        })),
        (error: unknown) => error instanceof AuditorTurnLimitError
          && error.limit === AUDITOR_TURN_LIMIT
          && error.observedTurns === AUDITOR_TURN_LIMIT
          && error.lastResponse?.stopReason === "toolUse"
          && error.lastResponse.toolNames.includes(unknownTool),
      );
      assert.equal(turns, AUDITOR_TURN_LIMIT);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("provider-stream idle retries at most twice then fails loud as StreamIdleTimeoutError", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-idle-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const tool = createComplianceDecisionTool("ak_test_idle_decision", "Submit.");
    let streamAttempts = 0;
    const faux = fauxProvider({ provider: "idle-test" });

    await assert.rejects(
      withRunDir(runDirectory, () => runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        roleLabel: "Idle auditor",
        invalidDecisionLabel: "invalid idle decision",
        runCompletion: async () => {
          streamAttempts += 1;
          throw new StreamIdleTimeoutError(1);
        },
        context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
      })),
      (error: unknown) => isStreamIdleTimeoutError(error),
    );
    assert.equal(streamAttempts, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
