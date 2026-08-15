/**
 * #102 package-owned tool idle backstop — real AgentSession / public package-tool entry.
 * Observes LLM-visible isError tool results and subsequent LLM continuation only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  SessionManager,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
  PackageOwnedToolIdleTimeoutError,
  withPackageOwnedToolIdleSuspended,
  wrapPackageOwnedToolDefinition,
} from "../../src/package-owned-tool-idle.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { createPiJudgeAuditor } from "../../src/judge-auditor.ts";
import { createReviewerRoleRuntime } from "../../src/reviewer-role.ts";
import { DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES } from "../../src/evidence-child-executor.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import type { ComplianceDecision } from "../../src/compliance-transport.ts";
import {
  flushEventLoopTurns,
  waitForEventLoopCondition,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

const PACKAGE_TOOL = "ak_package_owned_idle";

function toolResults(session: { messages: readonly { role?: string; toolName?: string }[] }, name: string) {
  return session.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === name,
  );
}

async function withPackageToolSession<T>(
  tool: ToolDefinition<any, any, any>,
  run: (fixture: {
    session: Awaited<Parameters<Parameters<typeof withInProcessPi>[1]>[0]>["session"];
    faux: ReturnType<typeof fauxProvider>;
  }) => Promise<T>,
): Promise<T> {
  return withActivationHome({ prefix: "ak-pkg-tool-idle-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({
      api: "ak-package-owned-tool-idle",
      provider: "ak-package-owned-tool-idle",
      tokenSize: { min: 1000, max: 1000 },
    });
    return withInProcessPi({
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      noTools: "builtin",
      systemPrompt: "PACKAGE OWNED TOOL IDLE",
      mode: "print",
      flags: {},
      extensionFactories: [
        (pi: ExtensionAPI) => {
          // Production tracer: role-runtime installs package registration, then an
          // ordinary package extension registers through pi.registerTool.
          createRoleRuntimeExtension({
            loadJudgeSoul: async () => "judge",
            transcriptFromContext: () => "",
            auditSoulCompliance: async () => ({ status: "pass" }),
          })(pi);
          pi.registerTool(tool);
        },
      ],
    }, async ({ session }) => run({ session, faux }));
  });
}

test(
  "#339 real judge entry: compliance child silence keeps outer 183s out, retries StreamIdleTimeoutError, then exhausts",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS, 183_000);
    assert.equal(DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, 2);

    let complianceStreamAttempts = 0;
    const originalExitCode = process.exitCode;
    const callId = "judge-compliance-idle-exhaust";

    try {
      await withActivationHome({ prefix: "ak-judge-compliance-idle-" }, async ({ home, agentDir }) => {
        const faux = fauxProvider({
          api: "ak-judge-compliance-idle",
          provider: "ak-judge-compliance-idle",
          tokenSize: { min: 1000, max: 1000 },
        });
        // Production auditor factory: real register/submit → executeAuditorChild idleRetry.
        // Silent completion never emits stream activity, so ADR 0059 owns the clock.
        const auditSoulCompliance = createPiJudgeAuditor(async () => {
          complianceStreamAttempts += 1;
          await new Promise<never>(() => {});
          throw new Error("unreachable compliance completion");
        });
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          systemPrompt: "JUDGE COMPLIANCE IDLE",
          mode: "print",
          flags: { "ak-role": "judge" },
          extensionFactories: [
            createRoleRuntimeExtension({
              loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
              transcriptFromContext: () => "adjudication evidence",
              auditSoulCompliance,
            }),
          ],
        }, async ({ session }) => {
          faux.setResponses([
            () =>
              fauxAssistantMessage(
                fauxToolCall(
                  JUDGE_OUTPUT_TOOL_NAME,
                  { judgeStatus: "converged" },
                  { id: callId },
                ),
                { stopReason: "toolUse" },
              ),
            () => fauxAssistantMessage("continuation after compliance idle exhaustion"),
          ]);

          const promptDone = session.prompt("adjudicate with silent compliance child");
          let promptSettled = false;
          void promptDone.then(
            () => {
              promptSettled = true;
            },
            () => {
              promptSettled = true;
            },
          );

          // Wait for real compliance child stream entry (not a fixed turn guess).
          // Mock timers freeze setTimeout only; setImmediate + wall clock stay live.
          await waitForEventLoopCondition(
            () => complianceStreamAttempts >= 1,
            { label: "judge submission entered real compliance child stream once" },
          );
          assert.equal(
            complianceStreamAttempts,
            1,
            "judge submission entered real compliance child stream once",
          );

          // First inner idle budget: outer package gate must not settle the submission.
          t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
          await waitForEventLoopCondition(
            () => complianceStreamAttempts >= 2,
            { label: "first StreamIdleTimeoutError must finite-retry the compliance stream" },
          );
          assert.equal(
            toolResults(session, JUDGE_OUTPUT_TOOL_NAME).length,
            0,
            "outer 183s gate must not settle judge submission",
          );
          assert.equal(promptSettled, false, "session still awaits inner compliance owner");
          assert.equal(
            complianceStreamAttempts,
            2,
            "first StreamIdleTimeoutError must finite-retry the compliance stream",
          );

          // Second idle budget → final attempt.
          t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
          await waitForEventLoopCondition(
            () => complianceStreamAttempts >= DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1,
            { label: "inner owner arms the final compliance stream attempt" },
          );
          assert.equal(
            toolResults(session, JUDGE_OUTPUT_TOOL_NAME).length,
            0,
            "outer gate still absent while inner owner retries",
          );
          assert.equal(
            complianceStreamAttempts,
            DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1,
            "inner owner arms the final compliance stream attempt",
          );

          // Final idle budget → exhaust StreamIdleTimeoutError through the real entry.
          t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
          await flushEventLoopTurns(80);
          await promptDone.catch(() => undefined);

          assert.equal(
            complianceStreamAttempts,
            DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1,
            "exhaustion must not invent further compliance stream attempts",
          );

          const results = toolResults(session, JUDGE_OUTPUT_TOOL_NAME);
          assert.equal(results.length, 1, "exactly one judge tool result after inner exhaustion");
          const result = results[0] as {
            isError?: boolean;
            toolCallId?: string;
            content: Array<{ type: string; text?: string }>;
          };
          assert.equal(result.isError, true, "exhausted compliance idle surfaces as tool isError");
          assert.equal(result.toolCallId, callId);
          const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
          assert.match(text, /stream idle timeout/i);
          assert.doesNotMatch(text, /PackageOwnedToolIdleTimeoutError/);
          assert.doesNotMatch(text, /package-owned tool idle timeout/i);
        });
      });
    } finally {
      process.exitCode = originalExitCode;
    }
  },
);

test(
  "silent package-owned tool is pending at 182999ms then yields one isError timeout at 183000ms; LLM continues",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS, 183_000);

    let executeCount = 0;
    let secondTurnContext: Context | undefined;
    const originalExitCode = process.exitCode;
    const callId = "package-owned-idle-silent";

    const silentTool = defineTool({
      name: PACKAGE_TOOL,
      label: "Silent package-owned tool",
      description: "Hangs without progress for idle-backstop tracing",
      parameters: Type.Object({}),
      async execute() {
        executeCount += 1;
        await new Promise<never>(() => {});
        return {
          content: [{ type: "text" as const, text: "unreachable" }],
          details: {},
        };
      },
    });

    try {
      await withPackageToolSession(silentTool, async ({ session, faux }) => {
        faux.setResponses([
          () =>
            fauxAssistantMessage(
              fauxToolCall(PACKAGE_TOOL, {}, { id: callId }),
              { stopReason: "toolUse" },
            ),
          (context) => {
            secondTurnContext = context;
            return fauxAssistantMessage("continued after tool timeout");
          },
        ]);

        const promptDone = session.prompt("exercise silent package tool");
        let promptSettled = false;
        void promptDone.then(
          () => {
            promptSettled = true;
          },
          () => {
            promptSettled = true;
          },
        );

        await flushEventLoopTurns();
        assert.equal(executeCount, 1, "tool execute starts once");

        t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
        await flushEventLoopTurns();
        assert.equal(toolResults(session, PACKAGE_TOOL).length, 0, "still pending one ms before budget");
        assert.equal(promptSettled, false, "session still awaits the tool");

        t.mock.timers.tick(1);
        await flushEventLoopTurns(50);
        assert.equal(
          toolResults(session, PACKAGE_TOOL).length,
          1,
          "production role-runtime registration installs the timeout wrapper",
        );
        await promptDone;

        const timeoutResults = toolResults(session, PACKAGE_TOOL);
        assert.equal(timeoutResults.length, 1, "exactly one tool result");
        const timeoutResult = timeoutResults[0] as {
          role: string;
          isError?: boolean;
          toolCallId?: string;
          content: Array<{ type: string; text?: string }>;
        };
        assert.equal(timeoutResult.isError, true);
        assert.equal(timeoutResult.toolCallId, callId);
        const timeoutText = timeoutResult.content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        assert.match(timeoutText, /idle timeout/i);
        assert.match(timeoutText, new RegExp(String(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS)));

        assert.equal(executeCount, 1, "runtime does not retry the tool");
        assert.equal(process.exitCode, originalExitCode, "no role/process failure exit");

        assert.ok(secondTurnContext, "LLM receives a continuation turn");
        const seenError = secondTurnContext.messages.some(
          (message) =>
            message.role === "toolResult"
            && message.toolName === PACKAGE_TOOL
            && message.isError === true
            && message.toolCallId === callId,
        );
        assert.equal(seenError, true, "continuation turn sees the timeout tool result");
      });
    } finally {
      process.exitCode = originalExitCode;
    }
  },
);

test(
  "meaningful details-only update at 182999ms resets idle window; empty placeholder does not",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onUpdateRef: AgentToolUpdateCallback<unknown> | undefined;
    const callId = "package-owned-idle-progress";

    const progressTool = defineTool({
      name: PACKAGE_TOOL,
      label: "Progress package-owned tool",
      description: "Emits progress then hangs until released",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, onUpdate) {
        onUpdateRef = onUpdate;
        await gate;
        return {
          content: [{ type: "text" as const, text: "finished after progress" }],
          details: { ok: true },
        };
      },
    });

    await withPackageToolSession(progressTool, async ({ session, faux }) => {
      faux.setResponses([
        () =>
          fauxAssistantMessage(
            fauxToolCall(PACKAGE_TOOL, {}, { id: callId }),
            { stopReason: "toolUse" },
          ),
        () => fauxAssistantMessage("continued after progress timeout"),
      ]);

      const promptDone = session.prompt("exercise progress reset");
      await flushEventLoopTurns();
      assert.ok(onUpdateRef, "tool received onUpdate");

      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
      await flushEventLoopTurns();
      assert.equal(toolResults(session, PACKAGE_TOOL).length, 0);

      // Empty/non-producing update must not reset the clock.
      onUpdateRef!({ content: [], details: undefined });
      t.mock.timers.tick(1);
      await flushEventLoopTurns(20);
      assert.equal(
        toolResults(session, PACKAGE_TOOL).length,
        1,
        "empty update does not extend the idle window",
      );
      const emptyTimeout = toolResults(session, PACKAGE_TOOL)[0] as { isError?: boolean };
      assert.equal(emptyTimeout.isError, true);
      await promptDone;
    });

    // Fresh session: meaningful details-only activity resets, so a full new
    // 183000ms silence window is required. Observation-plane content semantics
    // are intentionally tested elsewhere and remain unchanged.
    onUpdateRef = undefined;
    const gate2 = new Promise<void>((resolve) => {
      release = resolve;
    });
    const progressTool2 = defineTool({
      name: PACKAGE_TOOL,
      label: "Progress package-owned tool",
      description: "Emits progress then hangs until released",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, onUpdate) {
        onUpdateRef = onUpdate;
        await gate2;
        return {
          content: [{ type: "text" as const, text: "finished after progress" }],
          details: { ok: true },
        };
      },
    });

    await withPackageToolSession(progressTool2, async ({ session, faux }) => {
      faux.setResponses([
        () =>
          fauxAssistantMessage(
            fauxToolCall(PACKAGE_TOOL, {}, { id: `${callId}-reset` }),
            { stopReason: "toolUse" },
          ),
        () => fauxAssistantMessage("continued after reset timeout"),
      ]);

      const promptDone = session.prompt("exercise details-only reset");
      await flushEventLoopTurns();
      assert.ok(onUpdateRef, "tool received onUpdate");

      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
      await flushEventLoopTurns();
      onUpdateRef!({ content: [], details: { elapsedMs: 60_000 } });
      await flushEventLoopTurns();

      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
      await flushEventLoopTurns();
      assert.equal(
        toolResults(session, PACKAGE_TOOL).length,
        0,
        "meaningful details-only update resets the idle window",
      );

      t.mock.timers.tick(1);
      await flushEventLoopTurns(50);
      await promptDone;

      const results = toolResults(session, PACKAGE_TOOL);
      assert.equal(results.length, 1);
      assert.equal((results[0] as { isError?: boolean }).isError, true);
    });
  },
);

/**
 * Production registration entry: createRoleRuntimeExtension →
 * installPackageOwnedToolRegistration(pi). Tools registered afterward go through
 * the real wrapper; tests must not hand-call wrapPackageOwnedToolDefinition here.
 */
