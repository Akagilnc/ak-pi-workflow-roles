import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
} from "../../src/evidence-child-executor.ts";
import {
  ComplianceCandidateUnreadableError,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../../src/compliance-transport.ts";
import {
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
} from "../../src/stream-idle-guard.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { readSitianRecords, resolveSitianRecordPath } from "../../src/sitian-facade.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { createTempPackageHomeLedger, withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

async function withRunDir<T>(
  runDirectory: string,
  faux: ReturnType<typeof fauxProvider>,
  run: () => Promise<T>,
): Promise<T> {
  await writeInstitutionalSeatTable(runDirectory, {
    auditor: seatSelection("ak-auditor-provider", "audit-test"),
  });
  return withInstitutionalProviderFixture(faux, run);
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

type AuditorFixture = {
  cwd: string;
  runDirectory: string;
  sessionManager: SessionManager;
  dispose(): void;
};

/** #604: project cwd + run/session under temp `.ak-roles` so sitian path-derive stays hermetic. */
function openAuditorFixture(prefix: string): AuditorFixture {
  const ledger = createTempPackageHomeLedger({ prefix, runName: "audit" });
  const cwd = join(ledger.home, "project");
  mkdirSync(cwd, { recursive: true });
  const sessionManager = parentWithJudgeSubjects(cwd);
  (sessionManager as any).getSessionFile = () => ledger.sessionFile;
  (sessionManager as any).getSessionDir = () => ledger.sessionDirectory;
  return {
    cwd,
    runDirectory: ledger.runDirectory,
    sessionManager,
    dispose: () => ledger.dispose(),
  };
}


test("auditor gathers evidence and submits one decision", async () => {
  const fixture = openAuditorFixture("ak-auditor-zero-projection-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    await writeFile(join(cwd, "evidence.txt"), "court evidence: accepted\n");
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
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    faux.setResponses([complete, complete]);
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool,
      systemPrompt: "Read evidence, then submit exactly one decision.",
      roleLabel: "Test auditor",
      invalidDecisionLabel: "invalid test decision",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
    assert.equal(decisions, 1);
  } finally {
    fixture.dispose();
  }
});

test("rejected auditor decision execution remains reachable and retries to an accepted receipt", async () => {
  const fixture = openAuditorFixture("ak-auditor-rejected-retry-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
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
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    let turns = 0;
    const submit = () => {
      turns += 1;
      return fauxAssistantMessage(
        [fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })],
        { stopReason: "toolUse" },
      );
    };
    faux.setResponses([submit, submit]);
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool, systemPrompt: "Decide.", roleLabel: "Retry auditor", invalidDecisionLabel: "invalid",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(executions, 2, "the rejected terminal call must execute again");
    assert.equal(turns, 2, "one rejection consumes one of the shared two-turn budget");
  } finally { fixture.dispose(); }
});

test("a rejected auditor decision and its correction prompt share one budget unit", async () => {
  const fixture = openAuditorFixture("ak-auditor-rejected-prose-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    const baseTool = createComplianceDecisionTool("ak_rejected_prose_decision", "Submit.");
    let executions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        executions += 1;
        throw new Error("未观察到 commit");
      },
    };
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
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
    faux.setResponses(responses);
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool, systemPrompt: "Decide.", roleLabel: "Rejected prose auditor", invalidDecisionLabel: "invalid",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "no-receipt");
    assert.equal(executions, 1);
    assert.equal(turns, 3, "the correction prompt is bundled with its rejection, leaving one final solicitation");
  } finally { fixture.dispose(); }
});

test("a mixed auditor batch accepts the correction after recording rejected siblings", async () => {
  const fixture = openAuditorFixture("ak-auditor-mixed-batch-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
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
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    const response = fauxAssistantMessage([
      fauxToolCall(tool.name, { status: "revise", violations: ["stale"] }),
      fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
    ], { stopReason: "toolUse" });
    faux.setResponses([response]);
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool, systemPrompt: "Decide.", roleLabel: "Mixed batch auditor", invalidDecisionLabel: "invalid",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(executions, 2);
    assert.deepEqual(decision, {
      status: "pass",
      usage: decision.usage,
    });
  } finally { fixture.dispose(); }
});

