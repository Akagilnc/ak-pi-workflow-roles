/**
 * #537 — ak_engine_detour usage ledger through tool execute → sitian → settlement.
 * Integration tier: hermetic home, session files, settleFailureTerminalResult.
 * Failure paths go through the tool fail seam (session toolResult written there),
 * not a pre-planted join key.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import {
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
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

type SeededRun = {
  readonly project: string;
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

async function seedRun(home: string, opts: {
  readonly runId: string;
  readonly engine?: string;
}): Promise<SeededRun> {
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
  // Initial attempt user message — resume tests append another user row later.
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "message", message: { role: "user", content: "go" } })}\n`,
    "utf8",
  );
  return { project, runDirectory, sessionDirectory, sessionFile };
}

function admittedFor(seeded: SeededRun, runId: string) {
  return fixtureJudgeAdmitted({
    runId,
    runDirectory: seeded.runDirectory,
    projectRoot: seeded.project,
    bookKey: "proj",
    sessionDirectory: seeded.sessionDirectory,
    sessionFile: seeded.sessionFile,
  });
}

/** Host-shaped fail: durable toolResult then stop (mirrors infrastructure seam). */
function failWritingToolResult(sessionFile: string) {
  return (error: Error, toolCallId: string): never => {
    const row = JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: ENGINE_DETOUR_TOOL_NAME,
        isError: true,
        content: [{ type: "text", text: error.message }],
      },
    });
    // Sync append so the fail seam itself owns the join key before throw.
    appendFileSync(sessionFile, `${row}\n`, "utf8");
    throw error;
  };
}

