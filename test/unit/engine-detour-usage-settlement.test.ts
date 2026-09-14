/**
 * #537 — settlement projects engineDetourToolUsage onto decisiveFacts.
 * Real settleFailureTerminalResult entry; hermetic home; no LLM.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import {
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
  engineDetourStdoutByteLength,
  reportEngineDetourCall,
  type EngineDetourToolUsageFact,
} from "../../src/engine-detour-usage.ts";
import { createEngineDetourToolDefinition } from "../../src/engine-detour-tool.ts";
import { settleFailureTerminalResult } from "../../src/public-cli/settlement.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

async function seedRun(home: string, opts: {
  readonly runId: string;
  readonly engine?: string;
  readonly sessionRows?: unknown[];
}): Promise<{
  readonly project: string;
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
}> {
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  seedGitRepository(project);

  const runDirectory = join(
    home,
    ".ak-roles",
    "books",
    "proj",
    "unbound",
    "runs",
    `${opts.runId}@judge`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "invocation.json"),
    `${JSON.stringify(opts.engine === undefined ? {} : { engine: opts.engine })}\n`,
    "utf8",
  );
  const rows = opts.sessionRows ?? [
    { type: "message", message: { role: "user", content: "go" } },
  ];
  await writeFile(
    sessionFile,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return { project, runDirectory, sessionDirectory, sessionFile };
}

test("no engine: failure terminal has no engineDetourToolUsage field", async () => {
  await withHermeticHome({ prefix: "ak-detour-settle-noeng-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-noeng" });
    const admitted = fixtureJudgeAdmitted({
      runId: "r-noeng",
      runDirectory: seeded.runDirectory,
      projectRoot: seeded.project,
      bookKey: "proj",
      sessionDirectory: seeded.sessionDirectory,
      sessionFile: seeded.sessionFile,
    });
    const terminal = await settleFailureTerminalResult(
      admitted,
      { cause: "output", diagnostic: "boom" },
      piDurablePrincipalAuthority,
    );
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") return;
    assert.equal(
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY in terminal.roleOutcome.decisiveFacts,
      false,
    );
  });
});

test("engine mounted, zero calls: callCount 0 on failure terminal", async () => {
  await withHermeticHome({ prefix: "ak-detour-settle-zero-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-zero", engine: "kimi" });
    const admitted = fixtureJudgeAdmitted({
      runId: "r-zero",
      runDirectory: seeded.runDirectory,
      projectRoot: seeded.project,
      bookKey: "proj",
      sessionDirectory: seeded.sessionDirectory,
      sessionFile: seeded.sessionFile,
    });
    const terminal = await settleFailureTerminalResult(
      admitted,
      { cause: "output", diagnostic: "boom" },
      piDurablePrincipalAuthority,
    );
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") return;
    const usage = terminal.roleOutcome.decisiveFacts[
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY
    ] as EngineDetourToolUsageFact;
    assert.deepEqual(usage, { callCount: 0, calls: [] });
  });
});

test("tool execute records sitian call; settlement surfaces metrics + pointer", async () => {
  await withHermeticHome({ prefix: "ak-detour-settle-call-" }, async ({ home }) => {
    const seeded = await seedRun(home, {
      runId: "r-call",
      engine: "kimi",
      sessionRows: [
        { type: "message", message: { role: "user", content: "go" } },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-success",
            toolName: ENGINE_DETOUR_TOOL_NAME,
            isError: false,
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
    });

    // Live write path (same as tool execute after child close).
    const fact = reportEngineDetourCall({
      toolCallId: "call-success",
      durationMs: 15,
      code: 0,
      stdoutByteLength: engineDetourStdoutByteLength("ok"),
      cwd: seeded.project,
      home,
      sessionParent: seeded.sessionFile,
      runId: "r-call",
    });
    assert.equal(fact.stdoutByteLength, 2);

    // Tool path also records when sessionManager is present.
    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail(error) {
        throw error;
      },
    });
    const echoScript = join(seeded.project, "echo-ok.mjs");
    await writeFile(echoScript, 'process.stdout.write("hi")\n', "utf8");
    await tool.execute(
      "call-via-tool",
      { argv: [process.execPath, echoScript] },
      undefined,
      undefined,
      {
        cwd: seeded.project,
        mode: "test",
        abort() {},
        sessionManager: { getSessionFile: () => seeded.sessionFile },
        runDirectory: seeded.runDirectory,
      },
    );

    // Second attempt user message scopes out prior calls.
    await writeFile(
      seeded.sessionFile,
      `${[
        { type: "message", message: { role: "user", content: "first" } },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-success",
            toolName: ENGINE_DETOUR_TOOL_NAME,
            isError: false,
          },
        },
        { type: "message", message: { role: "user", content: "resume" } },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-via-tool",
            toolName: ENGINE_DETOUR_TOOL_NAME,
            isError: false,
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );

    const admitted = fixtureJudgeAdmitted({
      runId: "r-call",
      runDirectory: seeded.runDirectory,
      projectRoot: seeded.project,
      bookKey: "proj",
      sessionDirectory: seeded.sessionDirectory,
      sessionFile: seeded.sessionFile,
    });
    const terminal = await settleFailureTerminalResult(
      admitted,
      { cause: "output", diagnostic: "after detour" },
      piDurablePrincipalAuthority,
    );
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") return;
    const usage = terminal.roleOutcome.decisiveFacts[
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY
    ] as EngineDetourToolUsageFact;
    assert.equal(usage.callCount, 1);
    assert.equal(usage.calls[0]?.toolCallId, "call-via-tool");
    assert.equal(usage.calls[0]?.code, 0);
    assert.equal(usage.calls[0]?.stdoutByteLength, 2);
    assert.equal(typeof usage.calls[0]?.durationMs, "number");
    assert.equal(usage.calls[0]?.recordPointer.kind, "engine-detour-call");
    // Pointer opens the sitian volume row for this toolCallId.
    const { readSitianRecords } = await import("../../src/sitian-facade.ts");
    const opened = await readSitianRecords(usage.calls[0]!.recordPointer.recordFile);
    assert.ok(
      opened.records.some(
        (row) =>
          row.identity === usage.calls[0]!.recordPointer.identity
          && (row.payload as { toolCallId?: string }).toolCallId === "call-via-tool",
      ),
    );
  });
});

test("spawn failure records duration only; facts coexist with failure terminal", async () => {
  await withHermeticHome({ prefix: "ak-detour-settle-spawn-" }, async ({ home }) => {
    const seeded = await seedRun(home, {
      runId: "r-spawn",
      engine: "kimi",
      sessionRows: [
        { type: "message", message: { role: "user", content: "go" } },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-spawn-miss",
            toolName: ENGINE_DETOUR_TOOL_NAME,
            isError: true,
          },
        },
      ],
    });

    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail(error) {
        throw error;
      },
    });
    await assert.rejects(
      tool.execute(
        "call-spawn-miss",
        { argv: ["ak-engine-definitely-missing-binary-xyz-537"] },
        undefined,
        undefined,
        {
          cwd: seeded.project,
          mode: "test",
          abort() {},
          sessionManager: { getSessionFile: () => seeded.sessionFile },
          runDirectory: seeded.runDirectory,
        },
      ),
    );

    const admitted = fixtureJudgeAdmitted({
      runId: "r-spawn",
      runDirectory: seeded.runDirectory,
      projectRoot: seeded.project,
      bookKey: "proj",
      sessionDirectory: seeded.sessionDirectory,
      sessionFile: seeded.sessionFile,
    });
    const terminal = await settleFailureTerminalResult(
      admitted,
      {
        cause: "output",
        diagnostic: "spawn failed",
        identity: { name: "EngineDetourInfrastructureError" },
      },
      piDurablePrincipalAuthority,
    );
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") return;
    // Failure terminal keeps its own facts and gains usage.
    assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "EngineDetourInfrastructureError");
    const usage = terminal.roleOutcome.decisiveFacts[
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY
    ] as EngineDetourToolUsageFact;
    assert.equal(usage.callCount, 1);
    assert.equal(usage.calls[0]?.toolCallId, "call-spawn-miss");
    assert.equal("code" in usage.calls[0]!, false);
    assert.equal("stdoutByteLength" in usage.calls[0]!, false);
    assert.equal(typeof usage.calls[0]?.durationMs, "number");
  });
});