type ExecutableTool = {
  name: string;
  execute: (...args: any[]) => Promise<unknown>;
};

function piWithProductionPackageToolRegistration() {
  const flagMap = new Map<string, unknown>();
  const tools = new Map<string, ExecutableTool>();
  let active: string[] = [];
  const pi = {
    registerFlag(name: string, _definition?: unknown) {
      if (!flagMap.has(name)) flagMap.set(name, undefined);
    },
    getFlag(name: string) {
      return flagMap.get(name);
    },
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return ["read", "bash", ...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools(names: string[]) {
      active = names;
    },
    getActiveTools() {
      return active;
    },
    on(_name: string, _fn: (...args: never[]) => unknown) {},
  } as unknown as ExtensionAPI;
  // src/role-runtime.ts production install (installPackageOwnedToolRegistration).
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(pi);
  return { pi, tools };
}

function soleToolContext(toolName: string, id: string): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  sessionManager.appendMessage(message);
  return { sessionManager, abort() {} } as unknown as ExtensionContext;
}

const NO_RECEIPT_DECISION = {
  status: "no-receipt",
  acceptedReceipt: false,
  terminalToolCalled: true,
  rejectedReceipts: [{ reason: "audit quiet", diagnosticAvailable: true }],
  deliveryTurns: 2,
  sessionCompletion: "settled-without-accepted-receipt",
  runPointer: "/run",
  attemptPointer: "attempt-1",
} as const satisfies ComplianceDecision;