async function appendSuccessToolResult(sessionFile: string, toolCallId: string): Promise<void> {
  await appendFile(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: ENGINE_DETOUR_TOOL_NAME,
        isError: false,
      },
    })}\n`,
    "utf8",
  );
}

async function settleFailure(seeded: SeededRun, runId: string, diagnostic: string) {
  return settleFailureTerminalResult(
    admittedFor(seeded, runId),
    { cause: "output", diagnostic },
    piDurablePrincipalAuthority,
  );
}

function usageOf(terminal: Awaited<ReturnType<typeof settleFailure>>): EngineDetourToolUsageFact | undefined {
  if (terminal.roleOutcome.kind !== "failure" && terminal.roleOutcome.kind !== "no_receipt") {
    const facts = terminal.roleOutcome.decisiveFacts;
    if (facts === undefined) return undefined;
    return facts[ENGINE_DETOUR_TOOL_USAGE_FACT_KEY] as EngineDetourToolUsageFact | undefined;
  }
  return terminal.roleOutcome.decisiveFacts[
    ENGINE_DETOUR_TOOL_USAGE_FACT_KEY
  ] as EngineDetourToolUsageFact | undefined;
}

test("no engine: failure terminal has no engineDetourToolUsage field", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-noeng-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-noeng" });
    const terminal = await settleFailure(seeded, "r-noeng", "boom");
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") return;
    assert.equal(
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY in terminal.roleOutcome.decisiveFacts,
      false,
    );
  });
});

test("engine mounted, zero calls: callCount 0 on failure terminal", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-zero-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-zero", engine: "kimi" });
    const terminal = await settleFailure(seeded, "r-zero", "boom");
    assert.equal(terminal.roleOutcome.kind, "failure");
    assert.deepEqual(usageOf(terminal), { callCount: 0, calls: [] });
  });
});

test("successful detour: metrics + sitian pointer on this-invocation usage", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-ok-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-ok", engine: "kimi" });
    const echoScript = join(seeded.project, "echo-ok.mjs");
    await writeFile(echoScript, 'process.stdout.write("hi")\n', "utf8");

    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail(error) {
        throw error;
      },
    });
    await tool.execute(
      "call-ok",
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
    // Success path: host would record toolResult; append the same join key.
    await appendSuccessToolResult(seeded.sessionFile, "call-ok");

    const terminal = await settleFailure(seeded, "r-ok", "after ok");
    const usage = usageOf(terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "call-ok");
    assert.equal(usage?.calls[0]?.code, 0);
    assert.equal(usage?.calls[0]?.stdoutByteLength, 2);
    assert.equal(typeof usage?.calls[0]?.durationMs, "number");
    const { readSitianRecords } = await import("../../src/sitian-facade.ts");
    const opened = await readSitianRecords(usage!.calls[0]!.recordPointer.recordFile);
    assert.ok(
      opened.records.some(
        (row) =>
          row.identity === usage!.calls[0]!.recordPointer.identity
          && (row.payload as { toolCallId?: string }).toolCallId === "call-ok",
      ),
    );
  });
});

test("spawn failure via fail seam: duration only; facts coexist with failure terminal", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-spawn-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-spawn", engine: "kimi" });
    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail: failWritingToolResult(seeded.sessionFile),
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

    const terminal = await settleFailureTerminalResult(
      admittedFor(seeded, "r-spawn"),
      {
        cause: "output",
        diagnostic: "spawn failed",
        identity: { name: "EngineDetourInfrastructureError" },
      },
      piDurablePrincipalAuthority,
    );
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") return;
    assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "EngineDetourInfrastructureError");
    const usage = usageOf(terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "call-spawn-miss");
    assert.equal(usage?.calls[0] !== undefined && "code" in usage.calls[0], false);
    assert.equal(
      usage?.calls[0] !== undefined && "stdoutByteLength" in usage.calls[0],
      false,
    );
    assert.equal(typeof usage?.calls[0]?.durationMs, "number");
  });
});

test("nonzero exit via fail seam: code and stdout bytes are real observed values", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-nonzero-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-nz", engine: "kimi" });
    const script = join(seeded.project, "exit-2.mjs");
    await writeFile(script, 'process.stdout.write("partial"); process.exit(2);\n', "utf8");

    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail: failWritingToolResult(seeded.sessionFile),
    });
    await assert.rejects(
      tool.execute(
        "call-nonzero",
        { argv: [process.execPath, script] },
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

    const terminal = await settleFailure(seeded, "r-nz", "nonzero");
    const usage = usageOf(terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "call-nonzero");
    assert.equal(usage?.calls[0]?.code, 2);
    assert.equal(usage?.calls[0]?.stdoutByteLength, Buffer.byteLength("partial", "utf8"));
  });
});

test("empty stdout via fail seam: code 0 with stdoutByteLength real 0 (not absent)", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-empty-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-empty", engine: "kimi" });
    const script = join(seeded.project, "empty.mjs");
    // Exit 0 with empty stdout is still an engine-detour failure (trim-empty).
    await writeFile(script, "process.exit(0);\n", "utf8");

    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail: failWritingToolResult(seeded.sessionFile),
    });
    await assert.rejects(
      tool.execute(
        "call-empty",
        { argv: [process.execPath, script] },
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

    const terminal = await settleFailure(seeded, "r-empty", "empty stdout");
    const usage = usageOf(terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "call-empty");
    assert.equal(usage?.calls[0]?.code, 0);
    assert.equal(usage?.calls[0]?.stdoutByteLength, 0);
    assert.equal("stdoutByteLength" in (usage?.calls[0] ?? {}), true);
  });
});

test("resume attempt boundary: only current-attempt toolCallIds count", async () => {
  await withHermeticHome({ prefix: "ak-detour-ledger-resume-" }, async ({ home }) => {
    const seeded = await seedRun(home, { runId: "r-resume", engine: "kimi" });
    const echoScript = join(seeded.project, "echo.mjs");
    await writeFile(echoScript, 'process.stdout.write("a")\n', "utf8");

    const tool = createEngineDetourToolDefinition({
      engineName: "kimi",
      fail(error) {
        throw error;
      },
    });
    const runOnce = async (toolCallId: string) => {
      await tool.execute(
        toolCallId,
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
      await appendSuccessToolResult(seeded.sessionFile, toolCallId);
    };

    await runOnce("prior-attempt");
    // Resume boundary: new top-level user message.
    await appendFile(
      seeded.sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "resume" } })}\n`,
      "utf8",
    );
    await runOnce("this-attempt");

    const terminal = await settleFailure(seeded, "r-resume", "resume scope");
    const usage = usageOf(terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "this-attempt");
  });
});
