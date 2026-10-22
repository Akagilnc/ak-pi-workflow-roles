// #1192: attendance is a table lookup — lifecycle, settle-by-status, grace and cancel.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRoleRuntimeExtension, projectClosedSubmissionLifecycle } from "../../src/role-runtime.ts";
import { buildNavigatorInfrastructureFailureFact } from "../../src/navigator-invocation-identity.ts";
import { createNavigatorAttendance, NAVIGATOR_EVENT_TYPE } from "../../src/navigator-attendance.ts";
import { createNavigatorLookup } from "../../src/navigator-lookup.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { extractNavigatorFact, NAVIGATOR_POST_ROLE_GRACE_MS } from "../../src/public-cli/settlement.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import { createDefaultGateOfficerSummon } from "../../src/submission-gate.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { projectActivationFlags } from "../../src/role-activation-flags.ts";
import type { RoleEnvelopeHost, RoleHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { flushEventLoopTurns, packageRoot, seedRoleRepo, waitForEventLoopCondition } from "../helpers/pi-test-harness.ts";
import { seedGitRepository, withActivationHome, withTempRoot } from "../helpers/environment-fixtures.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";

test("shared accepted submission binds settled attendance before public extraction; prior activation cannot deliver late", async () => {
  await withTempRoot("navigator-bound-closure-", async (home) => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const runDir = join(home, ".ak-roles", "books", "fixture", "unbound", "runs", "bound@judge");
    const previousRunDir = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = runDir;
    try {
      const handlers = new Map<string, (event: any, ctx: any) => any>();
      const tools = new Map<string, any>();
      const sent: unknown[] = [];
      const callbacks: Array<(event: any, report: any) => void | Promise<void>> = [];
      const host = {
        registerFlag() {}, getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
        on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        getAllTools() { return [...tools.values()]; },
        setActiveTools() {}, getActiveTools() { return [...tools.keys()]; },
        appendEntry() {},
      };
      createRoleRuntimeExtension({
        loadRoleSoul: async () => "JUDGE LAW",
        createNavigatorAttendance: (options) => {
          callbacks.push(options.onEvent);
          return {
            prepare() {}, isPreparing: () => false,
            async settle() {
              await options.onEvent({
                version: 1, disposition: "no-advice", invocationId: options.invocationId,
                role: options.role, phase: options.phase, subjectKey: options.subjectKey,
              }, { disposition: "no-advice" });
            },
            dispose() {},
          };
        },
      })({
        host: host as RoleHost, appendEntry: host.appendEntry,
        sendMessage(message) { sent.push(message); },
        startKeepalive() {}, stopKeepalive() {},
      });
      const sessionManager = SessionManager.create(home, join(runDir, "session"));
      const ctx = { cwd: home, sessionManager, runDirectory: runDir, abort() {} };
      await handlers.get("session_start")?.({}, ctx);
      const tool = tools.get(JUDGE_OUTPUT_TOOL_NAME);
      assert.ok(tool);
      await tool.execute("bound-output", { status: "converged" }, undefined, undefined, ctx);
      const entries = sessionManager.getEntries();
      const closure = entries.find((entry: any) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
      assert.equal((closure as any)?.data?.navigator?.disposition, "no-advice");
      assert.equal(extractNavigatorFact(entries).disposition, "no-advice");
      await handlers.get("session_start")?.({}, ctx);
      await callbacks[0]?.({ version: 1, disposition: "advice", prose: "late", invocationId: "old", role: "judge", phase: null, subjectKey: "old" }, { disposition: "advice", prose: "late" });
      await handlers.get("agent_settled")?.({}, ctx);
      assert.deepEqual(sent, []);
    } finally {
      if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    }
  });
});

test("settlement rejection still records an accepted closure with unavailable attendance", async () => {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const ctx = { sessionManager: { appendCustomEntry(customType: string, data: unknown) { entries.push({ customType, data }); } } } as never;
  const writeFailure = new Error("navigator write failed");
  await assert.rejects(projectClosedSubmissionLifecycle(
    { role: "judge", kind: "accepted", accepted: { status: "converged" } },
    ctx, null, () => {}, async () => { throw writeFailure; },
    (error) => { throw error; },
  ), (error: unknown) => error === writeFailure);
  assert.equal(entries.length, 1);
  assert.equal((entries[0]?.data as { navigator?: unknown }).navigator, undefined);
  assert.equal(extractNavigatorFact([{ type: "custom", ...entries[0]! }] as never).disposition, "unavailable");
});

test("station-child shared lifecycle omits Navigator attendance; top-level still creates it", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");

  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    await withActivationHome({ prefix: "ak-nav-station-child-" }, async ({ home }) => {
      // The public countersign and inner-gate notary use caller-set models (#178).
      const { runAkRole } = await import("../../src/public-cli/cli.ts");
      await runAkRole(
        ["config", "set",
          "countersign", "test/caller-seat:high",
          "judge", "test/caller-seat:high",
          "notary", "test/caller-seat:high",
          "gatekeeper", "test/caller-seat:high",
        ],
        { packageRoot, home, io: { stdout() {}, stderr() {} } },
      );
      async function attendanceCreatedFromTurn(request: RoleTurnRequest): Promise<boolean> {
        const runDir = request.runDirectory;
        await mkdir(join(runDir, "session"), { recursive: true });
        process.env.AK_ROLE_RUN_DIR = runDir;
        let created = false;
        const flags = projectActivationFlags(request);
        const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
        const tools: unknown[] = [];
        const pi = {
          registerFlag() {},
          getFlag(name: string) {
            return flags.get(name);
          },
          on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
            handlers.set(name, handler);
          },
          registerTool(tool: unknown) {
            tools.push(tool);
          },
          getAllTools() {
            return tools;
          },
          setActiveTools() {},
          getActiveTools() {
            return tools;
          },
          appendEntry() {},
        };
        const envelopeHost: RoleEnvelopeHost = {
          host: pi as RoleHost,
          appendEntry: pi.appendEntry,
          sendMessage() {},
          startKeepalive() {},
          stopKeepalive() {},
        };
        createRoleRuntimeExtension({
          loadRoleSoul: async (role) => {
            if (role === "countersign") return "COUNTERSIGN LAW";
            if (role === "notary") return "NOTARY LAW";
            return "JUDGE LAW";
          },
          loadNotarySourceRun: async (path: string) => ({
            runDirectory: path,
            runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
            role: "judge" as const,
          }),
          createNavigatorAttendance: () => {
            created = true;
            return {
              prepare() {},
              isPreparing: () => false,
              settle: async () => {},
              dispose() {},
            };
          },
        })(envelopeHost);
        const sessionManager = SessionManager.create(home, join(runDir, "session"));
        await handlers.get("session_start")?.({}, {
          cwd: home,
          sessionManager,
          abort() {},
        });
        return created;
      }

      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedRoleRepo(project);

      const captured: RoleTurnRequest[] = [];
      const recordingHost = (scripted: ReturnType<typeof roleTurnHostFromLegacyPiRunner>) => ({
        async executeTurn(request: RoleTurnRequest) {
          captured.push(request);
          return scripted.executeTurn(request);
        },
      });

      const countersignBase = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const roleIndex = args.indexOf("--ak-role");
          const role = roleIndex >= 0 ? args[roleIndex + 1] : undefined;
          if (role === "notary") {
            return scriptedTerminatingToolSession({
              role: "notary",
              toolName: NOTARY_OUTPUT_TOOL_NAME,
              details: { status: "converged", findings: [] },
            })(args, options);
          }
          return scriptedTerminatingToolSession({
            role: "countersign",
            toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
            details: { status: "converged", note: "署" },
          })(args, options);
        },
      });
      const countersignHost = recordingHost(countersignBase);
      const hostAdapters = [
        { name: "pi" as const, create: () => ({ ok: true as const, host: countersignHost }) },
        { name: "grok-build" as const, create: () => ({ ok: true as const, host: countersignHost }) },
      ];
      const { stdout, stderr, io } = captureIo();
      const countersignResult = await runPublicInstructionSeat(
        ["裁：继续审票 #582 是否足以开工。"],
        {
          home,
          agentDir: join(home, ".pi"),
          packageRoot,
          cwd: project,
          principalAuthority: piDurablePrincipalAuthority,
          sessionAppender: appendPiSessionCustomEntry,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: countersignHost,
          hostAdapters,
          createRunId: () => "01a0sign00-0000-7000-8000-00000000a1b",
        },
        io,
        "countersign",
        (args) => parsePublicSeatArgv("countersign", args),
      );
      assert.equal(countersignResult.exitCode, 0, stderr.join("") || stdout.join(""));
      const topLevel = captured.find((request) => request.activation.role === "countersign");
      assert.ok(topLevel, "countersign public entry must dispatch a top-level turn");
      assert.equal(captured.some((request) => request.activation.role === "diarist"), false,
        "countersign court must not summon a diarist child");

      captured.length = 0;
      const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 582 });
      const notaryBase = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: scriptedTerminatingToolSession({
          role: "notary",
          toolName: NOTARY_OUTPUT_TOOL_NAME,
          details: { status: "converged", findings: [] },
        }),
      });
      const notaryHost = recordingHost(notaryBase);
      const projected = await projectGatekeeperRun({
        context: {
          cwd: project,
          sessionManager: {
            getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
            getEntries: () => [
              {
                type: "message",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "call-a1b",
                      name: "ak_submission_output",
                      arguments: { status: "converged", note: "seat" },
                    },
                  ],
                },
              },
            ],
          },
        } as never,
        subject: { kind: "countersign_verdict" },
        runDirectory: sourceRunPath,
      summonOfficer: createDefaultGateOfficerSummon({
        cwd: project,
        home,
        packageRoot,
        roleTurnHost: notaryHost,
        createRunId: () => "01a082100-0000-7000-8000-0000000na1b",
      }),
    });
      assert.equal(projected.result.status, "converged");
      const notaryChild = captured.find((request) => request.activation.role === "notary");
      assert.ok(notaryChild, "inner-gate summons must dispatch a notary child turn");

      assert.equal(
        await attendanceCreatedFromTurn(topLevel),
        true,
        "top-level public activation must construct Navigator attendance",
      );
      assert.equal(
        await attendanceCreatedFromTurn(notaryChild),
        false,
        "inner-gate station child must not construct Navigator attendance",
      );
    });
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
  }
});

