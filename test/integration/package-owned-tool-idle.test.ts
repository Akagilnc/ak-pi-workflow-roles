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
  type Context,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
  PackageOwnedToolIdleTimeoutError,
} from "../../src/package-owned-tool-idle.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import {
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
} from "../../src/stream-idle-guard.ts";
import {
  flushEventLoopTurns,
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
  "#339 real judge entry: audit-type submission past 183000ms does not yield outer PackageOwnedToolIdleTimeoutError",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS, 183_000);

    let releaseAudit!: (decision: { status: "pass" }) => void;
    const auditGate = new Promise<{ status: "pass" }>((resolve) => {
      releaseAudit = resolve;
    });
    let auditCalls = 0;
    const originalExitCode = process.exitCode;
    const callId = "judge-idle-exempt-183";

    try {
      await withActivationHome({ prefix: "ak-judge-idle-exempt-" }, async ({ home, agentDir }) => {
        const faux = fauxProvider({
          api: "ak-judge-idle-exempt",
          provider: "ak-judge-idle-exempt",
          tokenSize: { min: 1000, max: 1000 },
        });
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          systemPrompt: "JUDGE IDLE EXEMPT",
          mode: "print",
          flags: { "ak-role": "judge" },
          extensionFactories: [
            createRoleRuntimeExtension({
              loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
              transcriptFromContext: () => "adjudication evidence",
              auditSoulCompliance: async () => {
                auditCalls += 1;
                return auditGate;
              },
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
            () => fauxAssistantMessage("post-terminal should not be required"),
          ]);

          const promptDone = session.prompt("adjudicate slowly audited verdict");
          let promptSettled = false;
          void promptDone.then(
            () => {
              promptSettled = true;
            },
            () => {
              promptSettled = true;
            },
          );

          await flushEventLoopTurns(50);
          assert.equal(auditCalls, 1, "judge submission entered real execute / audit once");

          t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
          await flushEventLoopTurns(50);

          const mid = toolResults(session, JUDGE_OUTPUT_TOOL_NAME);
          assert.equal(mid.length, 0, "outer 183s gate must not settle judge submission");
          assert.equal(promptSettled, false, "session still awaits inner compliance owner");
          assert.equal(auditCalls, 1, "outer gate must not re-enter audit");

          releaseAudit({ status: "pass" });
          await flushEventLoopTurns(50);
          await promptDone;

          const results = toolResults(session, JUDGE_OUTPUT_TOOL_NAME);
          assert.equal(results.length, 1, "exactly one judge tool result after inner settle");
          const result = results[0] as {
            isError?: boolean;
            toolCallId?: string;
            content: Array<{ type: string; text?: string }>;
          };
          assert.equal(result.isError, false, "accepted path must not surface outer idle isError");
          assert.equal(result.toolCallId, callId);
          const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
          assert.doesNotMatch(text, /PackageOwnedToolIdleTimeoutError/);
          assert.doesNotMatch(text, /package-owned tool idle timeout/i);
          assert.equal(auditCalls, 1, "finite single audit attempt; no outer-driven re-audit");
        });
      });
    } finally {
      process.exitCode = originalExitCode;
    }
  },
);

test(
  "#339 real judge entry: inner StreamIdleTimeoutError exhausts once without outer package idle identity",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let releaseAudit!: (error: Error) => void;
    const auditGate = new Promise<never>((_resolve, reject) => {
      releaseAudit = reject;
    });
    let auditCalls = 0;
    const originalExitCode = process.exitCode;
    const callId = "judge-inner-idle-exhaust";

    try {
      await withActivationHome({ prefix: "ak-judge-inner-idle-" }, async ({ home, agentDir }) => {
        const faux = fauxProvider({
          api: "ak-judge-inner-idle",
          provider: "ak-judge-inner-idle",
          tokenSize: { min: 1000, max: 1000 },
        });
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          systemPrompt: "JUDGE INNER IDLE",
          mode: "print",
          flags: { "ak-role": "judge" },
          extensionFactories: [
            createRoleRuntimeExtension({
              loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
              transcriptFromContext: () => "adjudication evidence",
              auditSoulCompliance: async () => {
                auditCalls += 1;
                return auditGate;
              },
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
            () => fauxAssistantMessage("continuation after infrastructure failure"),
          ]);

          const promptDone = session.prompt("adjudicate with exhausted inner idle");
          await flushEventLoopTurns(50);
          assert.equal(auditCalls, 1);

          // Outer budget elapses while inner compliance is still the owner.
          t.mock.timers.tick(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
          await flushEventLoopTurns(30);
          assert.equal(
            toolResults(session, JUDGE_OUTPUT_TOOL_NAME).length,
            0,
            "outer package idle must not pre-empt inner owner",
          );

          releaseAudit(new StreamIdleTimeoutError(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS));
          await flushEventLoopTurns(50);
          await promptDone.catch(() => undefined);

          assert.equal(auditCalls, 1, "inner exhaustion must not loop re-audit at submission");

          const results = toolResults(session, JUDGE_OUTPUT_TOOL_NAME);
          // Infrastructure failure may abort without a settled toolResult, or surface
          // the thrown cause. Either way it must not be the outer package-idle identity.
          for (const row of results) {
            const result = row as {
              isError?: boolean;
              content?: Array<{ type: string; text?: string }>;
            };
            const text = (result.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n");
            assert.doesNotMatch(text, /PackageOwnedToolIdleTimeoutError/);
            assert.doesNotMatch(text, /package-owned tool idle timeout/i);
            if (result.isError === true) {
              assert.match(text, /stream idle timeout/i);
            }
          }
          assert.ok(
            isStreamIdleTimeoutError(
              new StreamIdleTimeoutError(PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS),
            ),
          );
          assert.equal(
            new PackageOwnedToolIdleTimeoutError() instanceof StreamIdleTimeoutError,
            false,
          );
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
