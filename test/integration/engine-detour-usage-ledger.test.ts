/**
 * #537 — ak_engine_detour usage ledger through the real public entry.
 *
 * Drives `runAkRole` + host-neutral `createMinimalHost` (composition root).
 * Asserts only structured TerminalResult.roleOutcome.decisiveFacts — never
 * stdout/table presentation (ADR 0052 / anchoring constitution).
 *
 * Tool execute still owns sitian live-write; settlement projects this-invocation
 * aggregate. Failure paths go through the tool fail seam (session toolResult
 * join key written there), not a pre-planted key.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import {
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
  type EngineDetourToolUsageFact,
} from "../../src/engine-detour-usage.ts";
import { createEngineDetourToolDefinition } from "../../src/engine-detour-tool.ts";
import type { RoleTurnRequest, RoleTurnResult } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import {
  recordAuditEscalationSubmission,
  sealAcceptedSubmission,
} from "../helpers/submission-ledger-fixture.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

const ENGINE = "kimi";
const JUDGE_ACCEPTED = { judgeStatus: "converged" as const };

type DetourKind = "ok" | "spawn" | "nonzero" | "empty";

type TurnPlan = {
  readonly detours?: readonly {
    readonly toolCallId: string;
    readonly kind: DetourKind;
  }[];
  /** Prior-attempt detours, then a fresh user row, then current-attempt detours. */
  readonly resumeSplit?: {
    readonly prior: readonly { readonly toolCallId: string; readonly kind: DetourKind }[];
    readonly current: readonly { readonly toolCallId: string; readonly kind: DetourKind }[];
  };
  readonly terminal:
    | { readonly kind: "accepted" }
    | { readonly kind: "audit_escalation" }
    | { readonly kind: "no_receipt" }
    | {
        readonly kind: "failure";
        readonly knownFailure: NonNullable<RoleTurnResult["knownFailure"]>;
      };
};

function usageOf(terminal: TerminalResult | undefined): EngineDetourToolUsageFact | undefined {
  if (terminal === undefined) return undefined;
  const facts = terminal.roleOutcome.decisiveFacts as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (facts === undefined) return undefined;
  const usage = facts[ENGINE_DETOUR_TOOL_USAGE_FACT_KEY];
  return usage as EngineDetourToolUsageFact | undefined;
}

/** Host-shaped fail: durable toolResult then stop (mirrors infrastructure seam). */
function failWritingToolResult(sessionFile: string) {
  return (error: Error, toolCallId: string): never => {
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: ENGINE_DETOUR_TOOL_NAME,
          isError: true,
          content: [{ type: "text", text: error.message }],
        },
      })}\n`,
      "utf8",
    );
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

async function ensureScripts(project: string): Promise<{
  readonly echo: string;
  readonly nonzero: string;
  readonly empty: string;
}> {
  const echo = join(project, "detour-echo.mjs");
  const nonzero = join(project, "detour-nonzero.mjs");
  const empty = join(project, "detour-empty.mjs");
  await writeFile(echo, 'process.stdout.write("hi")\n', "utf8");
  await writeFile(nonzero, 'process.stdout.write("partial"); process.exit(2);\n', "utf8");
  await writeFile(empty, "process.exit(0);\n", "utf8");
  return { echo, nonzero, empty };
}

async function runDetours(input: {
  readonly project: string;
  readonly sessionFile: string;
  readonly runDirectory: string;
  readonly calls: readonly { readonly toolCallId: string; readonly kind: DetourKind }[];
}): Promise<void> {
  if (input.calls.length === 0) return;
  const scripts = await ensureScripts(input.project);
  for (const call of input.calls) {
    if (call.kind === "ok") {
      const tool = createEngineDetourToolDefinition({
        engineName: ENGINE,
        fail(error) {
          throw error;
        },
      });
      await tool.execute(
        call.toolCallId,
        { argv: [process.execPath, scripts.echo] },
        undefined,
        undefined,
        {
          cwd: input.project,
          mode: "test",
          abort() {},
          sessionManager: { getSessionFile: () => input.sessionFile },
          runDirectory: input.runDirectory,
        },
      );
      await appendSuccessToolResult(input.sessionFile, call.toolCallId);
      continue;
    }

    const tool = createEngineDetourToolDefinition({
      engineName: ENGINE,
      fail: failWritingToolResult(input.sessionFile),
    });
    const argv =
      call.kind === "spawn"
        ? ["ak-engine-definitely-missing-binary-xyz-537"]
        : call.kind === "nonzero"
          ? [process.execPath, scripts.nonzero]
          : [process.execPath, scripts.empty];
    await assert.rejects(
      tool.execute(
        call.toolCallId,
        { argv },
        undefined,
        undefined,
        {
          cwd: input.project,
          mode: "test",
          abort() {},
          sessionManager: { getSessionFile: () => input.sessionFile },
          runDirectory: input.runDirectory,
        },
      ),
    );
  }
}

async function seedUserKickoff(sessionFile: string, text = "go"): Promise<void> {
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`,
    "utf8",
  );
}