async function withNavigatorInfraGraceEnvelope(
  options: {
    readonly prefix: string;
    readonly runName: string;
  },
  run: (harness: {
    readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
    readonly sent: Array<{ customType?: string; details?: unknown }>;
    readonly ctx: { cwd: string; sessionManager: unknown; abort(): void; runDirectory: string };
    readonly seenSignal: () => AbortSignal | undefined;
    readonly summonStarted: () => boolean;
    readonly nestStopped: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  await withActivationHome({ prefix: options.prefix }, async ({ home }) => {
    seedGitRepository(home);
    await mkdir(join(home, ".ak-roles"), { recursive: true });

    const runDir = join(home, ".ak-roles", "books", basename(home), "runs", options.runName);
    await mkdir(join(runDir, "session"), { recursive: true });
    process.env.AK_ROLE_RUN_DIR = runDir;

    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const sent: Array<{ customType?: string; details?: unknown }> = [];
    let seenSignal: AbortSignal | undefined;
    let summonStarted = false;
    let nestStopped = false;
    const summon = async (summonOptions: {
      readonly role: "navigator";
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly home?: string;
      readonly signal?: AbortSignal;
    }) => {
      seenSignal = summonOptions.signal;
      summonStarted = true;
      assert.ok(seenSignal, "shared attendance must forward cancel signal into summon");
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          nestStopped = true;
          reject(seenSignal?.reason ?? new Error("navigator nest aborted"));
        };
        if (seenSignal!.aborted) {
          onAbort();
          return;
        }
        seenSignal!.addEventListener("abort", onAbort, { once: true });
      });
      return { exitCode: 1 };
    };

    const pi = {
      registerFlag() {},
      getFlag(name: string) {
        return name === "ak-role" ? "judge" : undefined;
      },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      getAllTools() {
        return [];
      },
      setActiveTools() {},
      getActiveTools() {
        return [];
      },
      appendEntry() {},
    };
    const envelopeHost: RoleEnvelopeHost = {
      host: pi as RoleHost,
      appendEntry: pi.appendEntry,
      sendMessage(message) {
        sent.push(message as { customType?: string; details?: unknown });
      },
      startKeepalive() {},
      stopKeepalive() {},
    };
    createRoleRuntimeExtension({
      loadRoleSoul: async () => "JUDGE LAW",
      createNavigatorAttendance: (attendanceOptions) =>
        createNavigatorAttendance({
          context: attendanceOptions.context,
          role: attendanceOptions.role,
          phase: attendanceOptions.phase,
          subjectKey: attendanceOptions.subjectKey,
          invocationId: attendanceOptions.invocationId,
          lookup: createNavigatorLookup({ summonPublicRole: summon }),
          onEvent: attendanceOptions.onEvent,
        }),
    })(envelopeHost);

    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionManager = SessionManager.create(home, join(runDir, "session"));
    const ctx = { cwd: home, sessionManager, abort() {}, runDirectory: runDir };
    await run({
      handlers,
      sent,
      ctx,
      seenSignal: () => seenSignal,
      summonStarted: () => summonStarted,
      nestStopped: () => nestStopped,
    });
  });
}

