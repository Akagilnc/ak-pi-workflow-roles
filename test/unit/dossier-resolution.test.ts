import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  JUDGE_OUTPUT_TOOL_NAME,
  resolveAuditDossier,
  readJudgeAuditSubjects,
} from "../../src/dossier-resolution.ts";

test("absent AK_ROLE_RUN_DIR is bare-Pi ok, not missing-dossier", () => {
  const previous = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const result = resolveAuditDossier();
    assert.deepEqual(result, { status: "ok" });
    assert.equal("runDirectory" in result && result.runDirectory !== undefined, false);
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
  }
});

test("nonexistent AK_ROLE_RUN_DIR is missing-dossier", async () => {
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = join(tmpdir(), "ak-missing-run-dir-does-not-exist");
  try {
    const result = resolveAuditDossier();
    assert.deepEqual(result, {
      status: "incomplete",
      observation: { kind: "missing-dossier" },
    });
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
  }
});

test("concurrent pointers keep two runs from crossing dossiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-dossier-concurrent-"));
  const previous = process.env.AK_ROLE_RUN_DIR;
  try {
    const runA = join(root, "run-a");
    const runB = join(root, "run-b");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(runA);
    await mkdir(runB);

    process.env.AK_ROLE_RUN_DIR = runA;
    const a = resolveAuditDossier();
    process.env.AK_ROLE_RUN_DIR = runB;
    const b = resolveAuditDossier();

    assert.equal(a.status, "ok");
    assert.equal(b.status, "ok");
    if (a.status === "ok" && b.status === "ok") {
      assert.equal(a.runDirectory, runA);
      assert.equal(b.runDirectory, runB);
      assert.notEqual(a.runDirectory, b.runDirectory);
    }
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("judge subjects require assignment and candidate verdict on the parent session", () => {
  const empty = SessionManager.inMemory();
  assert.deepEqual(readJudgeAuditSubjects({ sessionManager: empty } as unknown as ExtensionContext), {
    status: "incomplete",
    observation: { kind: "missing-subject", subject: "assignment" },
  });

  empty.appendMessage({ role: "user", content: "OWNER: adjudicate", timestamp: Date.now() });
  assert.deepEqual(readJudgeAuditSubjects({ sessionManager: empty } as unknown as ExtensionContext), {
    status: "incomplete",
    observation: { kind: "missing-subject", subject: "candidate-verdict" },
  });

  empty.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "v1", name: JUDGE_OUTPUT_TOOL_NAME, arguments: { judgeStatus: "converged" } }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const ready = readJudgeAuditSubjects({ sessionManager: empty } as unknown as ExtensionContext);
  assert.equal(ready.status, "ok");
});
