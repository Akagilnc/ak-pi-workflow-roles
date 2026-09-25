import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import assert from "node:assert/strict";
import { parentInheritedSeats, seatSelection, type SeatSelection } from "../helpers/seat-selection.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import test, { after, afterEach } from "node:test";

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context, type JsonObject, type Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { transcriptFromContext as productionTranscriptFromContext } from "../../extensions/role-runtime.ts";
import { createJudgeRoleRuntime } from "../../src/judge-role.ts";
import { createPiRoleHostAdapter, toPiContext, type PiRoleHostAdapter } from "../../src/pi/adapter.ts";
import type { HostContext, HostGatekeeperActions } from "../../src/host-contracts.ts";

import type { AuditorSummon } from "../../src/compliance-transport.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import {
  createNavigatorAttendance,
  type NavigatorEvent,
  type NavigatorPreparationSession,
} from "../../src/navigator-attendance.ts";
import { NAVIGATOR_INVOCATION_ENTRY } from "../../src/navigator-invocation-identity.ts";
import {
  createCoderRoleRuntime,
  createFixerRoleRuntime,
} from "../../src/worker-role.ts";
import type { RoleHost } from "../../src/host-contracts.ts";
import { FixerPacketValidationError } from "../../src/package-contracts/fixer-packet.ts";
import {
  WorkerCommitReminderError,
  WorkerUnfinishedReasonReminderError,
} from "../../src/worker-submission-gates.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type JudgeVerdict,
} from "../../src/role-runtime.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { NO_RECEIPT_LIFECYCLE_ENTRY_TYPE } from "../../src/receipt-delivery-policy.ts";
import { tryHomeFromAkRolesPath } from "../../src/activation-ledger-topology.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";