async function finishTerminal(input: {
  readonly plan: TurnPlan;
  readonly request: RoleTurnRequest;
  readonly sessionFile: string;
  readonly runId: string;
}): Promise<RoleTurnResult> {
  const { plan, request, sessionFile, runId } = input;
  if (plan.terminal.kind === "accepted") {
    await appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "judge-out",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          isError: false,
          details: JUDGE_ACCEPTED,
        },
      })}\n`,
      "utf8",
    );
    await sealAcceptedSubmission({
      cwd: request.cwd,
      home: request.home,
      runId,
      runDirectory: request.runDirectory,
      role: "judge",
      details: JUDGE_ACCEPTED,
      toolCallId: "judge-out",
    });
    return { code: 0, stderr: "", timedOut: false };
  }

  if (plan.terminal.kind === "audit_escalation") {
    const projected = buildAuditEscalationResult(
      {
        status: "escalate",
        conflicts: ["authority"],
        decisionGate: { question: "who?", options: ["owner"] },
      },
      { role: "judge" },
    );
    await appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "judge-esc",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          isError: false,
          details: projected,
        },
      })}\n`,
      "utf8",
    );
    await recordAuditEscalationSubmission({
      cwd: request.cwd,
      home: request.home,
      runId,
      runDirectory: request.runDirectory,
      role: "judge",
      details: projected,
      toolCallId: "judge-esc",
    });
    return { code: 0, stderr: "", timedOut: false };
  }

  if (plan.terminal.kind === "no_receipt") {
    // Host ends cleanly with no sealed output → lawful no_receipt.
    return { code: 0, stderr: "", timedOut: false };
  }

  return {
    code: 1,
    stderr: plan.terminal.knownFailure.diagnostic ?? "failure",
    timedOut: false,
    knownFailure: plan.terminal.knownFailure,
  };
}

