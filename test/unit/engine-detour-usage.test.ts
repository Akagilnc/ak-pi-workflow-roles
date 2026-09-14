/**
 * #537 — typed ak_engine_detour tool usage ledger (write + read + absence rules).
 * Seam: engine-detour-usage module public API + sitian volume. No LLM / real CLI.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ENGINE_DETOUR_CALL_KIND,
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
  currentAttemptEngineDetourToolCallIds,
  engineDetourStdoutByteLength,
  readEngineDetourToolUsage,
  readInvocationEngineMounted,
  reportEngineDetourCall,
  withEngineDetourToolUsageFact,
} from "../../src/engine-detour-usage.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { withHermeticHome, seedGitRepository } from "../helpers/pi-test-harness.ts";

test("stdout byte length is UTF-8 Buffer.byteLength (empty is real 0)", () => {
  assert.equal(engineDetourStdoutByteLength(""), 0);
  assert.equal(engineDetourStdoutByteLength("abc"), 3);
  assert.equal(engineDetourStdoutByteLength("你好"), 6);
});

test("reportEngineDetourCall writes sitian row; spawn-failure omits code and bytes", async () => {
  await withHermeticHome({ prefix: "ak-detour-usage-write-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionParent = join(
      home,
      ".ak-roles",
      "books",
      "proj",
      "unbound",
      "runs",
      "r1@coder",
      "session",
      "session.jsonl",
    );
    await mkdir(join(sessionParent, ".."), { recursive: true });
    await writeFile(sessionParent, "", "utf8");

    const closed = reportEngineDetourCall({
      toolCallId: "call-ok",
      durationMs: 12,
      code: 0,
      stdoutByteLength: engineDetourStdoutByteLength("hello"),
      cwd: project,
      home,
      sessionParent,
      runId: "r1",
    });
    assert.equal(closed.code, 0);
    assert.equal(closed.stdoutByteLength, 5);
    assert.equal(closed.recordPointer.kind, ENGINE_DETOUR_CALL_KIND);

    const spawnMiss = reportEngineDetourCall({
      toolCallId: "call-spawn-miss",
      durationMs: 3,
      cwd: project,
      home,
      sessionParent,
      runId: "r1",
    });
    assert.equal("code" in spawnMiss, false);
    assert.equal("stdoutByteLength" in spawnMiss, false);

    const { records } = await readSitianRecords(closed.recordPointer.recordFile);
    assert.equal(records.length, 2);
    const okPayload = records.find((r) => r.identity.endsWith("call-ok"))?.payload as Record<string, unknown>;
    const missPayload = records.find((r) => r.identity.endsWith("call-spawn-miss"))?.payload as Record<string, unknown>;
    assert.equal(okPayload.tool, ENGINE_DETOUR_TOOL_NAME);
    assert.equal(okPayload.code, 0);
    assert.equal(okPayload.stdoutByteLength, 5);
    assert.equal("code" in missPayload, false);
    assert.equal("stdoutByteLength" in missPayload, false);
  });
});

test("readEngineDetourToolUsage: no engine → undefined; mounted zero → callCount 0; filters attempt ids", async () => {
  await withHermeticHome({ prefix: "ak-detour-usage-read-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionParent = join(
      home,
      ".ak-roles",
      "books",
      "proj",
      "unbound",
      "runs",
      "r2@coder",
      "session",
      "session.jsonl",
    );
    await mkdir(join(sessionParent, ".."), { recursive: true });
    await writeFile(sessionParent, "", "utf8");

    assert.equal(
      await readEngineDetourToolUsage({
        sessionParent,
        engineMounted: false,
        home,
        cwd: project,
      }),
      undefined,
    );

    const zero = await readEngineDetourToolUsage({
      sessionParent,
      engineMounted: true,
      home,
      cwd: project,
    });
    assert.deepEqual(zero, { callCount: 0, calls: [] });

    reportEngineDetourCall({
      toolCallId: "prior-attempt",
      durationMs: 1,
      code: 0,
      stdoutByteLength: 0,
      cwd: project,
      home,
      sessionParent,
    });
    reportEngineDetourCall({
      toolCallId: "this-attempt",
      durationMs: 9,
      code: 0,
      stdoutByteLength: 4,
      cwd: project,
      home,
      sessionParent,
    });

    const scoped = await readEngineDetourToolUsage({
      sessionParent,
      engineMounted: true,
      attemptToolCallIds: new Set(["this-attempt"]),
      home,
      cwd: project,
    });
    assert.equal(scoped?.callCount, 1);
    assert.equal(scoped?.calls[0]?.toolCallId, "this-attempt");
    assert.equal(scoped?.calls[0]?.durationMs, 9);
  });
});

test("attempt toolCallId scan and decisiveFacts merge leave payloads untouched", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: ENGINE_DETOUR_TOOL_NAME,
        toolCallId: "c1",
      },
    },
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: ENGINE_DETOUR_TOOL_NAME,
        toolCallId: "c2",
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "bash-1",
      },
    },
  ];
  const ids = currentAttemptEngineDetourToolCallIds(entries);
  assert.deepEqual([...ids], ["c2"]);

  const payload = { status: "completed", report: "x" };
  const outcome = {
    kind: "accepted" as const,
    role: "coder" as const,
    payloads: [payload],
    decisiveFacts: { other: 1 },
  };
  const merged = withEngineDetourToolUsageFact(outcome, {
    callCount: 1,
    calls: [{
      toolCallId: "c2",
      durationMs: 2,
      code: 0,
      stdoutByteLength: 0,
      recordPointer: {
        identity: "i",
        recordFile: "/r",
        kind: ENGINE_DETOUR_CALL_KIND,
        level: "event",
      },
    }],
  });
  assert.equal(merged.payloads, outcome.payloads);
  assert.deepEqual(merged.payloads?.[0], payload);
  assert.equal(merged.decisiveFacts?.other, 1);
  const usageFact = merged.decisiveFacts as Record<string, unknown>;
  assert.equal(
    (usageFact[ENGINE_DETOUR_TOOL_USAGE_FACT_KEY] as { callCount: number }).callCount,
    1,
  );
  assert.equal(
    withEngineDetourToolUsageFact(outcome, undefined),
    outcome,
  );
});

test("readInvocationEngineMounted reads non-empty engine axis only", async () => {
  await withHermeticHome({ prefix: "ak-detour-usage-inv-" }, async ({ home }) => {
    const runDir = join(home, "run");
    await mkdir(runDir, { recursive: true });
    assert.equal(await readInvocationEngineMounted(runDir), false);

    await writeFile(join(runDir, "invocation.json"), JSON.stringify({ engine: "" }), "utf8");
    assert.equal(await readInvocationEngineMounted(runDir), false);

    await writeFile(join(runDir, "invocation.json"), JSON.stringify({ engine: "kimi" }), "utf8");
    assert.equal(await readInvocationEngineMounted(runDir), true);
  });
});
