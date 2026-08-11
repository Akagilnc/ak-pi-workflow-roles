/**
 * Shortest real tracer for judge-lane audit (#233 acceptance):
 * self-locate from the machine pointer, gather frozen law, pass and revise.
 * Does not mock internal helpers as the system under test.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUDITOR_DOSSIER_TOOL_NAME } from "../../src/auditor-dossier-tool.ts";
import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";

function seedJudgeCandidate(sessionManager: SessionManager, note: string): void {
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER: adjudicate issue 233 against the frozen law in the run dossier",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "verdict-1",
      name: JUDGE_OUTPUT_TOOL_NAME,
      arguments: { judgeStatus: "converged", note },
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
}

function auditContext(
  cwd: string,
  sessionManager: SessionManager,
  provider: ReturnType<typeof fauxProvider>,
): ExtensionContext {
  return {
    cwd,
    model: provider.getModel(),
    modelRegistry: {
      getProvider() { return provider.provider; },
      async getProviderAuth() { return { auth: { apiKey: "fixture" } }; },
      async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "fixture" }; },
    },
    sessionManager,
  } as unknown as ExtensionContext;
}

async function withFrozenJudgeFixture<T>(
  run: (input: {
    root: string;
    runDirectory: string;
    lawPath: string;
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-fixture-tracer-"));
  const runDirectory = join(root, "run-frozen-judge");
  await mkdir(join(runDirectory, "session"), { recursive: true });
  await mkdir(join(runDirectory, "attachments"));
  await mkdir(join(runDirectory, "artifacts"));
  await writeFile(join(runDirectory, "admitted-request.json"), "{}\n");
  // Frozen target lives inside the run dossier — model must locate it through
  // the run-bound typed tool, not an environment-variable convention.
  const lawPath = join(runDirectory, "attachments", "LAW.md");
  await writeFile(lawPath, "Judge must cite authority before converge.\n");
  try {
    return await run({ root, runDirectory, lawPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolResultText(context: Context): string {
  return context.messages
    .filter((message) => message.role === "toolResult")
    .map((message) => JSON.stringify(message.content))
    .join("\n");
}

test("frozen judge fixture: self-locate dossier, gather law, pass", async () => {
  await withFrozenJudgeFixture(async ({ root, runDirectory, lawPath }) => {
    const sessionManager = SessionManager.open(join(runDirectory, "session", "session.jsonl"));
    seedJudgeCandidate(sessionManager, "authority cited");

    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      if (turns === 1) {
        assert.ok(context.tools?.some((tool) => tool.name === AUDITOR_DOSSIER_TOOL_NAME));
        return fauxAssistantMessage(
          [fauxToolCall(AUDITOR_DOSSIER_TOOL_NAME, {})],
          { stopReason: "toolUse" },
        );
      }
      if (turns === 2) {
        assert.ok(
          toolResultText(context).includes(runDirectory),
          "auditor must observe the run dossier pointer before reading law",
        );
        return fauxAssistantMessage(
          [fauxToolCall("read", { path: lawPath })],
          { stopReason: "toolUse" },
        );
      }
      assert.ok(
        toolResultText(context).includes("cite authority"),
        "auditor must have read the frozen law target from the run dossier",
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

    const faux = fauxProvider({ provider: "judge-fixture-pass" });
    faux.setResponses([complete, complete, complete]);

    const decision = await createPiJudgeAuditor()({
      context: auditContext(process.cwd(), sessionManager, faux),
    });

    assert.equal(decision.status, "pass");
    assert.equal(turns, 3);
  });
});

test("frozen judge fixture: self-locate dossier, gather law, revise with concrete violation", async () => {
  await withFrozenJudgeFixture(async ({ root, runDirectory, lawPath }) => {
    const sessionManager = SessionManager.open(join(runDirectory, "session", "session.jsonl"));
    seedJudgeCandidate(sessionManager, "no authority");

    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      if (turns === 1) {
        return fauxAssistantMessage(
          [fauxToolCall(AUDITOR_DOSSIER_TOOL_NAME, {})],
          { stopReason: "toolUse" },
        );
      }
      if (turns === 2) {
        assert.ok(toolResultText(context).includes(runDirectory));
        return fauxAssistantMessage(
          [fauxToolCall("read", { path: lawPath })],
          { stopReason: "toolUse" },
        );
      }
      assert.ok(toolResultText(context).includes("cite authority"));
      return fauxAssistantMessage(
        [fauxToolCall(JUDGE_AUDIT_TOOL_NAME, {
          status: "revise",
          violations: ["candidate note lacks authority citation required by LAW.md"],
          conflicts: [],
          decisionGate: null,
        })],
        { stopReason: "toolUse" },
      );
    };

    const faux = fauxProvider({ provider: "judge-fixture-revise" });
    faux.setResponses([complete, complete, complete]);

    const decision = await createPiJudgeAuditor()({
      context: auditContext(process.cwd(), sessionManager, faux),
    });

    assert.equal(decision.status, "revise");
    if (decision.status === "revise") {
      assert.deepEqual(decision.violations, [
        "candidate note lacks authority citation required by LAW.md",
      ]);
    }
    assert.equal(turns, 3);
  });
});