async function runPublicJudge(input: {
  readonly home: string;
  readonly project: string;
  readonly runId: string;
  readonly engine?: string;
  readonly plan: TurnPlan;
}): Promise<{ readonly result: Awaited<ReturnType<typeof runAkRole>> }> {
  const { io } = captureIo();
  const args = ["judge", "--project", input.project, "engine usage ledger"];
  if (input.engine !== undefined) args.push("--engine", input.engine);

  const result = await runAkRole(args, {
    packageRoot,
    home: input.home,
    cwd: input.project,
    io,
    credentials: { "openai-codex": true, xai: true },
    createRunId: () => input.runId,
    principalAuthority: piDurablePrincipalAuthority,
    roleTurnHost: createMinimalHost(async (request) => {
      const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
        request.principal,
      );
      await mkdir(sessionDirectory, { recursive: true });
      await seedUserKickoff(sessionFile);

      if (input.plan.resumeSplit !== undefined) {
        await runDetours({
          project: input.project,
          sessionFile,
          runDirectory: request.runDirectory,
          calls: input.plan.resumeSplit.prior,
        });
        await appendFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: { role: "user", content: "resume" },
          })}\n`,
          "utf8",
        );
        await runDetours({
          project: input.project,
          sessionFile,
          runDirectory: request.runDirectory,
          calls: input.plan.resumeSplit.current,
        });
      } else {
        await runDetours({
          project: input.project,
          sessionFile,
          runDirectory: request.runDirectory,
          calls: input.plan.detours ?? [],
        });
      }

      return finishTerminal({
        plan: input.plan,
        request,
        sessionFile,
        runId: input.runId,
      });
    }),
  });
  return { result };
}

test("public entry: four terminals carry engineDetourToolUsage when engine is mounted", async () => {
  await withHermeticHome({ prefix: "ak-detour-public-4term-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const rows: Array<{
      readonly label: string;
      readonly plan: TurnPlan;
      readonly expectKind: string;
      readonly expectCallCount: number;
      readonly expectToolCallId?: string;
    }> = [
      {
        label: "accepted-zero",
        plan: { terminal: { kind: "accepted" } },
        expectKind: "accepted",
        expectCallCount: 0,
      },
      {
        label: "accepted-once",
        plan: {
          detours: [{ toolCallId: "c-ok", kind: "ok" }],
          terminal: { kind: "accepted" },
        },
        expectKind: "accepted",
        expectCallCount: 1,
        expectToolCallId: "c-ok",
      },
      {
        label: "accepted-multi",
        plan: {
          detours: [
            { toolCallId: "c-a", kind: "ok" },
            { toolCallId: "c-b", kind: "ok" },
          ],
          terminal: { kind: "accepted" },
        },
        expectKind: "accepted",
        expectCallCount: 2,
      },
      {
        label: "audit-escalation-once",
        plan: {
          detours: [{ toolCallId: "c-esc", kind: "ok" }],
          terminal: { kind: "audit_escalation" },
        },
        expectKind: "audit_escalation",
        expectCallCount: 1,
        expectToolCallId: "c-esc",
      },
      {
        label: "no-receipt-zero",
        plan: { terminal: { kind: "no_receipt" } },
        expectKind: "no_receipt",
        expectCallCount: 0,
      },
      {
        label: "failure-coexist-spawn",
        plan: {
          detours: [{ toolCallId: "c-spawn", kind: "spawn" }],
          terminal: {
            kind: "failure",
            knownFailure: {
              cause: "output",
              diagnostic: "spawn failed",
              identity: { name: "EngineDetourInfrastructureError" },
            },
          },
        },
        expectKind: "failure",
        expectCallCount: 1,
        expectToolCallId: "c-spawn",
      },
      {
        label: "failure-nonzero",
        plan: {
          detours: [{ toolCallId: "c-nz", kind: "nonzero" }],
          terminal: {
            kind: "failure",
            knownFailure: {
              cause: "output",
              diagnostic: "nonzero",
              identity: { name: "EngineDetourInfrastructureError" },
            },
          },
        },
        expectKind: "failure",
        expectCallCount: 1,
        expectToolCallId: "c-nz",
      },
      {
        label: "failure-empty",
        plan: {
          detours: [{ toolCallId: "c-empty", kind: "empty" }],
          terminal: {
            kind: "failure",
            knownFailure: {
              cause: "output",
              diagnostic: "empty stdout",
              identity: { name: "EngineDetourInfrastructureError" },
            },
          },
        },
        expectKind: "failure",
        expectCallCount: 1,
        expectToolCallId: "c-empty",
      },
    ];

    for (const row of rows) {
      const { result } = await runPublicJudge({
        home,
        project,
        runId: `r-${row.label}`,
        engine: ENGINE,
        plan: row.plan,
      });
      assert.ok(result.terminal, `${row.label}: terminal required`);
      assert.equal(result.terminal.roleOutcome.kind, row.expectKind, row.label);
      const usage = usageOf(result.terminal);
      assert.ok(usage, `${row.label}: engineDetourToolUsage required when engine mounted`);
      assert.equal(usage.callCount, row.expectCallCount, row.label);
      assert.equal(usage.calls.length, row.expectCallCount, row.label);
      if (row.expectToolCallId !== undefined) {
        assert.equal(usage.calls[0]?.toolCallId, row.expectToolCallId, row.label);
      }
      if (row.label === "failure-coexist-spawn") {
        assert.equal(usage.calls[0] !== undefined && "code" in usage.calls[0], false);
        assert.equal(
          usage.calls[0] !== undefined && "stdoutByteLength" in usage.calls[0],
          false,
        );
        assert.equal(typeof usage.calls[0]?.durationMs, "number");
        if (result.terminal.roleOutcome.kind === "failure") {
          assert.equal(
            result.terminal.roleOutcome.decisiveFacts.errorName,
            "EngineDetourInfrastructureError",
          );
        }
      }
      if (row.label === "failure-nonzero") {
        assert.equal(usage.calls[0]?.code, 2);
        assert.equal(
          usage.calls[0]?.stdoutByteLength,
          Buffer.byteLength("partial", "utf8"),
        );
      }
      if (row.label === "failure-empty") {
        assert.equal(usage.calls[0]?.code, 0);
        assert.equal(usage.calls[0]?.stdoutByteLength, 0);
        assert.equal("stdoutByteLength" in (usage.calls[0] ?? {}), true);
      }
      if (row.label === "accepted-once") {
        assert.equal(usage.calls[0]?.code, 0);
        assert.equal(usage.calls[0]?.stdoutByteLength, 2);
        assert.equal(typeof usage.calls[0]?.durationMs, "number");
        const opened = await readSitianRecords(usage.calls[0]!.recordPointer.recordFile);
        assert.ok(
          opened.records.some(
            (r) =>
              r.identity === usage.calls[0]!.recordPointer.identity
              && (r.payload as { toolCallId?: string }).toolCallId === "c-ok",
          ),
          "sitian pointer must reopen the call",
        );
      }
      if (row.label === "accepted-multi") {
        assert.deepEqual(
          usage.calls.map((c) => c.toolCallId).sort(),
          ["c-a", "c-b"],
        );
      }
    }
  });
});

test("public entry: no engine → field absent; accepted payload bytes match sealed details", async () => {
  await withHermeticHome({ prefix: "ak-detour-public-noeng-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const without = await runPublicJudge({
      home,
      project,
      runId: "r-noeng",
      plan: { terminal: { kind: "accepted" } },
    });
    assert.equal(without.result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY in (without.result.terminal!.roleOutcome.decisiveFacts ?? {}),
      false,
    );
    const baselinePayloadBytes = Buffer.from(
      JSON.stringify(objectPayloads(without.result.terminal!.roleOutcome)),
    );

    const withEngineZero = await runPublicJudge({
      home,
      project,
      runId: "r-eng-zero",
      engine: ENGINE,
      plan: { terminal: { kind: "accepted" } },
    });
    assert.equal(withEngineZero.result.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(usageOf(withEngineZero.result.terminal), { callCount: 0, calls: [] });
    const zeroPayloadBytes = Buffer.from(
      JSON.stringify(objectPayloads(withEngineZero.result.terminal!.roleOutcome)),
    );
    assert.equal(
      Buffer.compare(baselinePayloadBytes, zeroPayloadBytes),
      0,
      "engine zero-call must not alter role payload bytes",
    );

    const withCalls = await runPublicJudge({
      home,
      project,
      runId: "r-eng-calls",
      engine: ENGINE,
      plan: {
        detours: [{ toolCallId: "c-pay", kind: "ok" }],
        terminal: { kind: "accepted" },
      },
    });
    assert.equal(withCalls.result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(usageOf(withCalls.result.terminal)?.callCount, 1);
    const callPayloadBytes = Buffer.from(
      JSON.stringify(objectPayloads(withCalls.result.terminal!.roleOutcome)),
    );
    assert.equal(
      Buffer.compare(baselinePayloadBytes, callPayloadBytes),
      0,
      "detour usage must not alter role payload bytes after real settlement",
    );
    assert.deepEqual(objectPayloads(withCalls.result.terminal!.roleOutcome), [JUDGE_ACCEPTED]);
  });
});

test("public entry: resume attempt boundary counts only current-attempt toolCallIds", async () => {
  await withHermeticHome({ prefix: "ak-detour-public-resume-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Same-session resume boundary inside one public invocation (attempt split).
    const { result } = await runPublicJudge({
      home,
      project,
      runId: "r-resume-split",
      engine: ENGINE,
      plan: {
        resumeSplit: {
          prior: [{ toolCallId: "prior-attempt", kind: "ok" }],
          current: [{ toolCallId: "this-attempt", kind: "ok" }],
        },
        terminal: { kind: "accepted" },
      },
    });
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    const usage = usageOf(result.terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "this-attempt");
  });
});

test("public entry: explicit resume invocation does not carry prior-run detour calls", async () => {
  await withHermeticHome({ prefix: "ak-detour-public-xresume-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "r-xresume";

    // Birth leg: engine + one detour, then leave resumable via typed-429 observation.
    {
      const { io } = captureIo();
      await runAkRole(
        ["judge", "--project", project, "seed detour", "--engine", ENGINE],
        {
          packageRoot,
          home,
          cwd: project,
          io,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          principalAuthority: piDurablePrincipalAuthority,
          roleTurnHost: createMinimalHost(async (request) => {
            const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
              request.principal,
            );
            await mkdir(sessionDirectory, { recursive: true });
            await seedUserKickoff(sessionFile, "birth");
            await runDetours({
              project,
              sessionFile,
              runDirectory: request.runDirectory,
              calls: [{ toolCallId: "birth-call", kind: "ok" }],
            });
            await observeTyped429ViaProductionHandler({
              runDirectory: request.runDirectory,
              provider: "xai",
            });
            return { code: 1, stderr: "quota", timedOut: false };
          }),
        },
      );
    }

    {
      const { io, stderr } = captureIo();
      await runAkRole(["config", "set", "judge", "xai/grok-4.5:high"], {
        packageRoot,
        home,
        io,
      });
      assert.equal(stderr.join(""), "");
      await runAkRole(["config", "set-engine", "judge", ENGINE], {
        packageRoot,
        home,
        io,
      });
      assert.equal(stderr.join(""), "");
    }

    const { io, stdout, stderr } = captureIo();
    const resumed = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      principalAuthority: piDurablePrincipalAuthority,
      roleTurnHost: createMinimalHost(async (request) => {
        const { sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
        // Production resume appends a top-level user turn (settlement attempt boundary).
        // createMinimalHost does not synthesize it — mirror that durable boundary here.
        await appendFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: { role: "user", content: "resume continuation" },
          })}\n`,
          "utf8",
        );
        await runDetours({
          project,
          sessionFile,
          runDirectory: request.runDirectory,
          calls: [{ toolCallId: "resume-call", kind: "ok" }],
        });
        await appendFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "judge-out",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: JUDGE_ACCEPTED,
            },
          })}\n`,
          "utf8",
        );
        await sealAcceptedSubmission({
          cwd: request.cwd,
          home: request.home,
          runId,
          runDirectory: request.runDirectory,
          role: "judge",
          details: JUDGE_ACCEPTED,
          toolCallId: "judge-out",
        });
        return { code: 0, stderr: "", timedOut: false };
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") + "\n" + stderr.join(""));
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    const usage = usageOf(resumed.terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, "resume-call");
  });
});