test("post-role grace aborts the hung lookup; session_shutdown does not re-block", async () => {
  // Real shared entry: session_start → infrastructure settlement → attendance settle →
  // lookup summon (listens to HostContext.signal) → grace dispose aborts nest →
  // session_shutdown must return without awaiting nested teardown (#959 reopen).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    await withNavigatorInfraGraceEnvelope(
      {
        prefix: "ak-nav-infra-grace-",
        runName: "judge-infra-grace",
      },
      async ({ handlers, sent, ctx, seenSignal, summonStarted, nestStopped }) => {
        await handlers.get("session_start")?.({}, ctx);

        await waitForEventLoopCondition(() => summonStarted(), {
          label: "parallel prepare must start nested public summon",
          timeoutMs: 2_000,
        });
        assert.equal(seenSignal()?.aborted, false, "nest stays live until grace dispose");

        const toolResult = handlers.get("tool_result");
        assert.ok(toolResult, "shared envelope must register tool_result");
        const pending = Promise.resolve(
          toolResult(
            {
              toolCallId: "infra-hung",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: true,
              details: buildNavigatorInfrastructureFailureFact(),
              content: [],
            },
            ctx,
          ),
        );
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        assert.equal(settled, false, "hung prepare must still be inside grace");
        assert.equal(seenSignal()?.aborted, false, "nest stays live until grace dispose");

        vi.advanceTimersByTime(NAVIGATOR_POST_ROLE_GRACE_MS);
        await waitForEventLoopCondition(() => settled && nestStopped(), {
          label: "post-role grace must release parent and abort nested summon",
          timeoutMs: 1_000,
        });
        assert.equal(seenSignal()?.aborted, true, "grace dispose must abort nested summon signal");
        assert.equal(nestStopped(), true, "nested summon must observe abort and stop");

        await handlers.get("agent_settled")?.({}, ctx);
        const presentation = sent.find((message) => message.customType === NAVIGATOR_EVENT_TYPE);
        assert.ok(presentation, "grace timeout must project navigator attendance");
        assert.equal(
          (presentation.details as { disposition?: string } | undefined)?.disposition,
          "unavailable",
        );
        assert.equal(
          (presentation.details as { unavailableReason?: string } | undefined)?.unavailableReason,
          "Navigator exceeded post-role delivery grace",
        );

        // Hung closing must not block shutdown (awaiting dispose would hang).
        let shutdownDone = false;
        const shutdown = Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)).then(
          () => {
            shutdownDone = true;
          },
        );
        await flushEventLoopTurns(5);
        assert.equal(shutdownDone, true, "session_shutdown must finish without awaiting teardown");
        await shutdown;
      },
    );
  } finally {
    vi.useRealTimers();
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
  }
});

