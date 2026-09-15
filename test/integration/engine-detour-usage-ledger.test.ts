/**
 * #537 — ak_engine_detour usage ledger through the real public entry.
 *
 * Drives `runAkRole` + host-neutral `createMinimalHost` (composition root).
 * Asserts only structured TerminalResult.roleOutcome.decisiveFacts — never
 * stdout/table presentation (ADR 0052 / anchoring constitution).
 *
 * Invocation scope is one public ak-role call: in-place auto-resume shares it;
 * explicit resume is a new unit. Not courtAttemptId and not Pi session
 * toolResult join keys.
 *
 * One shared public-entry tracer covers terminals / counts / payload / host /
 * UTF-8 / header-only. Auto-resume, explicit resume, and dual-fail stay as
 * separate boundaries (distinct contracts, prior judge order).
 */
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import {
  ENGINE_DETOUR_CALL_RECORD_FILE_RELATIVE,
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
  engineDetourCallIdentity,
  readEngineDetourToolUsage,
  type EngineDetourToolUsageFact,
} from "../../src/engine-detour-usage.ts";
import { createEngineDetourToolDefinition } from "../../src/engine-detour-tool.ts";
import type { RoleTurnRequest, RoleTurnResult } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { SitianInfrastructureError } from "../../src/sitian-contracts.ts";
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
/** Non-ASCII stdout — UTF-8 byte length is the ticket metric (你好 = 6). */
const ECHO_STDOUT = "你好";
const ECHO_STDOUT_BYTES = Buffer.byteLength(ECHO_STDOUT, "utf8");

type DetourKind = "ok" | "spawn" | "nonzero" | "empty";