const ESCALATE_DECISION = {
  status: "escalate",
  conflicts: ["needs human"],
  decisionGate: { question: "Proceed?", options: ["yes", "no"] },
} as const satisfies ComplianceDecision;

test(
  "#339 Reviewer real registration entry: post-audit hanging shutdown is outer-bounded",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS, 183_000);

    const skill = "# code-review\n";
    const pin = {
      repositoryRoot: "/repo",
      objectFormat: "sha1" as const,
      targetHead: "9".repeat(40),
      refs: {},
    };
    const audits: readonly ComplianceDecision[] = [
      { status: "pass" },
      NO_RECEIPT_DECISION,
      ESCALATE_DECISION,
    ];

    for (const audit of audits) {
      let shutdownEntered = false;
      // Real entry: role-runtime installPackageOwnedToolRegistration wraps registerTool.
      const { pi, tools } = piWithProductionPackageToolRegistration();
      const runtime = createReviewerRoleRuntime(
        pi,
        {
          loadSoul: async () => "REVIEWER LAW",
          loadCanonicalSkillBinding: async () => ({
            name: "code-review" as const,
            snapshot: {
              raw: skill,
              path: "/skill",
              baseDir: "/",
              body: skill,
              snapshotIdentity: Object.freeze({ text: skill }),
            },
            invocation: (request: string) => request,
            captureExpansion: () => undefined,
          }),
          createPinnedGitReader: async () => ({
            pin,
            snapshot: async () => pin,
            resolve: async () => "8".repeat(40),
            range: async () => ({
              base: "8".repeat(40),
              target: pin.targetHead,
              diffCommand: "git diff",
              diffSha256: "2".repeat(64),
              commits: [pin.targetHead],
            }),
            featureTokens: async () => Object.freeze([]),
            listSpecCandidatePaths: async () => Object.freeze([]),
            originRepository: async () => undefined,
            commitMessagesNewestFirst: async () => Object.freeze([]),
            readPinnedText: async () => undefined,
          }),
          runDispatch: async () => {
            throw new Error("dispatch must not run for refused post-audit cleanup");
          },
          auditCompliance: async () => audit,
          // Production role-runtime maps shutdownReviewerAgent → shutdownAgent.
          shutdownAgent: async () => {
            shutdownEntered = true;
            await new Promise<never>(() => {});
          },
        },
        {
          failInfrastructure(error: unknown) {
            throw error;
          },
        },
      );
      await runtime.activate(undefined, { baseRevision: "main~1" });

      const tool = tools.get(REVIEWER_OUTPUT_TOOL_NAME);
      assert.ok(tool, `ak_reviewer_output registered via production install for ${audit.status}`);
      const callId = `reviewer-post-audit-${audit.status}`;
      const pending = tool.execute(
        callId,
        { status: "refused", diagnostic: "no accepted dispatch" },
        undefined,
        undefined,
        soleToolContext(REVIEWER_OUTPUT_TOOL_NAME, callId),
      );
      let failure: unknown;
      void pending.then(
        () => {
          failure = new Error(`unexpected resolve after audit ${audit.status}`);
        },
        (error: unknown) => {
          failure = error;
        },
      );

      await waitForEventLoopCondition(
        () => shutdownEntered,
        { label: `post-audit shutdown entered after ${audit.status}` },
      );
      assert.equal(failure === undefined, true, `still pending immediately after ${audit.status}`);

      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
      await flushEventLoopTurns(20);
      assert.equal(failure === undefined, true, `still pending 1ms before outer budget after ${audit.status}`);

      t.mock.timers.tick(1);
      await flushEventLoopTurns(30);
      assert.ok(
        failure instanceof PackageOwnedToolIdleTimeoutError,
        `audit ${audit.status} + hanging shutdown must fail via existing package-owned idle backstop`,
      );
      await assert.rejects(pending, (error: unknown) => error instanceof PackageOwnedToolIdleTimeoutError);
    }
  },
);