async function acceptThroughTypedRoundClosure(input: {
  handlers: Map<string, any>;
  tool: { execute: (...args: any[]) => Promise<any>; name?: string };
  toolCallId: string;
  toolName: string;
  output: unknown;
  context: any;
}): Promise<{ sealed: { readonly role: string; readonly accepted: unknown }; pending: any }> {
  // #836: submission records immediately with original payload; no pending-round-closure rewrite.
  const pending = await input.tool.execute(input.toolCallId, input.output, undefined, undefined, input.context);
  assert.deepEqual(pending.details, input.output);
  assert.equal(pending.terminate, true);
  const turnEnd = input.handlers.get("turn_end");
  assert.ok(turnEnd, "shared envelope must register turn_end");
  await turnEnd({
    turnIndex: 0,
    calls: [{ toolCallId: input.toolCallId, toolName: input.toolName }],
    toolResults: [{ toolCallId: input.toolCallId, toolName: input.toolName }],
  }, input.context);
  const runDirectory = process.env.AK_ROLE_RUN_DIR;
  assert.ok(typeof runDirectory === "string" && runDirectory.length > 0, "admitted run directory required");
  const runId = runIdFromRunDirectory(runDirectory);
  assert.ok(runId);
  const cwd = typeof input.context.cwd === "string" ? input.context.cwd : process.cwd();
  const ledgerHomeOwner = tryHomeFromAkRolesPath(runDirectory);
  assert.ok(ledgerHomeOwner, "institutional run must sit under temp .ak-roles topology");
  const rows = await readRecordedSubmissionRows(cwd, runId, ledgerHomeOwner);
  const sealed = rows.at(-1);
  assert.ok(sealed, "terminating submission must be recorded on the ledger");
  assert.ok(typeof sealed.role === "string" && sealed.role.length > 0, "sealed row must carry role");
  return { sealed: { role: sealed.role, accepted: sealed.accepted }, pending };
}
import {
  readTypedHttp429Observation,
  renderResumeCommand,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  extractNavigatorFact,
  formatTerminalResult,
  NAVIGATOR_POST_ROLE_GRACE_MS,
  settleJudgeFailureTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { scriptedGatekeeperModelRegistry } from "../helpers/faux-gatekeeper.ts";
import { createMockProviderServer, createTempPackageHomeLedger, packageRoot, withActivationHome, withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

// Gatekeeper children resolve their run binding from AK_ROLE_RUN_DIR (the
// tool.execute seam carries no explicit runDirectory option), so this local
// scope writes the page and manages env + temp dir per test — no global
// install registry in the shared helper, one page writer reused everywhere.
const activeLedgers = new Map<string, { dispose(): void }>();
function installInstitutionalRunDir(seats: Record<string, SeatSelection | undefined>): string {
  void seats; // seat page deleted (#675); argument retained for call-site shape only.
  // Publisher face is `<runId>@<role>` — sole runIdFromRunDirectory authority requires the @.
  // #604: nest under temp `.ak-roles` so session/ledger path-derive never hits real home.
  const runName = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@judge`;
  const ledger = createTempPackageHomeLedger({ prefix: "ak-judge-home-", runName });
  const runDirectory = ledger.runDirectory;
  activeLedgers.set(runDirectory, ledger);
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  return runDirectory;
}
function disposeInstitutionalRunDir(runDirectory: string): void {
  if (process.env.AK_ROLE_RUN_DIR === runDirectory) delete process.env.AK_ROLE_RUN_DIR;
  // #685 / #612: creating seam owns create→use→cleanup; worktree temp roots must not linger.
  const ledger = activeLedgers.get(runDirectory);
  if (ledger) {
    activeLedgers.delete(runDirectory);
    ledger.dispose();
  }
}
async function withInstitutionalRunDir<T>(
  seats: Record<string, SeatSelection | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const runDirectory = installInstitutionalRunDir(seats);
  try {
    return await run();
  } finally {
    disposeInstitutionalRunDir(runDirectory);
  }
}
// Parent agent process may inject AK_ROLE_RUN_DIR; isolate this file from that binding.
const ambientRunDirAtLoad = process.env.AK_ROLE_RUN_DIR;
delete process.env.AK_ROLE_RUN_DIR;
after(() => {
  if (ambientRunDirAtLoad === undefined) delete process.env.AK_ROLE_RUN_DIR;
  else process.env.AK_ROLE_RUN_DIR = ambientRunDirAtLoad;
});
afterEach(async () => {
  // Snapshot then independent cleanups: one run-dir dispose must not skip others
  // or provider teardowns, and cleanup failure must not erase a prior primary.
  // Provider teardown is async (mock.close()) — awaited, never discarded (#685 C4).
  const runDirs = [...activeLedgers.keys()];
  // Reverse-order teardown of institutional provider fixtures so PI_CODING_AGENT_DIR
  // is restored to its original value after nested registrations.
  const providerCleanups: Array<() => Promise<void>> = [];
  while (institutionalProviderCleanups.length > 0) {
    providerCleanups.push(institutionalProviderCleanups.pop()!);
  }
  await withPrimaryAwareCleanup(
    async () => {
      // Drop any leftover env binding between tests (owned dirs already popped above).
      delete process.env.AK_ROLE_RUN_DIR;
    },
    ...runDirs.map(
      (runDirectory) => async () => {
        disposeInstitutionalRunDir(runDirectory);
      },
    ),
    ...providerCleanups,
  );
});

// The child institutional session (openPiInProcessSession) builds its OWN child
// ModelRuntime that reads <PI_CODING_AGENT_DIR>/models.json — the parent ExtensionContext's
// modelRegistry is no longer consulted (#518). So every harness that drives a gatekeeper /
// officer child must register the faux provider in the ambient models.json and serve it over
// a real OpenAI-completions HTTP round-trip. This mirrors withInstitutionalProviderFixture
// from the shared harness (gatekeeper-real-entry / auditor-lifecycle), but registers
// synchronously-per-harness and tears down in afterEach so tool.execute call sites stay
// structurally unchanged.
const institutionalProviderCleanups: Array<() => Promise<void>> = [];

function gateModelDefinition(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

async function registerInstitutionalProviderFixture(
  faux: ReturnType<typeof fauxProvider>,
  extraProviders: ReadonlyArray<{ provider: string; id: string }> = [],
  observers: { onModel?: (modelId: string, body: Record<string, unknown>) => void } = {},
): Promise<void> {
  const mock = await createMockProviderServer(faux, observers);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempAgentDir = mkdtempSync(join(tmpdir(), "ak-judge-provider-"));
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  const providers: Record<string, unknown> = {
    [faux.provider.id]: {
      baseUrl: mock.baseUrl,
      api: "openai-completions",
      apiKey: "test-key",
      models: [gateModelDefinition(faux.getModel().id)],
    },
  };
  for (const entry of extraProviders) {
    if (providers[entry.provider] === undefined) {
      providers[entry.provider] = {
        baseUrl: mock.baseUrl,
        api: "openai-completions",
        apiKey: "test-key",
        models: [],
      };
    }
    (providers[entry.provider] as { models: unknown[] }).models.push(gateModelDefinition(entry.id));
  }
  writeFileSync(join(tempAgentDir, "models.json"), JSON.stringify({ providers }, null, 2), "utf8");
  institutionalProviderCleanups.push(async () => {
    await mock.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    // Owner 2026-09-05: leave temp agent dir under tmpdir for OS cleanup.
  });
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: any;
  execute: (...args: any[]) => Promise<any>;
};

const emptyFixPacket = "Repair the assigned findings.";
const declaredFixPrerequisites = JSON.stringify([{ id: "owner.choice", requirement: "Owner selects the contract." }]);

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

function extensionHarness(
  role: string | undefined,
  extraFlags: Readonly<Record<string, string>> = {},
  registeredToolNames: readonly string[] = [],
) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const flags = new Map<string, unknown>();
  const allToolNames = new Set(registeredToolNames);
  const activeToolSets: string[][] = [];
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.set(name, options);
    },
    getFlag(name: string) {
      if (name === "ak-role") return role;
      return extraFlags[name];
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
      allToolNames.add(tool.name);
    },
    getAllTools() {
      return [...allToolNames].map((name) => ({ name }));
    },
    getActiveTools() {
      return activeToolSets.at(-1) ?? [];
    },
    setActiveTools(names: string[]) {
      activeToolSets.push([...names]);
    },
    /** Production seam: shared lifecycle persists principal via pi.appendEntry. */
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
  };
  return { pi, handlers, tools, flags, activeToolSets, appendedEntries };
}

function testHostActions(): HostGatekeeperActions {
  return {
    failInfrastructure(error): never { throw error instanceof Error ? error : new Error(String(error)); },
    bindSubmissionNonPass() {},
  };
}

/** Test install: adapter + gate summon arm + shared envelope (no production duck-type). */
function installRoleRuntime(
  harnessPi: unknown,
  deps: Parameters<typeof createRoleRuntimeExtension>[0],
  options: { transcriptFromContext?: (ctx: ExtensionContext) => string } = {},
): PiRoleHostAdapter {
  const adapter = createPiRoleHostAdapter(harnessPi as ExtensionAPI, options);
  createRoleRuntimeExtension(deps)(adapter);
  return adapter;
}

function toolCallContext(
  calls: Array<{ id: string; name?: string; arguments?: JsonObject }>,
  abort: () => void = () => {},
): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  const runDir = [...activeLedgers.keys()].pop();
  if (runDir !== undefined) {
    (sessionManager as any).getSessionFile = () => join(runDir, "session", "session.jsonl");
  }
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name ?? JUDGE_OUTPUT_TOOL_NAME,
      arguments: call.arguments ?? {},
    })),
    api: "openai-responses",
    provider: "test",
    model: "judge",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  sessionManager.appendMessage(message);
  return { sessionManager, abort } as unknown as ExtensionContext;
}

async function withPassingGatekeeper(context: ExtensionContext): Promise<ExtensionContext> {
  const faux = fauxProvider({ provider: "passing-gatekeeper", api: "passing-gatekeeper" });
  const model = faux.getModel();
  // Reuse only a run dir this file installed (sole-final bounce→accept cycle).
  // Never reuse ambient AK_ROLE_RUN_DIR from a parent agent process — that seals under a foreign run.
  const existingRun = process.env.AK_ROLE_RUN_DIR;
  const ownedExisting =
    typeof existingRun === "string" &&
    existingRun.length > 0 &&
    activeLedgers.has(existingRun)
      ? existingRun
      : undefined;
  const runDirectory =
    ownedExisting ?? installInstitutionalRunDir(parentInheritedSeats(model));
  if (ownedExisting !== undefined) {
  }
  if (context.sessionManager !== undefined) {
    (context.sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
  }
  return Object.assign(context, {
    cwd: process.cwd(), model,
    modelRegistry: scriptedGatekeeperModelRegistry(model, faux.provider),
    thinkingLevel: "off",
  });
}

function activationCtx(home: string, extras: Record<string, unknown> = {}): ExtensionContext {
  // Durable session principal under the machine ledger book (ADR 0048).
  // Default mode stays undefined so failInfrastructure does not stamp process.exitCode unless a test opts in.
  const sessionDir = join(home, ".ak-roles", "books", basename(home), "runs", "judge-role", "session");
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(home, sessionDir);
  return {
    abort: () => {},
    ...extras,
    cwd: home,
    sessionManager,
  } as unknown as ExtensionContext;
}

async function startJudge(
  transcriptFromContext: (ctx: ExtensionContext) => string = () =>
    "review evidence and adjudication",
) {
  return withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    const harness = extensionHarness("judge");
    installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
      loadRoleSoul: async () => "JUDGE LAW\nApply the law.",
    }, { transcriptFromContext });
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    return { harness, tool };
  });
}

test("stable factory stays inert without a role", async () => {
  let loads = 0;
  const harness = extensionHarness(undefined);
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => { loads += 1; return role; },
  });

  assert.deepEqual(new Set(harness.handlers.keys()), new Set([
    "input",
    "before_agent_start",
    "session_start",
    "tool_result",
    "turn_end",
    "agent_end",
    "agent_settled",
    "session_shutdown",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "after_provider_response",
  ]));
  await harness.handlers.get("session_start")?.({}, {});
  assert.equal(loads, 0);
  assert.deepEqual([...harness.tools], []);
  assert.deepEqual(harness.activeToolSets, []);
  // Observation handlers are registered but stay inert without --ak-role admission.
  assert.equal(harness.handlers.has("tool_call"), false, "tool_call");
});

test("after_provider_response production handler writes typed 429 into resumable failure Terminal", async () => {
  // Shortest tracer: production handler → durable observation → public failure settlement → resume.
  // Does not call recordTypedProviderHttpStatus as a stand-in for the observation seam.
  await withActivationHome({ prefix: "ak-typed-429-obs-" }, async ({ home }) => {
    const runId = "run-prod-obs-429";
    const runDirectory = join(home, ".ak-roles", "books", basename(home), "runs", `${runId}@judge`);
    const sessionDirectory = join(runDirectory, "session");
    mkdirSync(sessionDirectory, { recursive: true });
    const admittedRequestPath = join(runDirectory, "admitted-request.json");
    await writeFile(admittedRequestPath, "{}\n", "utf8");

    const harness = extensionHarness(undefined);
    installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
      loadRoleSoul: async () => "judge",
    });

    const handler = harness.handlers.get("after_provider_response");
    assert.ok(handler, "production after_provider_response handler must be registered");

    // Without AK_ROLE_RUN_DIR the handler is inert.
    await handler(
      { type: "after_provider_response", status: 429, headers: {} },
      { model: { provider: "openai-codex" } },
    );
    assert.equal(await readTypedHttp429Observation(runDirectory), undefined);

    const previous = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = runDirectory;
    try {
      // Non-v1 provider ignored.
      await handler(
        { type: "after_provider_response", status: 429, headers: {} },
        { model: { provider: "anthropic" } },
      );
      assert.equal(await readTypedHttp429Observation(runDirectory), undefined);

      // Production typed 429 observation.
      await handler(
        { type: "after_provider_response", status: 429, headers: {} },
        { model: { provider: "openai-codex" } },
      );
      assert.deepEqual(await readTypedHttp429Observation(runDirectory), {
        httpStatus: 429,
        provider: "openai-codex",
      });

      // Later non-429 in the same attempt supersedes — latest is authoritative.
      await handler(
        { type: "after_provider_response", status: 500, headers: {} },
        { model: { provider: "openai-codex" } },
      );
      assert.equal(await readTypedHttp429Observation(runDirectory), undefined);

      // Final qualifying 429 re-arms resume observation for this attempt.
      await handler(
        { type: "after_provider_response", status: 429, headers: {} },
        { model: { provider: "openai-codex" } },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AK_ROLE_RUN_DIR;
      } else {
        process.env.AK_ROLE_RUN_DIR = previous;
      }
    }

    assert.deepEqual(await readTypedHttp429Observation(runDirectory), {
      httpStatus: 429,
      provider: "openai-codex",
    });

    const terminal = await settleJudgeFailureTerminalResult(
      {
        role: "judge",
        runId,
        bookKey: basename(home),
        projectRoot: home,
        instruction: "observe",
        instructionEmpty: false,
        attachments: [],
        runDirectory,
        principal: { sessionDirectory, sessionFile: join(sessionDirectory, "session.jsonl") },
        admittedRequestPath,
      } as any,
      { cause: "provider", diagnostic: "upstream declined this request" },
      piDurablePrincipalAuthority,
      { resume: { command: renderResumeCommand(runId) } },
    );

    assert.ok(terminal.resume);
    assert.equal(terminal.resume.command, renderResumeCommand(runId));
    assert.equal(terminal.runId, undefined);
    assert.equal(terminal.artifacts.length, 0);
    const outside = {
      roleOutcome: terminal.roleOutcome,
      navigator: terminal.navigator,
      artifacts: terminal.artifacts,
      runId: terminal.runId,
    };
    assert.equal(
      JSON.stringify(outside).includes(runId),
      false,
      "run ID must not appear outside resume.command in typed Terminal regions",
    );
    const presented = formatTerminalResult(terminal);
    assert.equal(presented.includes(terminal.resume.command), true);
    assert.equal(
      presented.split(terminal.resume.command).join("").includes(runId),
      false,
    );
  });
});

test("#959 navigator agent_end prose exit seals without typed delivery prompt", async () => {
  // Production agent_end handler is the real entry: prose → sealed; empty → no_receipt;
  // never ak-receipt-delivery-request / typed 催交 for navigator.
  await withActivationHome({ prefix: "ak-navigator-prose-exit-" }, async ({ home }) => {
    const runId = "run-nav-prose-exit";
    const runDirectory = join(home, ".ak-roles", "books", basename(home), "runs", `${runId}@navigator`);
    const sessionDirectory = join(runDirectory, "session");
    mkdirSync(sessionDirectory, { recursive: true });

    const sentMessages: Array<{ customType: string; content: string }> = [];
    const harness = extensionHarness("navigator");
    (harness.pi as { sendMessage?: (message: { customType: string; content: string }) => void }).sendMessage = (message) => {
      sentMessages.push({ customType: message.customType, content: message.content });
    };
    installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
      loadRoleSoul: async (role) => role === "navigator" ? "route judgment" : "judge",
    });

    const previous = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = runDirectory;
    try {
      // Session principal under this run so seal/ledger home resolve from sessionParent.
      const sessionManager = SessionManager.create(home, sessionDirectory);
      const ctx = {
        abort: () => {},
        cwd: home,
        sessionManager,
      } as unknown as ExtensionContext;
      await harness.handlers.get("session_start")?.({}, ctx);
      assert.ok(harness.tools.has(NAVIGATOR_OUTPUT_TOOL_NAME), "navigator tool registers on admission");

      const agentEnd = harness.handlers.get("agent_end");
      assert.ok(agentEnd, "production agent_end handler must be registered");

      // 1) Prose-only assistant message → sealed via navigator-prose-exit, no typed 催交.
      await agentEnd(
        {
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: "下一步送 reviewer 独立审阅" }],
            stopReason: "stop",
          }],
        },
        ctx,
      );
      const rows = await readRecordedSubmissionRows(home, runId, {
        home,
        sessionParent: join(sessionDirectory, "session.jsonl"),
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, "accepted");
      assert.equal(rows[0]?.role, "navigator");
      assert.deepEqual(rows[0]?.accepted, { prose: "下一步送 reviewer 独立审阅" });
      assert.equal(
        typeof rows[0]?.toolCallId === "string" && rows[0]!.toolCallId!.trim() !== "",
        true,
        "prose exit must seal with a non-empty toolCallId",
      );
      assert.equal(
        harness.appendedEntries.some((entry) => entry.customType === "ak-receipt-delivery-request"),
        false,
        "navigator prose exit must not queue typed delivery request",
      );
      assert.equal(sentMessages.length, 0, "navigator prose exit must not send typed 催交");
      // Closure rides sessionManager.appendCustomEntry (ledger projectClosure), not envelope appendEntry.
      const sessionEntries = sessionManager.getEntries?.() ?? [];
      assert.ok(
        sessionEntries.some(
          (entry: { type?: string; customType?: string }) =>
            entry.type === "custom" && entry.customType === "ak-role-submission-closure",
        ),
        "prose exit must project submission closure onto the session",
      );

      // Fresh turn: no prose and no tool → no_receipt, still no typed 催交.
      await harness.handlers.get("session_start")?.({}, ctx);
      sentMessages.length = 0;
      harness.appendedEntries.length = 0;
      await agentEnd(
        {
          messages: [{
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
            stopReason: "toolUse",
          }],
        },
        ctx,
      );
      assert.ok(
        harness.appendedEntries.some((entry) => entry.customType === NO_RECEIPT_LIFECYCLE_ENTRY_TYPE),
        "navigator with neither tool receipt nor prose must record no_receipt",
      );
      assert.equal(
        harness.appendedEntries.some((entry) => entry.customType === "ak-receipt-delivery-request"),
        false,
      );
      assert.equal(sentMessages.length, 0);
    } finally {
      if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previous;
    }
  });
});

test("unsupported role fails with the frozen diagnostic before any loader runs", async () => {
  let loads = 0;
  const harness = extensionHarness("router");
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => { loads += 1; return role; },
  });

  await assert.rejects(
    Promise.resolve(harness.handlers.get("session_start")?.({}, { abort() {} })),
    new Error("Unsupported workflow role: router"),
  );
  assert.equal(loads, 0);
  assert.deepEqual([...harness.tools], []);
});

test("focused Judge controller registers output without narrowing host tools", async () => {
  const harness = extensionHarness(undefined, {}, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    "edit",
    "arbitrary_sibling",
  ]);
  const runtime = createJudgeRoleRuntime(
    createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI).host,
    {
      loadSoul: async () => "  JUDGE LAW  ",
    },
  );

  await runtime.activate();

  assert.deepEqual([...harness.tools.keys()], [JUDGE_OUTPUT_TOOL_NAME]);
  assert.deepEqual(harness.activeToolSets, []);
  assert.equal(
    (await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {},
    ) as { systemPrompt: string }).systemPrompt,
    "BASE\n\n<judge_soul>\nJUDGE LAW\n</judge_soul>",
  );
});

test("focused Fixer and Coder controllers own their flags, lifecycle hooks, and prompt envelopes", async () => {
  const fixer = extensionHarness(undefined, {
    "ak-fix-packet": "/packet.md",
    "ak-fixer-prerequisites": "/prereqs.json",
    "ak-fixer-phase": "plan",
  });
  const fixerAdapterHost = createPiRoleHostAdapter(fixer.pi as unknown as ExtensionAPI).host;
  const fixerRoleEvents = new Set<string>();
  const fixerHost = new Proxy(fixerAdapterHost, {
    get(target, property, receiver) {
      if (property !== "on") return Reflect.get(target, property, receiver);
      return (event: string, handler: unknown) => {
        fixerRoleEvents.add(event);
        return (target.on as (event: string, handler: unknown) => void)(event, handler);
      };
    },
  });
  const fixerRuntime = createFixerRoleRuntime(
    fixerHost,
    {
      loadSoul: async () => "\n FIXER LAW \n",
      loadPacket: async (path) =>
        path.endsWith("prereqs.json")
          ? JSON.stringify([{ id: "owner.choice", requirement: "choose" }])
          : emptyFixPacket,
    },
    testHostActions(),
  );
  assert.deepEqual(new Set(fixer.flags.keys()), new Set(["ak-fix-packet", "ak-fixer-prerequisites", "ak-fixer-phase"]));
  await fixerRuntime.activate();
  assert.deepEqual([...fixer.tools.keys()], [FIXER_OUTPUT_TOOL_NAME]);
  assert.ok(fixer.handlers.has("before_agent_start"));
  assert.equal(fixerRoleEvents.has("input"), false);
  assert.equal(fixer.handlers.has("input"), true);
  const fixerPrompt = (await fixer.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE" },
    {},
  ) as { systemPrompt: string }).systemPrompt;
  assert.equal(
    fixerPrompt,
    `BASE\n\n<fixer_soul>\nFIXER LAW\n</fixer_soul>\n\n<fixer_phase>\nplan\n</fixer_phase>\n\n<fix_packet_path>\n/packet.md\n</fix_packet_path>\n\n<fixer_prerequisites_path>\n/prereqs.json\n</fixer_prerequisites_path>`,
  );
  assert.equal(fixerPrompt.includes(emptyFixPacket), false);
  assert.equal(fixerPrompt.includes("owner.choice"), false);
  const fixerTool = fixer.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(fixerTool);
  assert.deepEqual(
    (await fixerTool.execute(
      "plan-call",
      { status: "planned", report: "Plan the smallest repair." },
      undefined,
      undefined,
      await withPassingGatekeeper(toolCallContext([{ id: "plan-call", name: FIXER_OUTPUT_TOOL_NAME }])),
    )).details,
    { status: "planned", report: "Plan the smallest repair." },
  );
  const coder = extensionHarness(undefined, {
    "ak-coder-task": "/task.md",
    "ak-coder-phase": "plan",
  });
  const coderRuntime = createCoderRoleRuntime(
    createPiRoleHostAdapter(coder.pi as unknown as ExtensionAPI).host,
    {
      loadSoul: async () => "\n CODER LAW \n",
      loadTask: async () => "\n TASK BODY \n",
    },
    testHostActions(),
  );
  assert.deepEqual(new Set(coder.flags.keys()), new Set(["ak-coder-task", "ak-coder-phase"]));
  await coderRuntime.activate();
  assert.deepEqual([...coder.tools.keys()], [CODER_OUTPUT_TOOL_NAME]);
  assert.ok(coder.handlers.has("before_agent_start"));
  assert.ok(coder.handlers.has("input"));
  assert.equal(
    (await coder.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {},
    ) as { systemPrompt: string }).systemPrompt,
    "BASE\n\n<coder_soul>\nCODER LAW\n</coder_soul>\n\n<coder_phase>\nplan\n</coder_phase>\n\n<coder_task>\nTASK BODY\n</coder_task>",
  );
});

test("named Judge and worker tools preserve schema leaves and receipts", async () => {
  const fixtures = [
    {
      role: "judge" as const,
      name: JUDGE_OUTPUT_TOOL_NAME,
      activate: async () => {
        const harness = extensionHarness(undefined);
        const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
        const runtime = createJudgeRoleRuntime(
          piHostAdapter.host,
          {
            loadSoul: async () => "judge",
          },
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "converged", evidence: { checks: [{ name: "receipt", passed: true }] } },
    },
    {
      role: "fixer" as const,
      name: FIXER_OUTPUT_TOOL_NAME,
      activate: async () => {
        const harness = extensionHarness(undefined, {
          "ak-fix-packet": "/packet",
          "ak-fixer-phase": "apply",
        });
        const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
        const runtime = createFixerRoleRuntime(
          piHostAdapter.host,
          {
            loadSoul: async () => "fixer",
            loadPacket: async () => emptyFixPacket,
          },
          testHostActions(),
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "completed", report: "done", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] },
    },
    {
      role: "coder" as const,
      name: CODER_OUTPUT_TOOL_NAME,
      activate: async () => {
        const harness = extensionHarness(undefined, {
          "ak-coder-task": "/task",
          "ak-coder-phase": "plan",
        });
        const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
        const runtime = createCoderRoleRuntime(
          piHostAdapter.host,
          {
            loadSoul: async () => "coder",
            loadTask: async () => "task",
          },
          testHostActions(),
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "planned", report: "plan" },
    },
  ];

  for (const fixture of fixtures) {
    const harness = await fixture.activate();
    assert.deepEqual([...harness.tools.keys()], [fixture.name]);
    const tool = harness.tools.get(fixture.name);
    assert.ok(tool);
    assert.equal(tool.name, fixture.name);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    assert.ok(
      tool.promptGuidelines === undefined || tool.promptGuidelines.length === 0,
      `${fixture.name} must not carry promptGuidelines instruction family`,
    );
    const result = await tool.execute(
      "receipt",
      fixture.output,
      undefined,
      undefined,
      await withPassingGatekeeper(toolCallContext([{ id: "receipt", name: fixture.name }])),
    );
    assert.deepEqual(result.details, fixture.output);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.content, [], "the submission tool finishes before reviewer receipts exist");
    // #756: judge no longer projects auditor usage onto the parent receipt —
    // nested officer meters live on the officer session; parent accepts as-is.
    assert.equal(result.usage, undefined);
    const unreadable = { status: { value: "unknown" }, report: { unvalidated: true } };
    const raw = await tool.execute(
      "unreadable-status",
      unreadable,
      undefined,
      undefined,
      await withPassingGatekeeper(toolCallContext([{ id: "unreadable-status", name: fixture.name }])),
    );
    assert.equal(raw.terminate, true, `${fixture.role} finishes an unreadable-status submission`);
    assert.deepEqual(raw.details, unreadable, `${fixture.role} preserves the raw submission`);
  }
});

test("production audit transcript preserves the assignment received by the judge", () => {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT: adjudicate issue 205",
    timestamp: Date.now(),
  });

  const transcript = productionTranscriptFromContext({
    sessionManager,
  } as unknown as ExtensionContext);

  assert.match(transcript, /OWNER ASSIGNMENT: adjudicate issue 205/);
});

test("judge role injects its soul and accepts a soul-compliant verdict", async () => {
  const { harness, tool } = await startJudge();

  assert.ok(harness.flags.has("ak-role"));
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );
  assert.match((promptResult as { systemPrompt: string }).systemPrompt, /JUDGE LAW/);

  const verdict: JudgeVerdict = { status: "converged" };
  // withPassingGatekeeper: notary (judge_draft) + auditor (judge_compliance) both pass.
  const context = await withPassingGatekeeper(toolCallContext([{ id: "call-1", arguments: verdict as unknown as JsonObject }]));
  const { sealed, pending } = await acceptThroughTypedRoundClosure({
    handlers: harness.handlers,
    tool,
    toolCallId: "call-1",
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: verdict,
    context,
  });

  assert.equal(pending.terminate, true); // #836: original terminate flag preserved
  assert.deepEqual(sealed.accepted, verdict);
});

test("judge escalate skips Notary and Auditor gates and accepts as-is (#756)", async () => {
  // Direct role runtime (no submission-ledger wrap) so terminate stays on the face.
  const harness = extensionHarness("judge");
  const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
  await createJudgeRoleRuntime(
    piHostAdapter.host,
    { loadSoul: async () => "JUDGE LAW" },
  ).activate();
  const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME)!;
  const escalate = {
    status: "escalate" as const,
    decisionGate: { question: "which authority?", options: ["A", "B"] },
    note: "need owner",
  };
  const result = await tool.execute(
    "call-esc",
    escalate,
    undefined,
    undefined,
    toolCallContext([{ id: "call-esc", arguments: escalate }]),
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, escalate);
});

test("judge output tool returns an unreadable status for public routing (#756/#1057)", async () => {
  // Direct role runtime (no submission-ledger wrap) so terminate stays on the face.
  const harness = extensionHarness("judge");
  const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
  await createJudgeRoleRuntime(
    piHostAdapter.host,
    { loadSoul: async () => "JUDGE LAW" },
  ).activate();
  const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME)!;
  const unreadable = { status: "not-a-status", note: "typo" };
  const result = await tool.execute(
    "call-bad",
    unreadable,
    undefined,
    undefined,
    await withPassingGatekeeper(toolCallContext([{ id: "call-bad", arguments: unreadable }])),
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, unreadable);
});

test("judge role fails before adjudication when its soul is empty", async () => {
  const harness = extensionHarness("judge");
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async () => "   \n",
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await assert.rejects(
      Promise.resolve(harness.handlers.get("session_start")?.({}, activationCtx(home))),
    );
  });
  assert.equal(harness.tools.has(JUDGE_OUTPUT_TOOL_NAME), false);
});

test("coder plan loads its task without construction skill and returns planned", async () => {
  const loadedTasks: string[] = [];
  const harness = extensionHarness("coder", {
    "ak-coder-task": "/materials/task.md",
    "ak-coder-phase": "plan",
  });
  installRoleRuntime(harness.pi, {
    loadRoleSoul: async (role) => role === "coder" ? "CODER LAW" : "JUDGE LAW",
    loadCoderTask: async (path) => {
      loadedTasks.push(path);
      return "IMPLEMENT THE VERTICAL SLICE";
    },
  });

  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE" },
    {},
  );
  const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
  assert.deepEqual(loadedTasks, ["/materials/task.md"]);
  assert.deepEqual(
    await harness.handlers.get("input")?.(
      { text: "Plan the approved seam.", source: "interactive" },
      {},
    ),
    { action: "continue" },
  );
  assert.equal(
    prompt,
    "BASE\n\n<coder_soul>\nCODER LAW\n</coder_soul>\n\n<coder_phase>\nplan\n</coder_phase>\n\n<coder_task>\nIMPLEMENT THE VERTICAL SLICE\n</coder_task>",
  );

  const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const output = { status: "planned", report: "Plan the public seam first." };
  const context = await withPassingGatekeeper(toolCallContext([{ id: "coder", name: CODER_OUTPUT_TOOL_NAME }]));
  const { sealed, pending } = await acceptThroughTypedRoundClosure({
    handlers: harness.handlers,
    tool,
    toolCallId: "coder",
    toolName: CODER_OUTPUT_TOOL_NAME,
    output,
    context,
  });
  assert.deepEqual(sealed.accepted, output);
  assert.equal(pending.terminate, true); // #836: original terminate flag preserved
});

test("coder apply unfinished without reason bounces then accepts reasoned resubmit; max two bounces then accept", async () => {
  const harness = extensionHarness("coder", {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => role === "coder" ? "CODER LAW" : "JUDGE LAW",
    loadCoderTask: async () => "APPROVED IMPLEMENTATION PLAN",
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const bare = {
    status: "unfinished" as const,
    report: "The first implementation is not fully settled.",
    remainingScope: "the unimplemented adapter branch",
  };
  const reasoned = {
    ...bare,
    reason: "prerequisite_missing: owner has not answered which adapter branch is in scope",
  };
  let bounceGatekeeperProviderRequests = 0;
  const bounceContext = (id: string) => Object.assign(
    toolCallContext([{ id, name: CODER_OUTPUT_TOOL_NAME }]),
    { cwd: process.cwd(), modelRegistry: { getProvider() { bounceGatekeeperProviderRequests += 1; } } },
  );
  const seatModel = fauxProvider({ provider: "unfinished-seats", api: "unfinished-seats" }).getModel();
  // Positive: no reason → bounce → same-run reasoned resubmit accepted through Gatekeeper.
  await withInstitutionalRunDir(parentInheritedSeats(seatModel), async () => {
    await assert.rejects(
      tool.execute("unfinished-bare", bare, undefined, undefined, bounceContext("unfinished-bare")),
      (error: unknown) =>
        error instanceof WorkerUnfinishedReasonReminderError &&
        error.code === "worker_unfinished_reason_reminder",
    );
    assert.equal(bounceGatekeeperProviderRequests, 0);
    const context = await withPassingGatekeeper(toolCallContext([{ id: "unfinished-reasoned", name: CODER_OUTPUT_TOOL_NAME }]));
    const { sealed } = await acceptThroughTypedRoundClosure({
      handlers: harness.handlers,
      tool,
      toolCallId: "unfinished-reasoned",
      toolName: CODER_OUTPUT_TOOL_NAME,
      output: reasoned,
      context,
    });
    assert.deepEqual(sealed.accepted, reasoned);
  });
  // Negative: continuous bare resubmits bounce at most twice, then accept through Gatekeeper (no loop).
  // Fresh admitted run — prior seal must not cross run boundaries.
  const harness2 = extensionHarness("coder", {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  installRoleRuntime(harness2.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => role === "coder" ? "CODER LAW" : "JUDGE LAW",
    loadCoderTask: async () => "APPROVED IMPLEMENTATION PLAN",
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness2.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const tool2 = harness2.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool2);
  bounceGatekeeperProviderRequests = 0;
  await withInstitutionalRunDir(parentInheritedSeats(seatModel), async () => {
    await assert.rejects(
      tool2.execute("u1", bare, undefined, undefined, bounceContext("u1")),
      (error: unknown) => error instanceof WorkerUnfinishedReasonReminderError,
    );
    await assert.rejects(
      tool2.execute("u2", bare, undefined, undefined, bounceContext("u2")),
      (error: unknown) => error instanceof WorkerUnfinishedReasonReminderError,
    );
    assert.equal(bounceGatekeeperProviderRequests, 0);
    const context2 = await withPassingGatekeeper(toolCallContext([{ id: "u3", name: CODER_OUTPUT_TOOL_NAME }]));
    const { sealed } = await acceptThroughTypedRoundClosure({
      handlers: harness2.handlers,
      tool: tool2,
      toolCallId: "u3",
      toolName: CODER_OUTPUT_TOOL_NAME,
      output: bare,
      context: context2,
    });
    assert.deepEqual(sealed.accepted, bare);
  });
});

test("Fixer activation rejects malformed prerequisites and blank instructions before installing its tool", async () => {
  const rows = [
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" }, packet: "{" }, { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" }, packet: JSON.stringify([{ id: "bad/id", requirement: "x" }]) },
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-phase": "apply" }, packet: "" },
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-phase": "apply" }, packet: " \t\n" },
  ] as const;
  for (const row of rows) {
    const harness = extensionHarness("fixer", row.flags);
    installRoleRuntime(harness.pi, {
      loadRoleSoul: async (role) => role,
      loadFixPacket: async () => row.packet,
    });
    await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
      await assert.rejects(
        Promise.resolve(harness.handlers.get("session_start")?.({}, activationCtx(home))),
        (error: unknown) => error instanceof FixerPacketValidationError,
      );
    });
    assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), false);
    assert.equal(harness.handlers.has("before_agent_start"), true);
  }
});

test("undeclared prerequisite ids are recorded as-is; declared references still pass Gatekeeper", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => role, loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n"
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
    const seatModel = fauxProvider({ provider: "prereq-seats", api: "prereq-seats" }).getModel();
    const candidate = (prerequisiteId: string) => ({ status: "refused" as const, report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused" as const, remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId, evidence: "Choice absent." } }] });
    // #836 删 9 / 2.12: packet binding is not a code reject. Record the payload as-is.
    await withInstitutionalRunDir(parentInheritedSeats(seatModel), async () => {
      const context = await withPassingGatekeeper(toolCallContext([{ id: "undeclared", name: FIXER_OUTPUT_TOOL_NAME }]));
      const { sealed } = await acceptThroughTypedRoundClosure({
        handlers: harness.handlers,
        tool,
        toolCallId: "undeclared",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        output: candidate("other"),
        context,
      });
      assert.deepEqual(sealed.accepted, candidate("other"));
    });
    await withInstitutionalRunDir(parentInheritedSeats(seatModel), async () => {
      const context = await withPassingGatekeeper(toolCallContext([{ id: "good", name: FIXER_OUTPUT_TOOL_NAME }]));
      const { sealed, pending } = await acceptThroughTypedRoundClosure({
        handlers: harness.handlers,
        tool,
        toolCallId: "good",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        output: candidate("owner.choice"),
        context,
      });
      assert.equal(pending.terminate, true); // #836: original terminate flag preserved
      assert.deepEqual(sealed.accepted, candidate("owner.choice"));
    });

    const partial = {
      status: "partially_completed" as const,
      report: "Mixed.",
      classResults: [
        { name: "Done", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
        { name: "Policy", disposition: "refused" as const, remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "owner.choice", evidence: "Choice absent." } },
      ],
    };
    await withInstitutionalRunDir(parentInheritedSeats(seatModel), async () => {
      await assert.rejects(
        tool.execute("partial", partial, undefined, undefined, Object.assign(toolCallContext([{ id: "partial", name: FIXER_OUTPUT_TOOL_NAME }]), { cwd: process.cwd() })),
        (error: unknown) =>
          error instanceof WorkerCommitReminderError &&
          error.code === "worker_commit_reminder",
      );
      const context2 = await withPassingGatekeeper(toolCallContext([{ id: "partial2", name: FIXER_OUTPUT_TOOL_NAME }]));
      const { sealed } = await acceptThroughTypedRoundClosure({
        handlers: harness.handlers,
        tool,
        toolCallId: "partial2",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        output: partial,
        context: context2,
      });
      assert.deepEqual(sealed.accepted, partial);
    });

    const sharedCommit = "shared-commit";
    const classA = { name: "Reviewer diagnostics", disposition: "completed" as const, searchScope: "reviewer admission and dispatch", exceptions: [], commitSha: sharedCommit };
    const classB = { name: "Fixer projection", disposition: "completed" as const, searchScope: "fixer output branches", exceptions: [], commitSha: sharedCommit };
    await withInstitutionalRunDir(parentInheritedSeats(seatModel), async () => {
      const output = { status: "completed" as const, report: "Both classes settled.", classResults: [classA, classB] };
      const context3 = await withPassingGatekeeper(toolCallContext([{ id: "shared", name: FIXER_OUTPUT_TOOL_NAME }]));
      const { sealed, pending } = await acceptThroughTypedRoundClosure({
        handlers: harness.handlers,
        tool,
        toolCallId: "shared",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        output,
        context: context3,
      });
      assert.equal(pending.terminate, true); // #836: original terminate flag preserved
      assert.deepEqual((sealed.accepted as { classResults?: unknown }).classResults, [classA, classB]);
    });
  });
});
test("declared plan refusal passes structure then Gatekeeper", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "plan" });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => role,
    loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n"
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
    const candidate = { status: "refused" as const, report: "Blocked.", remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "owner.choice", evidence: "Choice absent." } };
    const context = await withPassingGatekeeper(toolCallContext([{ id: "plan-refused", name: FIXER_OUTPUT_TOOL_NAME }]));
    const { sealed, pending } = await acceptThroughTypedRoundClosure({
      handlers: harness.handlers,
      tool,
      toolCallId: "plan-refused",
      toolName: FIXER_OUTPUT_TOOL_NAME,
      output: candidate,
      context,
    });
    assert.deepEqual(sealed.accepted, candidate);
    assert.equal(pending.terminate, true); // #836: original terminate flag preserved
  });
});
test("fixer role loads opaque instructions and returns a thin report envelope", async () => {
  const loadedPaths: string[] = [];
  const instructionBytes = "  REPAIR INSTRUCTIONS\nFix the live findings.\n\n";
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/materials/fix.md",
    "ak-fixer-phase": "apply",
  });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadRoleSoul: async (role) => role === "fixer" ? "FIXER LAW\nCreate one forward commit." : "JUDGE LAW",
    loadFixPacket: async (path) => {
      loadedPaths.push(path);
      return instructionBytes;
    },
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" }, {},
  );

  assert.deepEqual(loadedPaths, ["/materials/fix.md"]);
  const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
  assert.equal(
    prompt,
    `BASE SYSTEM PROMPT\n\n<fixer_soul>\nFIXER LAW\nCreate one forward commit.\n</fixer_soul>\n\n<fixer_phase>\napply\n</fixer_phase>\n\n<fix_packet_path>\n/materials/fix.md\n</fix_packet_path>`,
  );
  assert.equal(harness.tools.has(JUDGE_OUTPUT_TOOL_NAME), false);

  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const output = {
    status: "refused" as const,
    report: "The requested guard contradicts the authority.",
    classResults: [{ name: "Guard", disposition: "refused" as const, remainingScope: "requested guard", blocker: { cause: "authority_violation" as const, evidence: "contradicts controlling authority" } }],
  };
  const context = await withPassingGatekeeper(toolCallContext([
    { id: "fixer-call", name: FIXER_OUTPUT_TOOL_NAME },
  ]));
  const { sealed, pending } = await acceptThroughTypedRoundClosure({
    handlers: harness.handlers,
    tool,
    toolCallId: "fixer-call",
    toolName: FIXER_OUTPUT_TOOL_NAME,
    output,
    context,
  });
  assert.equal(pending.terminate, true); // #836: original terminate flag preserved
  assert.deepEqual(sealed.accepted, output);
});


test("fixer activation leaves its tool surface unchanged", async () => {
  const harness = extensionHarness(
    "fixer",
    {
      "ak-fix-packet": "/materials/fix.md",
      "ak-fixer-phase": "apply",
    },
    ["read", "bash", "write", "edit", "arbitrary_sibling"],
  );
  installRoleRuntime(harness.pi, {
    loadRoleSoul: async (role) => role === "fixer" ? "FIXER LAW" : "JUDGE LAW",
    loadFixPacket: async () => emptyFixPacket,
  });

  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  assert.deepEqual(harness.activeToolSets, []);
  assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), true);
});



// #420 整改移档（自 package-entrypoint-packaged-workers.integration.test.ts）：
// 纯进程内模块逻辑（Source-tree imports，无任何装包边界），性质属快档。
// Judge/doctor：bounce→errored / pass→terminate / escalate 全矩阵。
// Fixer (#242) / Reviewer (#495 S6)：无审刑院闸，typed validate 即受理。