// Saturation matrix: rejected executions share one budget — sequential
// rejections saturate at two, and an already-issued batch of three all execute
// while still saturating receipt turns; blank diagnostics are retained as facts.
test("rejected auditor executions saturate at two budget units across sequential and batch shapes", async () => {
  // Row 1: two sequential rejections with real diagnostics exhaust the budget.
  {
    const fixture = openAuditorFixture("ak-auditor-rejected-exhaustion-");
    const { cwd, runDirectory, sessionManager } = fixture;
    try {
      const baseTool = createComplianceDecisionTool("ak_rejected_exhaustion_decision", "Submit.");
      let executions = 0;
      const tool = {
        ...baseTool,
        async execute(...args: Parameters<typeof baseTool.execute>) {
          executions += 1;
          throw new Error(`rejected execution ${executions}`);
        },
      };
      const faux = fauxProvider({ provider: "ak-auditor-provider" });
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
      faux.setResponses(responses);
      const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
        tool, systemPrompt: "Decide.", roleLabel: "Rejected exhaustion auditor", invalidDecisionLabel: "invalid",
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
    } finally { fixture.dispose(); }
  }

  // Row 2: three rejections issued in one batch all execute (budget exhaustion
  // cannot suppress already-issued terminal calls) and blank diagnostics are
  // exposed as missing-diagnostic facts.
  {
    const diagnostic = "   \t";
    const fixture = openAuditorFixture("ak-auditor-blank-rejection-");
    const { cwd, runDirectory, sessionManager } = fixture;
    try {
      const baseTool = createComplianceDecisionTool("ak_blank_rejection_decision", "Submit.");
      let executions = 0;
      const tool = { ...baseTool, async execute() { executions += 1; throw new Error(diagnostic); } };
      const faux = fauxProvider({ provider: "ak-auditor-provider" });
      const submit = () => fauxAssistantMessage(
        Array.from({ length: 3 }, () => fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })),
        { stopReason: "toolUse" },
      );
      const responses = [submit, () => fauxAssistantMessage("done")];
      faux.setResponses(responses);
      const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
        tool, systemPrompt: "Decide.", roleLabel: "Blank rejection auditor", invalidDecisionLabel: "invalid",
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
    } finally { fixture.dispose(); }
  }
});

test("accepted auditor arguments cannot forge machine-owned no-receipt provenance", async () => {
  const fixture = openAuditorFixture("ak-auditor-forged-no-receipt-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
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
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name, forged)], { stopReason: "toolUse" })]);
    await assert.rejects(
      () => withRunDir(runDirectory, faux, () => runComplianceAudit({
        tool, systemPrompt: "Decide.", roleLabel: "Forgery auditor", invalidDecisionLabel: "invalid",
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
  } finally { fixture.dispose(); }
});

test("auditor exhaustion preserves a typed no-receipt leg and its measured usage", async () => {
  const fixture = openAuditorFixture("ak-auditor-no-receipt-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
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
    faux.setResponses([noDecision, noDecision, noDecision]);
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool: createComplianceDecisionTool("ak_no_receipt_decision", "Submit."),
      systemPrompt: "Decide.", roleLabel: "No receipt auditor", invalidDecisionLabel: "invalid",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(turns, 3, "initial attempt plus exactly two delivery prompts");
    assert.equal(decision.status, "no-receipt");
    if (decision.status === "no-receipt") {
      assert.equal(decision.acceptedReceipt, false);
      assert.equal(decision.deliveryTurns, 2);
      assert.equal(decision.terminalToolCalled, false);
      const recordFile = resolveSitianRecordPath({
        level: "event",
        kind: "auditor",
        cwd,
        sessionParent: sessionManager.getSessionFile(),
      }).recordFile;
      const retainedUsages = (await readSitianRecords(recordFile)).records.flatMap((record) => {
        const payload = record.payload as { response?: { usage?: typeof usages[number] } } | undefined;
        return payload?.response?.usage === undefined ? [] : [payload.response.usage];
      });
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
    fixture.dispose();
  }
});

test("undefined decision candidate fails as ComplianceCandidateUnreadableError", async () => {
  const fixture = openAuditorFixture("ak-auditor-undefined-candidate-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    const tool = createComplianceDecisionTool("ak_undefined_decision", "Submit.");
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    faux.setResponses([fauxAssistantMessage([{
      type: "toolCall",
      id: "call-1",
      name: tool.name,
      arguments: undefined as unknown as Record<string, any>,
    }], { stopReason: "toolUse" })]);
    await assert.rejects(
      () => withRunDir(runDirectory, faux, () => runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        roleLabel: "Undefined candidate auditor",
        invalidDecisionLabel: "invalid candidate decision",
        context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
      })),
      (error: unknown) => {
        assert.ok(error instanceof ComplianceCandidateUnreadableError);
        assert.deepEqual(error.observation, { kind: "non-object-arguments", type: "undefined" });
        assert.equal(error.candidate, undefined);
        return true;
      },
    );
  } finally {
    fixture.dispose();
  }
});