test(
  "#339 Judge/Doctor/Reviewer names no longer exempt non-audit hang; only suspended audit await does",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const named = [
      JUDGE_OUTPUT_TOOL_NAME,
      REVIEWER_OUTPUT_TOOL_NAME,
      DOCTOR_OUTPUT_TOOL_NAME,
    ] as const;

    // Bidirectional scan: name alone must not skip the outer backstop.
    for (const name of named) {
      const tool = wrapPackageOwnedToolDefinition({
        name,
        async execute() {
          await new Promise<never>(() => {});
        },
      });
      const pending = tool.execute();
      let failureName: string | undefined;
      void pending.then(
        () => {},
        (error: unknown) => {
          failureName = error instanceof Error ? error.name : undefined;
        },
      );
      await flushEventLoopTurns();
      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS - 1);
      await flushEventLoopTurns();
      assert.equal(failureName, undefined, `${name} still pending before budget`);
      t.mock.timers.tick(1);
      await flushEventLoopTurns(20);
      assert.equal(
        failureName,
        "PackageOwnedToolIdleTimeoutError",
        `${name} non-audit hang must stay under outer package-owned idle`,
      );
      await assert.rejects(pending, (error: unknown) => error instanceof PackageOwnedToolIdleTimeoutError);
    }

    // Inverse: only the real compliance-audit suspension leaves the outer owner.
    for (const name of named) {
      let enteredAudit = false;
      let releaseAudit!: (error: Error) => void;
      const tool = wrapPackageOwnedToolDefinition({
        name,
        async execute() {
          await withPackageOwnedToolIdleSuspended(async () => {
            enteredAudit = true;
            await new Promise<never>((_resolve, reject) => {
              releaseAudit = reject;
            });
          });
          return { content: [{ type: "text" as const, text: "unreachable" }], details: {} };
        },
      });
      const pending = tool.execute();
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitForEventLoopCondition(
        () => enteredAudit,
        { label: `${name} entered suspended audit await` },
      );
      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
      await flushEventLoopTurns(30);
      assert.equal(
        settled,
        false,
        `${name} suspended audit await must not be settled by outer 183s gate`,
      );
      releaseAudit(new Error(`test cleanup after ${name} suspended-audit assertion`));
      await assert.rejects(pending, /test cleanup/);
      assert.equal(settled, true);
    }
  },
);

