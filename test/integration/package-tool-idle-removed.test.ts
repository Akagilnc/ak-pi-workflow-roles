/**
 * Negative nail: package-owned tool idle backstop is gone.
 * Same silent-tool scene that formerly died at 183s now survives;
 * provider stream idle (#102 正主) remains armed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { createPiJudgeAuditor } from "../../src/judge-auditor.ts";
import { DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES } from "../../src/evidence-child-executor.ts";
import {
  createRoleRuntimeExtension,
  GATEKEEPER_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  NOTARY_OUTPUT_TOOL,
} from "../../src/role-runtime.ts";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "../../src/stream-idle-guard.ts";
import {
  flushEventLoopTurns,
  waitForEventLoopCondition,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

const PACKAGE_TOOL = "ak_package_owned_no_idle";

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
  return withActivationHome({ prefix: "ak-pkg-tool-no-idle-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({
      api: "ak-package-tool-no-idle",
      provider: "ak-package-tool-no-idle",
      tokenSize: { min: 1000, max: 1000 },
    });
    return withInProcessPi({
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      noTools: "builtin",
      systemPrompt: "PACKAGE TOOL NO IDLE",
      mode: "print",
      flags: {},
      extensionFactories: [
        (pi: ExtensionAPI) => {
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
  "silent package tool stays pending past former 183s tool-idle budget under role-runtime registration",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 183_000);

    let executeCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalExitCode = process.exitCode;
    const callId = "package-tool-no-idle-silent";

    const silentTool = defineTool({
      name: PACKAGE_TOOL,
      label: "Silent package-owned tool",
      description: "Hangs without progress — former tool-idle kill scene",
      parameters: Type.Object({}),
      async execute() {
        executeCount += 1;
        await gate;
        return {
          content: [{ type: "text" as const, text: "survived past 183s" }],
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
          () => fauxAssistantMessage("continued after delayed tool resolve"),
        ]);

        const promptDone = session.prompt("exercise silent package tool without idle kill");
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

        // Former package-owned tool idle budget. Mechanism removed — must remain pending.
        t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
        await flushEventLoopTurns(50);
        assert.equal(
          toolResults(session, PACKAGE_TOOL).length,
          0,
          "no tool-idle isError after 183s silence",
        );
        assert.equal(promptSettled, false, "session still awaits the tool");

        // One more full former budget — still alive.
        t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
        await flushEventLoopTurns(20);
        assert.equal(
          toolResults(session, PACKAGE_TOOL).length,
          0,
          "still no tool-idle kill after 366s mocked silence",
        );

        release();
        await flushEventLoopTurns(50);
        await promptDone;

        const results = toolResults(session, PACKAGE_TOOL);
        assert.equal(results.length, 1, "exactly one tool result after natural resolve");
        const result = results[0] as {
          isError?: boolean;
          toolCallId?: string;
          content: Array<{ type: string; text?: string }>;
        };
        assert.notEqual(result.isError, true, "natural resolve is not isError");
        assert.equal(result.toolCallId, callId);
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        assert.match(text, /survived past 183s/);
        assert.doesNotMatch(text, /package-owned tool idle timeout/i);
        assert.doesNotMatch(text, /PackageOwnedToolIdleTimeoutError/);
        assert.equal(executeCount, 1, "runtime does not retry the tool");
        assert.equal(process.exitCode, originalExitCode, "no role/process failure exit");
      });
    } finally {
      process.exitCode = originalExitCode;
    }
  },
);

test(
  "stream idle (#102) still owns compliance silence: retries then exhausts as StreamIdleTimeoutError",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 183_000);
    assert.equal(DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, 2);

    let complianceStreamAttempts = 0;
    const originalExitCode = process.exitCode;
    const callId = "judge-compliance-stream-idle-still-armed";

    try {
      await withActivationHome({ prefix: "ak-judge-stream-idle-kept-" }, async ({ home, agentDir }) => {
        const faux = fauxProvider({
          api: "ak-judge-stream-idle-kept",
          provider: "ak-judge-stream-idle-kept",
          tokenSize: { min: 1000, max: 1000 },
        });
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
          systemPrompt: "JUDGE STREAM IDLE KEPT",
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
          // Judge output → Gatekeeper → Notary → injected silent compliance child.
          const respond = (context: { tools?: Array<{ name: string }> }) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            if (names.includes(GATEKEEPER_OUTPUT_TOOL)) {
              return fauxAssistantMessage(
                fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "notary" }),
                { stopReason: "toolUse" },
              );
            }
            if (names.includes(NOTARY_OUTPUT_TOOL)) {
              return fauxAssistantMessage(
                fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
                { stopReason: "toolUse" },
              );
            }
            if (names.includes(INSPECTOR_OUTPUT_TOOL)) {
              return fauxAssistantMessage(
                fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }),
                { stopReason: "toolUse" },
              );
            }
            if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
              return fauxAssistantMessage(
                fauxToolCall(
                  JUDGE_OUTPUT_TOOL_NAME,
                  { judgeStatus: "converged" },
                  { id: callId },
                ),
                { stopReason: "toolUse" },
              );
            }
            return fauxAssistantMessage("continuation after compliance idle exhaustion");
          };
          faux.setResponses(Array.from({ length: 6 }, () => respond));

          const promptDone = session.prompt("adjudicate with silent compliance child");
          void promptDone.then(
            () => undefined,
            () => undefined,
          );

          await waitForEventLoopCondition(
            () => complianceStreamAttempts >= 1,
            { label: "judge submission entered real compliance child stream once" },
          );

          t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
          await waitForEventLoopCondition(
            () => complianceStreamAttempts >= 2,
            { label: "first StreamIdleTimeoutError must finite-retry the compliance stream" },
          );

          t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
          await waitForEventLoopCondition(
            () => complianceStreamAttempts >= DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1,
            { label: "inner owner arms the final compliance stream attempt" },
          );

          t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
          await flushEventLoopTurns(80);
          await promptDone.catch(() => undefined);

          assert.equal(
            complianceStreamAttempts,
            DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1,
            "exhaustion must not invent further compliance stream attempts",
          );

          const results = toolResults(session, JUDGE_OUTPUT_TOOL_NAME);
          assert.equal(results.length, 1, "exactly one judge tool result after stream idle exhaustion");
          const result = results[0] as {
            isError?: boolean;
            toolCallId?: string;
            content: Array<{ type: string; text?: string }>;
          };
          assert.equal(result.isError, true, "exhausted compliance stream idle surfaces as tool isError");
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