test("same-turn evidence failure propagates its identity past injected and rejected decisions", async () => {
  // Case A: evidence tool and pending completion are issued in the same turn.
  {
    const fixture = openAuditorFixture("ak-auditor-same-turn-failure-");
    const { cwd, runDirectory, sessionManager } = fixture;
    try {
      const tool = createComplianceDecisionTool("ak_same_turn_decision", "Submit.");
      const faux = fauxProvider({ provider: "ak-auditor-provider" });
      faux.setResponses([fauxAssistantMessage([
        fauxToolCall("read", { path: "missing-evidence.txt" }),
        fauxToolCall(tool.name, { status: "pass" }),
      ], { stopReason: "toolUse" })]);
      await assert.rejects(
        () => withRunDir(runDirectory, faux, () => runComplianceAudit({
          tool,
          systemPrompt: "Read missing file and decide.",
          roleLabel: "Same turn auditor",
          invalidDecisionLabel: "invalid same-turn decision",
          context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
        })),
        (error: unknown) => error instanceof Error
          && (error as NodeJS.ErrnoException).code === "ENOENT",
      );
    } finally {
      fixture.dispose();
    }
  }

  // Case B: evidence tool and rejected decision tool are issued in the same turn.
  {
    const fixture = openAuditorFixture("ak-auditor-same-turn-rejected-failure-");
    const { cwd, runDirectory, sessionManager } = fixture;
    try {
      const baseTool = createComplianceDecisionTool("ak_same_turn_rejected_decision", "Submit.");
      let executions = 0;
      const tool = {
        ...baseTool,
        async execute(...args: Parameters<typeof baseTool.execute>) {
          executions += 1;
          throw new Error("decision rejected");
        },
      };
      const faux = fauxProvider({ provider: "ak-auditor-provider" });
      faux.setResponses([fauxAssistantMessage([
        fauxToolCall("read", { path: "missing-evidence.txt" }),
        fauxToolCall(tool.name, { status: "pass" }),
      ], { stopReason: "toolUse" })]);
      await assert.rejects(
        () => withRunDir(runDirectory, faux, () => runComplianceAudit({
          tool,
          systemPrompt: "Read missing file and decide.",
          roleLabel: "Same turn rejected auditor",
          invalidDecisionLabel: "invalid same-turn rejected decision",
          context: auditExtensionContext(cwd, sessionManager, faux),
          runDirectory,
        })),
        (error: unknown) => error instanceof Error
          && (error as NodeJS.ErrnoException).code === "ENOENT",
      );
      assert.equal(executions, 1);
    } finally {
      fixture.dispose();
    }
  }
});

test("injected pending completion settles a same-turn evidence and decision batch exactly once", async () => {
  const fixture = openAuditorFixture("ak-auditor-injected-decision-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    await writeFile(join(cwd, "evidence.txt"), "evidence payload\n");
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
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
    faux.setResponses([() => {
      completions += 1;
      // Through the real provider entry a "pending" stop reason is not
      // representable (the OpenAI-completions round-trip finalizes each turn with
      // a real stop reason). The intended semantics — an injected completion that
      // settles the same-turn evidence + decision batch exactly once — is
      // faithfully expressed by an assistant message that issues the tool calls
      // and stops for tool use.
      return fauxAssistantMessage([
        fauxToolCall("read", { path: "evidence.txt" }),
        fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ], { stopReason: "toolUse" });
    }]);
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool,
      systemPrompt: "Read and decide.",
      roleLabel: "Injected decision auditor",
      invalidDecisionLabel: "invalid injected decision",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(completions, 1);
    assert.equal(decisions, 1);
  } finally {
    fixture.dispose();
  }
});

test("auditor completion gives unknown tools native receipts and continues past former 32-turn ceiling to a decision", async () => {
  // #687: former AUDITOR_TURN_LIMIT=32 counted assistant replies and aborted.
  // Prove the real entry still gathers and settles after that historical ceiling.
  const formerTurnCeiling = 32;
  const fixture = openAuditorFixture("ak-auditor-turn-continuation-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    const tool = createComplianceDecisionTool("ak_real_turn_decision", "Submit.");
    const unknownId = "turn-unknown-call";
    const unknownTool = "ak_turn_unknown_decision";
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
      if (turns <= formerTurnCeiling) {
        return fauxAssistantMessage([{
          ...fauxToolCall(unknownTool, {}),
          id: unknownId,
        }], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(
        [fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })],
        { stopReason: "toolUse" },
      );
    };

    faux.setResponses(Array.from({ length: formerTurnCeiling + 1 }, () => traceTurn));
    const decision = await withRunDir(runDirectory, faux, () => runComplianceAudit({
      tool,
      systemPrompt: "Decide.",
      roleLabel: "Continuation auditor",
      invalidDecisionLabel: "invalid decision",
      context: auditExtensionContext(cwd, sessionManager, faux),
      runDirectory,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(turns, formerTurnCeiling + 1);
  } finally {
    fixture.dispose();
  }
});

test("provider-stream idle retries at most twice then fails loud as StreamIdleTimeoutError", async () => {
  const fixture = openAuditorFixture("ak-auditor-idle-");
  const { cwd, runDirectory, sessionManager } = fixture;
  try {
    const tool = createComplianceDecisionTool("ak_test_idle_decision", "Submit.");
    let streamAttempts = 0;
    const faux = fauxProvider({ provider: "ak-auditor-provider" });
    faux.setResponses(Array.from({ length: DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1 }, () => () => {
      streamAttempts += 1;
      throw new StreamIdleTimeoutError(1);
    }));

    await assert.rejects(
      withRunDir(runDirectory, faux, () => runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        roleLabel: "Idle auditor",
        invalidDecisionLabel: "invalid idle decision",
        context: auditExtensionContext(cwd, sessionManager, faux),
        runDirectory,
      })),
      (error: unknown) => isStreamIdleTimeoutError(error),
    );
    assert.equal(streamAttempts, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
  } finally {
    fixture.dispose();
  }
});