type TurnPlan = {
  readonly detours?: readonly {
    readonly toolCallId: string;
    readonly kind: DetourKind;
  }[];
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

async function ensureScripts(project: string): Promise<{
  readonly echo: string;
  readonly nonzero: string;
  readonly empty: string;
}> {
  const echo = join(project, "detour-echo.mjs");
  const nonzero = join(project, "detour-nonzero.mjs");
  const empty = join(project, "detour-empty.mjs");
  await writeFile(echo, `process.stdout.write(${JSON.stringify(ECHO_STDOUT)})\n`, "utf8");
  await writeFile(nonzero, 'process.stdout.write("partial"); process.exit(2);\n', "utf8");
  await writeFile(empty, "process.exit(0);\n", "utf8");
  return { echo, nonzero, empty };
}

async function runDetours(input: {
  readonly project: string;
  readonly sessionFile: string;
  readonly runDirectory: string;
  readonly invocationScopeId?: string;
  readonly host?: string;
  readonly calls: readonly { readonly toolCallId: string; readonly kind: DetourKind }[];
}): Promise<void> {
  if (input.calls.length === 0) return;
  const scripts = await ensureScripts(input.project);
  for (const call of input.calls) {
    const ctx = {
      cwd: input.project,
      mode: "test",
      abort() {},
      sessionManager: { getSessionFile: () => input.sessionFile },
      runDirectory: input.runDirectory,
      ...(input.invocationScopeId === undefined
        ? {}
        : { invocationScopeId: input.invocationScopeId }),
      ...(input.host === undefined ? {} : { host: input.host }),
    };

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
        ctx,
      );
      continue;
    }

    const tool = createEngineDetourToolDefinition({
      engineName: ENGINE,
      fail(error) {
        throw error;
      },
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
        ctx,
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

/** Header-only session principal (non-Pi production shape). */
async function seedHeaderOnlySession(
  sessionFile: string,
  runId: string,
  cwd: string,
): Promise<void> {
  await writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: runId,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`,
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
  readonly headerOnlySession?: boolean;
}): Promise<{ readonly result: Awaited<ReturnType<typeof runAkRole>> }> {
  const { io } = captureIo();
  // #178: fresh public judge under hermetic home needs per-call --model (no seat table).
  const args = [
    "judge",
    "--model",
    "test/caller-seat:high",
    "--project",
    input.project,
    "engine usage ledger",
  ];
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
      if (input.headerOnlySession === true) {
        await seedHeaderOnlySession(sessionFile, input.runId, request.cwd);
      } else {
        await seedUserKickoff(sessionFile);
      }

      // Scope + selected host ride the shared Host envelope (RoleTurnRequest).
      await runDetours({
        project: input.project,
        sessionFile,
        runDirectory: request.runDirectory,
        ...(request.invocationScopeId === undefined
          ? {}
          : { invocationScopeId: request.invocationScopeId }),
        ...(request.host === undefined || request.host.trim() === ""
          ? {}
          : { host: request.host.trim() }),
        calls: input.plan.detours ?? [],
      });

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

/** Shared public-entry home: one hermetic project for the matrix tracer. */
async function withDetourProject(
  prefix: string,
  fn: (ctx: { home: string; project: string }) => Promise<void>,
): Promise<void> {
  await withHermeticHome({ prefix }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await fn({ home, project });
  });
}

test("public entry: one tracer for terminals, counts, payload, host, utf8, header-only", async () => {
  await withDetourProject("ak-detour-public-matrix-", async ({ home, project }) => {
    // no-engine baseline — field absent; payload bytes are the conservation yardstick
    const without = await runPublicJudge({
      home,
      project,
      runId: "r-noeng",
      plan: { terminal: { kind: "accepted" } },
    });
    assert.equal(without.result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      ENGINE_DETOUR_TOOL_USAGE_FACT_KEY
        in (without.result.terminal!.roleOutcome.decisiveFacts ?? {}),
      false,
    );
    const baselinePayloadBytes = Buffer.from(
      JSON.stringify(objectPayloads(without.result.terminal!.roleOutcome)),
    );

    const rows: Array<{
      readonly label: string;
      readonly plan: TurnPlan;
      readonly expectKind: string;
      readonly expectCallCount: number;
      readonly expectToolCallId?: string;
      readonly headerOnlySession?: boolean;
      readonly checkPayload?: boolean;
    }> = [
      {
        label: "accepted-zero",
        plan: { terminal: { kind: "accepted" } },
        expectKind: "accepted",
        expectCallCount: 0,
        checkPayload: true,
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
        checkPayload: true,
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
        label: "header-only",
        plan: {
          detours: [{ toolCallId: "c-header", kind: "ok" }],
          terminal: { kind: "accepted" },
        },
        expectKind: "accepted",
        expectCallCount: 1,
        expectToolCallId: "c-header",
        headerOnlySession: true,
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
        label: "no-receipt-once",
        plan: {
          detours: [{ toolCallId: "c-nr", kind: "ok" }],
          terminal: { kind: "no_receipt" },
        },
        expectKind: "no_receipt",
        expectCallCount: 1,
        expectToolCallId: "c-nr",
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
        ...(row.headerOnlySession === true ? { headerOnlySession: true } : {}),
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
      if (row.checkPayload === true) {
        const payloadBytes = Buffer.from(
          JSON.stringify(objectPayloads(result.terminal.roleOutcome)),
        );
        assert.equal(
          Buffer.compare(baselinePayloadBytes, payloadBytes),
          0,
          `${row.label}: detour usage must not alter role payload bytes`,
        );
        assert.deepEqual(objectPayloads(result.terminal.roleOutcome), [JUDGE_ACCEPTED]);
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
      if (row.label === "accepted-once" || row.label === "no-receipt-once") {
        assert.equal(usage.calls[0]?.code, 0);
        // UTF-8 non-ASCII byte length through the real tool → sitian → decisiveFacts path
        assert.equal(usage.calls[0]?.stdoutByteLength, ECHO_STDOUT_BYTES);
        assert.equal(typeof usage.calls[0]?.durationMs, "number");
        const opened = await readSitianRecords(usage.calls[0]!.recordPointer.recordFile);
        assert.ok(
          opened.records.some(
            (r) =>
              r.identity === usage.calls[0]!.recordPointer.identity
              && (r.payload as { toolCallId?: string }).toolCallId === row.expectToolCallId,
          ),
          `${row.label}: sitian pointer must reopen the call`,
        );
      }
      if (row.label === "accepted-multi") {
        assert.deepEqual(
          usage.calls.map((c) => c.toolCallId).sort(),
          ["c-a", "c-b"],
        );
      }
    }

    // Host provenance via shared public entry: --host codex projects onto
    // RoleTurnRequest/HostContext and into sitian — never invent default pi,
    // never pre-spawn invocation.json reread for the detour tool.
    {
      const runId = "r-hostprov";
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        [
          "judge",
          "--model",
          "test/caller-seat:high",
          "--project",
          project,
          "host provenance",
          "--engine",
          ENGINE,
          "--host",
          "codex",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          io,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          principalAuthority: piDurablePrincipalAuthority,
          hostAdapters: [
            {
              name: "codex",
              create: () => ({
                ok: true as const,
                host: createMinimalHost(async (request) => {
                  const { sessionDirectory, sessionFile } =
                    piDurablePrincipalAuthority.decode(request.principal);
                  await mkdir(sessionDirectory, { recursive: true });
                  await seedUserKickoff(sessionFile);
                  assert.equal(
                    request.host,
                    "codex",
                    "selected host must ride RoleTurnRequest envelope",
                  );
                  await runDetours({
                    project,
                    sessionFile,
                    runDirectory: request.runDirectory,
                    ...(request.invocationScopeId === undefined
                      ? {}
                      : { invocationScopeId: request.invocationScopeId }),
                    ...(request.host === undefined || request.host.trim() === ""
                      ? {}
                      : { host: request.host.trim() }),
                    calls: [{ toolCallId: "host-call", kind: "ok" }],
                  });
                  return finishTerminal({
                    plan: {
                      detours: [{ toolCallId: "host-call", kind: "ok" }],
                      terminal: { kind: "accepted" },
                    },
                    request,
                    sessionFile,
                    runId,
                  });
                }),
              }),
            },
          ],
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") + "\n" + stderr.join(""));
      const usage = usageOf(result.terminal);
      assert.equal(usage?.callCount, 1);
      const openedHost = await readSitianRecords(
        usage!.calls[0]!.recordPointer.recordFile,
      );
      const hostRow = openedHost.records.find(
        (r) => r.identity === usage!.calls[0]!.recordPointer.identity,
      );
      assert.equal(hostRow?.host, "codex");
    }
  });
});

test("public entry: in-place auto-resume keeps one invocation scope across detours", async () => {
  await withDetourProject("ak-detour-public-autoresume-", async ({ home, project }) => {
    {
      const { io } = captureIo();
      await runAkRole(["config", "set-auto-resume-limit", "2"], {
        packageRoot,
        home,
        io,
      });
    }

    const runId = "r-autoresume-scope";
    let turn = 0;
    const scopesSeen: string[] = [];

    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "judge",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "auto-resume scope",
        "--engine",
        ENGINE,
      ],
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
          if (turn === 0) {
            await seedUserKickoff(sessionFile, "first");
          } else {
            await appendFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: { role: "user", content: "auto-resume" },
              })}\n`,
              "utf8",
            );
          }

          const scope = request.invocationScopeId;
          assert.ok(scope, "public entry must put invocation scope on Host envelope");
          scopesSeen.push(scope);

          // Distinct toolCallIds (real host mints unique ids); both must count under one scope.
          await runDetours({
            project,
            sessionFile,
            runDirectory: request.runDirectory,
            invocationScopeId: scope,
            ...(request.host === undefined || request.host.trim() === ""
              ? {}
              : { host: request.host.trim() }),
            calls: [
              {
                toolCallId: turn === 0 ? "before-retry" : "after-retry",
                kind: "ok",
              },
            ],
          });

          if (turn === 0) {
            turn += 1;
            await observeTyped429ViaProductionHandler({
              runDirectory: request.runDirectory,
              provider: "xai",
            });
            return { code: 1, stderr: "quota", timedOut: false };
          }

          turn += 1;
          return finishTerminal({
            plan: { terminal: { kind: "accepted" } },
            request,
            sessionFile,
            runId,
          });
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") + "\n" + stderr.join(""));
    assert.ok(turn >= 2, "auto-resume must re-dispatch at least once");
    assert.equal(scopesSeen.length >= 2, true);
    assert.ok(
      scopesSeen.every((s) => s === scopesSeen[0]),
      `in-place auto-resume must reuse one scope, got ${scopesSeen.join(",")}`,
    );
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    const usage = usageOf(result.terminal);
    assert.equal(usage?.callCount, 2, "pre-retry and post-retry detours share the invocation");
    assert.deepEqual(
      usage?.calls.map((c) => c.toolCallId).sort(),
      ["after-retry", "before-retry"],
    );
    const boundScope = scopesSeen[0]!;
    assert.equal(
      usage?.calls.find((c) => c.toolCallId === "before-retry")?.recordPointer.identity,
      engineDetourCallIdentity({
        toolCallId: "before-retry",
        invocationScopeId: boundScope,
      }),
    );
  });
});

