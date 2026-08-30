import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AssistantMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

function auditResponse(
  ...decisions: Array<Record<string, unknown>>
): AssistantMessage {
  return {
    role: "assistant",
    content: decisions.map((arguments_, index) => ({
      type: "toolCall" as const,
      id: `audit-${index}`,
      name: "ak_soul_audit_decision",
      arguments: arguments_,
    })),
    api: "openai-responses",
    provider: "openai",
    model: "auditor",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function seedSubjects(sessionManager: SessionManager): void {
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT",
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
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

function auditContext(runDirectory?: string): ExtensionContext {
  const model = { provider: "test", id: "auditor" };
  const sessionManager = SessionManager.inMemory();
  if (runDirectory !== undefined) {
    (sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
  }
  seedSubjects(sessionManager);
  return {
    model,
    sessionManager,
  } as unknown as ExtensionContext;
}

test("Pi judge auditor preserves authentication failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-auth-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  try {
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection("test", "auditor"),
    });
    const context = auditContext(runDirectory);
    const auditor = createPiJudgeAuditor();

    await assert.rejects(
      auditor({ context }),
      /authentication failed: provider is not configured: test/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
