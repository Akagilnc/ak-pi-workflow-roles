/**
 * Shortest real tracer for judge-lane audit (#233 acceptance):
 * self-locate via AK_ROLE_RUN_DIR, zero projection, decision submit.
 * Does not mock internal helpers as the system under test.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";

test("frozen judge fixture: self-locate, gather law, decide without projected materials", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-fixture-tracer-"));
  const runDirectory = join(root, "run-frozen-judge");
  await mkdir(runDirectory);
  // Frozen target surface: law text the auditor must fetch itself.
  await writeFile(join(root, "LAW.md"), "Judge must cite authority before converge.\n");

  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  try {
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage({
      role: "user",
      content: "OWNER: adjudicate issue 233 against LAW.md",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "verdict-1",
        name: JUDGE_OUTPUT_TOOL_NAME,
        arguments: { judgeStatus: "converged", note: "authority cited" },
      }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });

    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      const user = context.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content))
        .join("\n");
      assert.equal(/judge_soul|adjudication_record|proposed_verdict/.test(user), false);
      if (turns === 1) {
        return fauxAssistantMessage(
          [fauxToolCall("read", { path: "LAW.md" })],
          { stopReason: "toolUse" },
        );
      }
      assert.ok(
        context.messages.some((message) =>
          message.role === "toolResult"
          && JSON.stringify(message.content).includes("cite authority")),
        "auditor must have read the frozen law target",
      );
      return fauxAssistantMessage(
        [fauxToolCall(JUDGE_AUDIT_TOOL_NAME, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        })],
        { stopReason: "toolUse" },
      );
    };

    const faux = fauxProvider({ provider: "judge-fixture" });
    faux.setResponses([complete, complete]);

    // Live auditor path (no runCompletion) — real session, tools, dossier preflight.
    const decision = await createPiJudgeAuditor()({
      context: {
        cwd: root,
        model: faux.getModel(),
        modelRegistry: {
          getProvider() { return faux.provider; },
          async getProviderAuth() { return { auth: { apiKey: "fixture" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "fixture" }; },
        },
        sessionManager,
      } as unknown as ExtensionContext,
    });

    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