test("public entry: explicit resume is a new scope; reused toolCallId stays isolated; resumable redacts recordFile", async () => {
  await withDetourProject("ak-detour-public-xresume-", async ({ home, project }) => {
    const runId = "r-xresume";
    const sharedId = "shared-tool-call-id";

    {
      const { io } = captureIo();
      const first = await runAkRole(
        [
          "judge",
          "--model",
          "test/caller-seat:high",
          "--project",
          project,
          "seed detour",
          "--engine",
          ENGINE,
        ],
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
              ...(request.invocationScopeId === undefined
                ? {}
                : { invocationScopeId: request.invocationScopeId }),
              ...(request.host === undefined || request.host.trim() === ""
                ? {}
                : { host: request.host.trim() }),
              calls: [{ toolCallId: sharedId, kind: "ok" }],
            });
            await observeTyped429ViaProductionHandler({
              runDirectory: request.runDirectory,
              provider: "xai",
            });
            return { code: 1, stderr: "quota", timedOut: false };
          }),
        },
      );
      // #108 / #537: resumable keeps openable relative pointer; runId only in resume.command.
      assert.ok(first.terminal?.resume, "typed 429 must settle resumable");
      assert.equal(first.terminal?.runId, undefined);
      assert.ok(
        (first.terminal?.resume.command ?? "").includes(runId),
        "resume.command must carry runId",
      );
      const firstUsage = usageOf(first.terminal);
      assert.equal(firstUsage?.callCount, 1);
      assert.equal(firstUsage?.calls[0]?.toolCallId, sharedId);
      assert.equal(
        firstUsage?.calls[0]?.recordPointer.recordFile,
        ENGINE_DETOUR_CALL_RECORD_FILE_RELATIVE,
      );
      assert.equal(
        (firstUsage?.calls[0]?.recordPointer.identity ?? "").includes(runId),
        false,
        "identity must not re-disclose runId",
      );
      assert.equal(
        JSON.stringify(firstUsage).includes(runId),
        false,
        "engineDetourToolUsage decisiveFacts must not re-disclose runId",
      );
      // Relative pointer reopens once run directory is known from resume.command.
      const bookRunsRoot = join(home, ".ak-roles", "books");
      const { readdirSync } = await import("node:fs");
      let absoluteRecord: string | undefined;
      for (const book of readdirSync(bookRunsRoot)) {
        const candidate = join(
          bookRunsRoot,
          book,
          "unbound",
          "runs",
          `${runId}@judge`,
          ENGINE_DETOUR_CALL_RECORD_FILE_RELATIVE,
        );
        try {
          await readFile(candidate);
          absoluteRecord = candidate;
          break;
        } catch {
          // try next book
        }
      }
      assert.ok(absoluteRecord, "relative pointer must resolve under the run from resume.command");
      const reopened = await readSitianRecords(absoluteRecord);
      assert.ok(
        reopened.records.some(
          (r) => r.identity === firstUsage?.calls[0]?.recordPointer.identity,
        ),
        "resumable pointer must reopen the call",
      );
    }

    {
      const { io } = captureIo();
      await runAkRole(["config", "set", "judge", "xai/grok-4.5:high"], {
        packageRoot,
        home,
        io,
      });
      await runAkRole(["config", "set-engine", "judge", ENGINE], {
        packageRoot,
        home,
        io,
      });
    }

    const { io, stdout, stderr } = captureIo();
    let resumeScope: string | undefined;
    const resumed = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      principalAuthority: piDurablePrincipalAuthority,
      roleTurnHost: createMinimalHost(async (request) => {
        const { sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
        await appendFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: { role: "user", content: "resume continuation" },
          })}\n`,
          "utf8",
        );
        resumeScope = request.invocationScopeId;
        // Same toolCallId as prior public call — new scope keeps identities distinct.
        await runDetours({
          project,
          sessionFile,
          runDirectory: request.runDirectory,
          ...(resumeScope === undefined ? {} : { invocationScopeId: resumeScope }),
          ...(request.host === undefined || request.host.trim() === ""
            ? {}
            : { host: request.host.trim() }),
          calls: [{ toolCallId: sharedId, kind: "ok" }],
        });
        return finishTerminal({
          plan: { terminal: { kind: "accepted" } },
          request,
          sessionFile,
          runId,
        });
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") + "\n" + stderr.join(""));
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    const usage = usageOf(resumed.terminal);
    assert.equal(usage?.callCount, 1);
    assert.equal(usage?.calls[0]?.toolCallId, sharedId);
    assert.ok(resumeScope, "explicit resume must mint a fresh invocation scope");
    assert.equal(
      usage?.calls[0]?.recordPointer.identity,
      engineDetourCallIdentity({
        toolCallId: sharedId,
        invocationScopeId: resumeScope,
      }),
    );
    // Accepted (non-resumable) keeps recordFile for pointer reopen.
    assert.ok((usage?.calls[0]?.recordPointer.recordFile ?? "").length > 0);
  });
});

test("tool path: engine failure + sitian write failure keeps both causes via AggregateError", async () => {
  await withHermeticHome({ prefix: "ak-detour-dual-fail-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    const scripts = await ensureScripts(project);

    // Three real seams (spawn / nonzero / empty). Assert only AggregateError
    // structured causality — never Error.name/message prose (anchoring constitution).
    const cases: Array<{
      readonly label: string;
      readonly argv: string[];
      readonly expectEngineErrno?: string;
    }> = [
      {
        label: "spawn",
        argv: ["ak-engine-definitely-missing-binary-xyz-537"],
        expectEngineErrno: "ENOENT",
      },
      {
        label: "nonzero",
        argv: [process.execPath, scripts.nonzero],
      },
      {
        label: "empty",
        argv: [process.execPath, scripts.empty],
      },
    ];

    for (const row of cases) {
      const blockedSession = join(project, `blocked-session-parent-${row.label}`);
      await writeFile(blockedSession, "not-a-dir\n", "utf8");
      await chmod(blockedSession, 0o000);

      const tool = createEngineDetourToolDefinition({
        engineName: ENGINE,
        fail(error) {
          throw error;
        },
      });

      let thrown: unknown;
      try {
        await tool.execute(
          `dual-fail-${row.label}`,
          { argv: row.argv },
          undefined,
          undefined,
          {
            cwd: project,
            mode: "test",
            abort() {},
            sessionManager: { getSessionFile: () => blockedSession },
            runDirectory: join(home, "runs", `dual-${row.label}@judge`),
            host: "codex",
          },
        );
      } catch (error) {
        thrown = error;
      } finally {
        await chmod(blockedSession, 0o644).catch(() => undefined);
      }

      assert.ok(thrown instanceof AggregateError, `${row.label}: expected AggregateError`);
      const aggregate = thrown as AggregateError;
      assert.ok(
        aggregate.errors.length >= 2,
        `${row.label}: both engine and ledger failures required`,
      );
      const engineCause = aggregate.errors[0];
      const ledgerCause = aggregate.errors[1];
      assert.equal(
        aggregate.cause,
        engineCause,
        `${row.label}: AggregateError.cause must keep the engine object identity`,
      );
      assert.ok(engineCause instanceof Error, `${row.label}: engine cause is Error`);
      assert.ok(
        ledgerCause instanceof SitianInfrastructureError,
        `${row.label}: ledger cause is SitianInfrastructureError`,
      );
      if (row.expectEngineErrno !== undefined) {
        assert.equal(
          (engineCause as NodeJS.ErrnoException).code,
          row.expectEngineErrno,
          `${row.label}: spawn seam keeps structured errno`,
        );
      }
    }
  });
});