test(
  "final resolve clears idle timer; late resolve after timeout does not create a second result",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let release!: (value: "ok" | "late") => void;
    let onUpdateRef: AgentToolUpdateCallback<unknown> | undefined;

    const controllableTool = defineTool({
      name: PACKAGE_TOOL,
      label: "Controllable package-owned tool",
      description: "Resolves when test releases it",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, onUpdate) {
        onUpdateRef = onUpdate;
        const outcome = await new Promise<"ok" | "late">((resolve) => {
          release = resolve;
        });
        if (outcome === "late") {
          onUpdateRef?.({ content: [{ type: "text", text: "late-update" }], details: {} });
        }
        return {
          content: [{ type: "text" as const, text: outcome === "ok" ? "resolved ok" : "late resolve" }],
          details: { outcome },
        };
      },
    });

    // Final resolve inside the window clears the timer — further ticks do not timeout.
    await withPackageToolSession(controllableTool, async ({ session, faux }) => {
      faux.setResponses([
        () =>
          fauxAssistantMessage(
            fauxToolCall(PACKAGE_TOOL, {}, { id: "final-clear" }),
            { stopReason: "toolUse" },
          ),
        () => fauxAssistantMessage("continued after final resolve"),
      ]);

      const promptDone = session.prompt("exercise final clear");
      await flushEventLoopTurns();
      assert.ok(typeof release === "function");

      t.mock.timers.tick(1_000);
      release("ok");
      await flushEventLoopTurns(20);
      await promptDone;

      const results = toolResults(session, PACKAGE_TOOL);
      assert.equal(results.length, 1);
      assert.equal((results[0] as { isError?: boolean }).isError, false);
      assert.match(
        JSON.stringify(results[0]),
        /resolved ok/,
      );

      // Advancing a full idle budget after final must not invent another result.
      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
      await flushEventLoopTurns(20);
      assert.equal(toolResults(session, PACKAGE_TOOL).length, 1);
    });

    // Timeout wins first; a late original resolve/update must not produce a second tool result.
    release = undefined as never;
    onUpdateRef = undefined;
    const lateTool = defineTool({
      name: PACKAGE_TOOL,
      label: "Late package-owned tool",
      description: "Resolves after timeout",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, onUpdate) {
        onUpdateRef = onUpdate;
        const outcome = await new Promise<"ok" | "late">((resolve) => {
          release = resolve;
        });
        onUpdate?.({ content: [{ type: "text", text: "late-update" }], details: {} });
        return {
          content: [{ type: "text" as const, text: `late-${outcome}` }],
          details: { outcome },
        };
      },
    });

    await withPackageToolSession(lateTool, async ({ session, faux }) => {
      faux.setResponses([
        () =>
          fauxAssistantMessage(
            fauxToolCall(PACKAGE_TOOL, {}, { id: "late-resolve" }),
            { stopReason: "toolUse" },
          ),
        () => fauxAssistantMessage("continued after timeout despite late resolve"),
      ]);

      const promptDone = session.prompt("exercise late resolve suppression");
      await flushEventLoopTurns();

      t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
      await flushEventLoopTurns(50);
      await promptDone;

      assert.equal(toolResults(session, PACKAGE_TOOL).length, 1);
      assert.equal((toolResults(session, PACKAGE_TOOL)[0] as { isError?: boolean }).isError, true);

      release("late");
      await flushEventLoopTurns(50);
      assert.equal(
        toolResults(session, PACKAGE_TOOL).length,
        1,
        "late resolve/update must not create a second tool result",
      );
      assert.equal((toolResults(session, PACKAGE_TOOL)[0] as { isError?: boolean }).isError, true);
    });
  },
);
