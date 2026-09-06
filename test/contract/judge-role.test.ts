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

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context, type Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { transcriptFromContext as productionTranscriptFromContext } from "../../extensions/role-runtime.ts";
import { isAuditEscalationResult } from "../../src/audit-escalation.ts";
import type { CanonicalSkillBinding } from "../../src/canonical-skill-binding.ts";
import { createPiJudgeAuditor, SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { createJudgeRoleRuntime } from "../../src/judge-role.ts";
import { createPiRoleHostAdapter, toPiContext, type PiRoleHostAdapter } from "../../src/pi/adapter.ts";
import type { HostContext, HostGatekeeperActions } from "../../src/host-contracts.ts";
import {
  NOTARY_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  GatekeeperDecisionError,
  MISSING_ARGUMENTS_SUBMISSION,
  runGatekeeper,
  type GateOfficerSummon,
} from "../../src/gatekeeper-role.ts";
import { stampShapeUnreadableDetails } from "../../src/shape-unreadable-failure.ts";
import type { AuditorSummon } from "../../src/compliance-transport.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import {
  createNavigatorAttendance,
  type NavigatorEvent,
  type NavigatorPreparationSession,
} from "../../src/navigator-attendance.ts";
import { NAVIGATOR_INVOCATION_ENTRY } from "../../src/navigator-invocation-identity.ts";
import {
  CODER_SKILL_EXPANSION_EVIDENCE_MISSING_CODE,
  CoderSkillExpansionEvidenceMissingError,
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
import { tryHomeFromAkRolesPath } from "../../src/activation-ledger-topology.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";

async function acceptThroughTypedRoundClosure(input: {
  handlers: Map<string, any>;
  tool: { execute: (...args: any[]) => Promise<any>; name?: string };
  toolCallId: string;
  toolName: string;
  output: unknown;
  context: any;
}): Promise<{ sealed: NonNullable<Awaited<ReturnType<typeof readSealedSubmission>>>; pending: any }> {
  const pending = await input.tool.execute(input.toolCallId, input.output, undefined, undefined, input.context);
  assert.deepEqual(pending.details, { submissionDisposition: "pending-round-closure" });
  assert.equal(pending.terminate, undefined);
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
  // #604: seal lands under the temp package home owning the run path — not real home.
  const ledgerHomeOwner = tryHomeFromAkRolesPath(runDirectory);
  assert.ok(ledgerHomeOwner, "institutional run must sit under temp .ak-roles topology");
  const sealed = await readSealedSubmission(cwd, runId, ledgerHomeOwner);
  assert.ok(sealed, "typed turn_end must seal sole candidate");
  return { sealed, pending };
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
const activeRunDirs: string[] = [];
function installInstitutionalRunDir(seats: Record<string, SeatSelection | undefined>): string {
  void seats; // seat page deleted (#675); argument retained for call-site shape only.
  // Publisher face is `<runId>@<role>` — sole runIdFromRunDirectory authority requires the @.
  // #604: nest under temp `.ak-roles` so session/ledger path-derive never hits real home.
  const runName = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@judge`;
  const ledger = createTempPackageHomeLedger({ prefix: "ak-judge-home-", runName });
  const runDirectory = ledger.runDirectory;
  activeRunDirs.push(runDirectory);
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  return runDirectory;
}
function disposeInstitutionalRunDir(runDirectory: string): void {
  const index = activeRunDirs.indexOf(runDirectory);
  if (index !== -1) activeRunDirs.splice(index, 1);
  if (process.env.AK_ROLE_RUN_DIR === runDirectory) delete process.env.AK_ROLE_RUN_DIR;
  // Owner 2026-09-05: leave hermetic home under tmpdir for OS cleanup (no directory delete).
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
  const runDirs: string[] = [];
  while (activeRunDirs.length > 0) {
    runDirs.push(activeRunDirs.pop()!);
  }
  // Reverse-order teardown of institutional provider fixtures so PI_CODING_AGENT_DIR
  // is restored to its original value after nested registrations.
  const providerCleanups: Array<() => Promise<void>> = [];
  while (institutionalProviderCleanups.length > 0) {
    providerCleanups.push(institutionalProviderCleanups.pop()!);
  }
  defaultGateSummon = undefined;
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

const tddPath = "/home/test/.agents/skills/tdd/SKILL.md";
const tddBaseDir = "/home/test/.agents/skills/tdd";
const tddBody = "# Canonical TDD\n\nRun red then green.";
const tddContent = `References are relative to ${tddBaseDir}.\n\n${tddBody}`;

function tddBinding(): CanonicalSkillBinding<"tdd"> {
  return {
    name: "tdd",
    snapshot: {
      raw: `---\nname: tdd\ndescription: test\n---\n\n${tddBody}`,
      path: tddPath,
      baseDir: tddBaseDir,
      body: tddBody,
      snapshotIdentity: Object.freeze({ text: `---\nname: tdd\ndescription: test\n---\n\n${tddBody}` }),
    },
    invocation(originalRequest) {
      return `/skill:tdd ${originalRequest}`;
    },
    captureExpansion(evidence, originalRequest) {
      return evidence?.name === "tdd"
        && evidence.location === tddPath
        && evidence.content === tddContent
        && evidence.userMessage === originalRequest
        ? { name: "tdd", location: tddPath, content: tddContent, userMessage: originalRequest }
        : undefined;
    },
  };
}

function expandedTdd(request: string): string {
  const block = `<skill name="tdd" location="${tddPath}">\n${tddContent}\n</skill>`;
  return request === "" ? block : `${block}\n\n${request}`;
}

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

/** Test host: infrastructure throws through; non-pass bind is a no-op unless a case wires tool_result. */
/** Offline gate summon for this file — threaded via hostActions, not globalThis. */
let defaultGateSummon: GateOfficerSummon | undefined;

/** Lazy gate summon for createPiRoleRuntimeExtension (resolves defaultGateSummon at call time). */
const extensionGateSummon: GateOfficerSummon = async (officer, sourceRunDirectory) => {
  if (defaultGateSummon === undefined) {
    throw new Error("test gate summon not armed");
  }
  return defaultGateSummon(officer, sourceRunDirectory);
};

function testHostActions(
  fail: (error: unknown) => never = (error): never => {
    throw error instanceof Error ? error : new Error(String(error));
  },
): HostGatekeeperActions {
  return {
    failInfrastructure(error) { fail(error); },
    bindSubmissionNonPass() {},
  };
}

/** Lowest seam: requireGatekeeperPass options.summonOfficer (no RoleRuntimeDependencies bridge). */
function testRequireGatekeeperPass(): NonNullable<import("../../src/host-contracts.ts").RoleHost["requireGatekeeperPass"]> {
  return async (options) => {
    const { requireGatekeeperPass } = await import("../../src/gatekeeper-pass-envelope.ts");
    await requireGatekeeperPass({
      context: options.context,
      subject: options.subject as import("../../src/gatekeeper-role.ts").GatekeeperSubject,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      hostActions: options.hostActions,
      toolCallId: options.toolCallId,
      ...(defaultGateSummon === undefined ? {} : { summonOfficer: extensionGateSummon }),
    });
  };
}

/** Patch RoleHost.requireGatekeeperPass to the lowest summonOfficer seam (test-only). */
function armGateSummonOnHost(host: import("../../src/host-contracts.ts").RoleHost): void {
  host.requireGatekeeperPass = testRequireGatekeeperPass();
}

/** Test install: adapter + gate summon arm + shared envelope (no production duck-type). */
function installRoleRuntime(
  harnessPi: unknown,
  deps: Parameters<typeof createRoleRuntimeExtension>[0],
  options: { transcriptFromContext?: (ctx: ExtensionContext) => string } = {},
): PiRoleHostAdapter {
  const adapter = createPiRoleHostAdapter(harnessPi as ExtensionAPI, options);
  armGateSummonOnHost(adapter.host);
  createRoleRuntimeExtension(deps)(adapter);
  return adapter;
}

function toolCallContext(
  calls: Array<{ id: string; name?: string; arguments?: Record<string, unknown> }>,
  abort: () => void = () => {},
): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  if (activeRunDirs.length > 0) {
    const runDir = activeRunDirs[activeRunDirs.length - 1];
    if (runDir !== undefined) {
      (sessionManager as any).getSessionFile = () => join(runDir, "session", "session.jsonl");
    }
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

function passingOfficerSummon(officer: "inspector" | "notary"): PublicSummonResult {
  return {
    exitCode: 0,
    terminal: {
      roleOutcome: {
        kind: "accepted",
        role: officer,
        status: "pass",
        decisiveFacts: { status: "pass", findings: [] },
      },
      navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
      artifacts: [],
      runId: "test-gate-pass",
    },
  };
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
    activeRunDirs.includes(existingRun)
      ? existingRun
      : undefined;
  const runDirectory =
    ownedExisting ?? installInstitutionalRunDir(parentInheritedSeats(model));
  if (ownedExisting !== undefined) {
  }
  if (context.sessionManager !== undefined) {
    (context.sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
  }
  // #675: offline gate path injects public-summon results (hostActions + deep-activation mirror).
  defaultGateSummon = async (officer) => passingOfficerSummon(officer);
  return Object.assign(context, {
    cwd: process.cwd(), model,
    modelRegistry: scriptedGatekeeperModelRegistry(model, faux.provider),
    thinkingLevel: "off",
  });
}

async function workerCompletionGatekeeperHarness(options: {
  execute: (id: string, output: unknown, context: ExtensionContext) => Promise<unknown>;
  toolName: string;
  output: unknown;
  officer?: "inspector" | "notary";
  officerUnusableSubmission?: Record<string, unknown>;
  passingRuns?: number;
}) {
  const {
    execute,
    toolName,
    output,
    officer = "inspector",
    officerUnusableSubmission = { status: "not-an-audit-verdict" } as Record<string, unknown>,
    passingRuns = 1,
  } = options;
  const faux = fauxProvider({ provider: "worker-gatekeeper", api: "worker-gatekeeper" });
  const model = faux.getModel();
  // #675: script public-summon terminals in order (transport → unusable → no_receipt → bounce → pass*).
  const queue: PublicSummonResult[] = [
    {
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: officer,
          cause: "provider",
          diagnostic: "Officer transport dropped",
          decisiveFacts: {},
        },
        navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
        artifacts: [],
        runId: "test-gate-transport",
      },
    },
    {
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: officer,
          cause: "output",
          diagnostic: "decision 无显式 pass/bounce/escalate",
          // Settlement marker only — consumers do not re-derive from cause=output (#675).
          decisiveFacts: stampShapeUnreadableDetails(officerUnusableSubmission),
        },
        navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
        artifacts: [],
        runId: "test-gate-unusable",
      },
    },
    {
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "no_receipt",
          role: officer,
          status: "no-accepted-receipt",
          terminalToolCalled: false,
          rejectedReceipts: [],
          deliveryTurns: 2,
          sessionCompletion: "settled-without-accepted-receipt",
          runPointer: "test",
          attemptPointer: "test",
          acceptedReceipt: false,
          decisiveFacts: {
            terminalToolCalled: false,
            rejectedReceipts: [],
            deliveryTurns: 2,
            sessionCompletion: "settled-without-accepted-receipt",
            runPointer: "test",
            attemptPointer: "test",
            acceptedReceipt: false,
          },
        },
        navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
        artifacts: [],
        runId: "test-gate-no-receipt",
      },
    },
    {
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: officer,
          status: "bounce",
          decisiveFacts: { status: "bounce", findings: ["add a focused regression"] },
        },
        navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
        artifacts: [],
        runId: "test-gate-bounce",
      },
    },
    ...Array.from({ length: passingRuns }, (_, i) => passingOfficerSummon(officer)),
  ];
  let callCount = 0;
  defaultGateSummon = async () => {
    const next = queue[callCount++];
    if (next === undefined) throw new Error("gate summon queue exhausted");
    return next;
  };
  return {
    context(id: string, toolName: string) {
      installInstitutionalRunDir(parentInheritedSeats(model));
      return Object.assign(toolCallContext([{ id, name: toolName }]), {
        cwd: process.cwd(), model,
        modelRegistry: scriptedGatekeeperModelRegistry(model, faux.provider),
        thinkingLevel: "off",
      });
    },
    async assertRejectSequence() {
      const reject = async (id: string, check: (error: Error) => void) => {
        await assert.rejects(execute(id, output, this.context(id, toolName)), (error: unknown) => {
          assert.ok(error instanceof Error);
          check(error);
          return true;
        });
      };
      // Real transport failure stays infrastructure (not GatekeeperDecisionError).
      await reject(`${officer}-transport`, (error) => assert.equal(error instanceof GatekeeperDecisionError, false));
      // Shape-unusable: projection retains submission (structured); submit path parent-stands
      // (ADR 0055 / #675) — not NonPass reject, not transport, not forged bounce.
      {
        const projectUnusable = async (id: string, candidate: unknown) =>
          await runGatekeeper({
            context: this.context(id, toolName),
            subject: officer === "inspector"
              ? { kind: "worker_completion" }
              : { kind: "judge_draft" },
            async summonOfficer() {
              return {
                exitCode: 1,
                terminal: {
                  roleOutcome: {
                    kind: "failure",
                    role: officer,
                    cause: "output",
                    diagnostic: "decision 无显式 pass/bounce/escalate",
                    decisiveFacts: stampShapeUnreadableDetails(candidate),
                  },
                  navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
                  artifacts: [],
                  runId: id,
                },
              } as PublicSummonResult;
            },
          });
        const projected = await projectUnusable(`${officer}-unusable-proj`, officerUnusableSubmission);
        assert.equal(projected.status, "unreadable");
        if (projected.status === "unreadable") {
          assert.equal(projected.officer, officer);
          assert.deepEqual(projected.submission, officerUnusableSubmission);
        }
        // Marker presence decides, not the candidate value: an omitted-arguments officer
        // call stays a stood-on unreadable decision whose retained submission is the
        // serializable missing-args fact — never an infrastructure rethrow (#675 T15).
        const omitted = await projectUnusable(`${officer}-unusable-omitted`, undefined);
        assert.equal(omitted.status, "unreadable");
        if (omitted.status === "unreadable") {
          assert.equal(omitted.officer, officer);
          assert.deepEqual(omitted.submission, MISSING_ARGUMENTS_SUBMISSION);
        }
      }
      // Consume queue unusable via submit path — parent stands (no GatekeeperDecisionError).
      const stood = await execute(
        `${officer}-unusable-release`,
        output,
        this.context(`${officer}-unusable-release`, toolName),
      ) as { terminate?: boolean; details?: unknown };
      assert.equal(stood instanceof GatekeeperDecisionError, false);
      // Worker terminates; judge may pending-round-closure — both are parent-stand faces.
      assert.ok(stood !== undefined && stood !== null);
      await reject(`${officer}-no-receipt`, (error) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.equal(error.result.status, "no_receipt");
        if (error.result.status === "no_receipt") {
          assert.equal(error.result.stage, officer);
          assert.equal(error.result.facts.acceptedReceipt, false);
          assert.equal(error.result.facts.sessionCompletion, "settled-without-accepted-receipt");
        }
      });
      await reject("bounce", (error) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.equal(error.result.status, "bounce");
        if (error.result.status === "bounce") {
          assert.equal(error.result.officer, officer);
          assert.equal(error.result.disposition, "rewrite");
          assert.deepEqual(error.result.findings, ["add a focused regression"]);
          assert.deepEqual(error.result.submission, {
            status: "bounce",
            findings: ["add a focused regression"],
          });
        }
      });
    },
    get providerRequests() { return callCount; },
    get remainingResponses() { return Math.max(0, queue.length - callCount); },
  };
}

function gateCatalogModel(provider: string, id: string) {
  return {
    api: "openai-responses" as const,
    provider,
    id,
    name: id,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

/**
 * Real submit-tool → requireGatekeeperPass → shared executor child model observation (#453).
 * Pass-only script; full non-pass matrix stays on workerCompletionGatekeeperHarness.
 */
async function realEntryGateModelHarness(options: {
  officer?: "inspector" | "notary";
  catalog?: ReadonlyArray<{ provider: string; id: string }>;
  authFailIds?: ReadonlySet<string>;
  /** Already-produced resolution page seats the consumer reads (B-lane). */
  seats?: Record<string, SeatSelection | undefined>;
}) {
  const officer = options.officer ?? "inspector";
  const officerTool = officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL;
  const faux = fauxProvider({ provider: "worker-gatekeeper", api: "worker-gatekeeper" });
  const parentModel = faux.getModel();
  const catalog = new Map(
    (options.catalog ?? []).map((entry) => [
      `${entry.provider}/${entry.id}`,
      gateCatalogModel(entry.provider, entry.id),
    ]),
  );
  const authFailIds = options.authFailIds ?? new Set<string>();
  // The child reaches this faux over the real OpenAI-completions HTTP server (models.json),
  // so the completion model is observed from the actual child stream request (model.id
  // round-trips in the OpenAI-completions body) mapped to its provider via the catalog,
  // plus the faux/parent model for unconfigured seats.
  const modelIdToProvider = new Map<string, string>();
  modelIdToProvider.set(parentModel.id, parentModel.provider);
  for (const [key, entry] of catalog) {
    const [provider, id] = key.split("/");
    if (id !== undefined) modelIdToProvider.set(id, provider ?? entry.provider);
  }
  const seen: Array<{ provider: string; id: string }> = [];
  const responses = [
    fauxAssistantMessage(fauxToolCall(officerTool, { status: "pass", findings: [] })),
  ];
  faux.provider.stream = (() => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected Gatekeeper provider request");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end(next));
    return stream;
  }) as any;
  faux.provider.streamSimple = faux.provider.stream as any;
  // Register the faux provider plus any catalog overrides (except auth-fail models, whose
  // seat must fail loudly as provider-is-not-configured). All point at the one faux server.
  const extraProviders = (options.catalog ?? [])
    .filter((entry) => !authFailIds.has(entry.id))
    .map((entry) => entry);
  await registerInstitutionalProviderFixture(faux, extraProviders, {
    onModel(modelId) {
      seen.push({ provider: modelIdToProvider.get(modelId) ?? parentModel.provider, id: modelId });
    },
  });
  return {
    parentModel,
    seen,
    context(id: string, toolName: string) {
      const runDirectory = installInstitutionalRunDir(options.seats ?? parentInheritedSeats(parentModel));
      return Object.assign(toolCallContext([{ id, name: toolName }]), {
        cwd: process.cwd(),
        model: parentModel,
        modelRegistry: {
          // Override providers share the scripted stream so completion model is observable.
          getProvider() { return faux.provider; },
          find(providerName: string, modelId: string) {
            return catalog.get(`${providerName}/${modelId}`);
          },
          async getProviderAuth() { return { auth: { apiKey: "test-key" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-key" }; },
        },
        thinkingLevel: "off",
      });
    },
  };
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
  auditSoulCompliance: Parameters<
    typeof createRoleRuntimeExtension
  >[0]["auditSoulCompliance"],
  transcriptFromContext: (ctx: ExtensionContext) => string = () =>
    "review evidence and adjudication",
) {
  return withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    const harness = extensionHarness("judge");
    installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
      loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
      auditSoulCompliance,
    }, { transcriptFromContext });
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    return { harness, tool };
  });
}

test("stable factory registers the complete typed role flag set and stays inert without a role", async () => {
  let loads = 0;
  const harness = extensionHarness(undefined);
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => { loads += 1; return "judge"; },
    loadFixerSoul: async () => { loads += 1; return "fixer"; },
    loadCoderSoul: async () => { loads += 1; return "coder"; },
    loadReviewerSoul: async () => { loads += 1; return "reviewer"; },
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  assert.deepEqual(new Set(harness.flags.keys()), new Set([
    "ak-role",
    "ak-fix-packet",
    "ak-fixer-prerequisites",
    "ak-fixer-phase",
    "ak-coder-task",
    "ak-coder-phase",
    "ak-review-base",
    "ak-review-scope-keys",
    "ak-review-authority-refs",
    "ak-review-ticket-number",
    "ak-doctor-case",
    "ak-merger-input",
    "ak-notary-source-run",
    "ak-notary-ticket-number",
    "ak-collector-repo",
    "ak-collector-pr",
    "ak-collector-request-manifest",
    "ak-gleaner-left-base",
    "ak-diarist-sources",
  ]));
  for (const [name, options] of harness.flags) {
    assert.equal((options as { type?: unknown }).type, "string", name);
  }
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
      loadJudgeSoul: async () => "judge",
      auditSoulCompliance: async () => ({ status: "pass" }),
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

test("unsupported role fails with the frozen diagnostic before any loader runs", async () => {
  let loads = 0;
  const harness = extensionHarness("router");
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => { loads += 1; return "judge"; },
    loadFixerSoul: async () => { loads += 1; return "fixer"; },
    loadCoderSoul: async () => { loads += 1; return "coder"; },
    loadReviewerSoul: async () => { loads += 1; return "reviewer"; },
    auditSoulCompliance: async () => ({ status: "pass" }),
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
    ((h) => { armGateSummonOnHost(h); return h; })(createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI).host),
    {
      loadSoul: async () => "  JUDGE LAW  ",
      auditSoulCompliance: async () => ({ status: "pass" }),
    },
    testHostActions(),
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
  const fixerRuntime = createFixerRoleRuntime(
    ((h) => { armGateSummonOnHost(h); return h; })(createPiRoleHostAdapter(fixer.pi as unknown as ExtensionAPI).host),
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
  assert.equal(fixer.handlers.has("input"), false);
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
    ((h) => { armGateSummonOnHost(h); return h; })(createPiRoleHostAdapter(coder.pi as unknown as ExtensionAPI).host),
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
    armGateSummonOnHost(piHostAdapter.host);
        const runtime = createJudgeRoleRuntime(
          piHostAdapter.host,
          {
            loadSoul: async () => "judge",
            auditSoulCompliance: async () => ({ status: "pass", usage }),
          },
          testHostActions(),
        );
        await runtime.activate();
        return harness;
      },
      output: { judgeStatus: "converged", evidence: { checks: [{ name: "receipt", passed: true }] } },
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
    armGateSummonOnHost(piHostAdapter.host);
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
    armGateSummonOnHost(piHostAdapter.host);
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
    assert.deepEqual(
      result.usage,
      fixture.role === "judge" ? usage : undefined,
    );
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
  let auditCalls = 0;
  const { harness, tool } = await startJudge(async () => {
    auditCalls += 1;
    return { status: "pass" };
  });

  assert.ok(harness.flags.has("ak-role"));
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );
  assert.match((promptResult as { systemPrompt: string }).systemPrompt, /JUDGE LAW/);

  const verdict: JudgeVerdict = { judgeStatus: "converged" };
  const context = await withPassingGatekeeper(toolCallContext([{ id: "call-1", arguments: verdict }]));
  const { sealed, pending } = await acceptThroughTypedRoundClosure({
    handlers: harness.handlers,
    tool,
    toolCallId: "call-1",
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: verdict,
    context,
  });

  // Zero hand-delivery: auditor is invoked with context only (no projected materials).
  assert.equal(auditCalls, 1);
  assert.equal(pending.terminate, undefined);
  assert.deepEqual(sealed.decisiveFacts, verdict);
});

test("judge role returns revise as an ordinary errored tool result without aborting", async () => {
  const { tool } = await startJudge(async () => ({
    status: "revise",
    violations: ["No authority clause was applied", "Tests were not adjudicated"],
  }));
  const verdict = { judgeStatus: "converged" };
  let abortCalls = 0;

  await assert.rejects(
    tool.execute(
      "call-2",
      verdict,
      undefined,
      undefined,
      await withPassingGatekeeper(toolCallContext([{ id: "call-2", arguments: verdict }], () => {
        abortCalls += 1;
      })),
    ),
    /No authority clause was applied; Tests were not adjudicated/,
  );
  assert.equal(abortCalls, 0);
});

test("judge aborts the active operation before rethrowing audit infrastructure failures", async () => {
  const { tool } = await startJudge(async () => {
    throw new Error("provider unavailable");
  });
  const verdict = { judgeStatus: "converged" };
  let abortCalls = 0;

  await assert.rejects(
    tool.execute(
      "audit-failure",
      verdict,
      undefined,
      undefined,
      await withPassingGatekeeper(toolCallContext(
        [{ id: "audit-failure", arguments: verdict }],
        () => {
          abortCalls += 1;
        },
      )),
    ),
    /provider unavailable/,
  );
  assert.equal(abortCalls, 1);
});

test("packaged infrastructure failure silence correlates the exact output call in either sibling order", async () => {
  for (const order of ["failure-first", "sibling-first"] as const) {
    const harness = extensionHarness("judge");
    const previousExitCode = process.exitCode;
    const events: unknown[] = [];
    const entries: unknown[] = [];
    let navigatorTool: Tool | undefined;
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    let preparationReady!: () => void;
    const preparationStartedPromise = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const preparationReadyPromise = new Promise<void>((resolve) => { preparationReady = resolve; });
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const navigatorSession: NavigatorPreparationSession = {
      async prompt() {
        preparationStarted();
        await preparationGate;
      },
      appendEntry(customType, data) {
        entries.push({ type: "custom", customType, data });
      },
      entries: () => entries,
      recordPointer: () => "/fixture/navigator-record",
      dispose() {},
    };
    let navigator: ReturnType<typeof createNavigatorAttendance> | undefined;
    const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
    armGateSummonOnHost(piHostAdapter.host);
    const extension = createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW",
      auditSoulCompliance: async () => { throw new Error("provider quota exhausted"); },
      loadNavigatorWorkContext: async () => ({ subjectKey: "/repo/.ak/work/issues/28", subject: "issue 28", authority: "owner authority", subjectProvenance: "role_input" as const }),
      createNavigatorAttendance: async (options) => {
        navigator = createNavigatorAttendance({
          ...options,
          context: toPiContext(options.context),
          modelSettingPath: "/missing/navigator-model.json",
          loadSoul: async () => "route law",
          loadRoleHelp: async (role) => `Usage: pi --ak-role ${role} --help`,
          createSession: async ({ tool }) => {
            navigatorTool = tool as Tool;
            preparationReady();
            return navigatorSession;
          },
          onEvent: async (event) => { events.push(event); },
        });
        return navigator;
      },
    });
    extension(piHostAdapter);
    await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
      const ctx = activationCtx(home, { mode: "print" });
      await harness.handlers.get("session_start")?.({}, ctx);
      assert.ok(navigator);
      navigator.prepare();
      await preparationReadyPromise;
      await preparationStartedPromise;
      assert.ok(navigatorTool);
      const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
      assert.ok(tool);
      const verdict = { judgeStatus: "converged" };
      await assert.rejects(
        tool.execute("failed-output", verdict, undefined, undefined, await withPassingGatekeeper(toolCallContext([{ id: "failed-output", arguments: verdict }]))),
        /provider quota exhausted/,
      );
      const sibling = { toolName: "read", toolCallId: "sibling", isError: false, details: {} };
      const failure = { toolName: JUDGE_OUTPUT_TOOL_NAME, toolCallId: "failed-output", isError: true, details: { message: "native provider wording" } };
      const wrong = { ...failure, toolCallId: "other-output" };
      await harness.handlers.get("tool_result")?.(wrong, ctx);
      let failureSettlement: unknown;
      if (order === "failure-first") {
        failureSettlement = harness.handlers.get("tool_result")?.(failure, ctx);
        await harness.handlers.get("tool_result")?.(sibling, ctx);
      } else {
        await harness.handlers.get("tool_result")?.(sibling, ctx);
        failureSettlement = harness.handlers.get("tool_result")?.(failure, ctx);
      }
      let drained = false;
      void Promise.resolve(failureSettlement).then(() => { drained = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false, "in-flight healthy preparation must hold the output settlement");
      assert.deepEqual(events, [], "infrastructure failure must not publish advice before drain");
      releasePreparation();
      await failureSettlement;
      assert.equal(drained, true);
      const settlement = entries.find((entry: any) => entry.customType === "ak-navigator-settlement") as any;
      assert.ok(settlement?.data);
      const { invocationId, ...typedSettlement } = settlement.data;
      assert.equal(typeof invocationId, "string");
      assert.deepEqual(typedSettlement, {
        subjectKey: "/repo/.ak/work/issues/28",
        role: "judge",
        phase: null,
        kind: "role_infrastructure_failure",
      });
      // Role infrastructure terminality is an affirmative no-advice outcome,
      // never a recommendation and never inferred from absence.
      assert.equal(events.length, 1, "infrastructure path emits one affirmative attendance fact");
      const attendance = events[0] as { disposition?: string } | undefined;
      assert.equal(attendance?.disposition, "no-advice");
      assert.notEqual(attendance?.disposition, "recommendation");
      await harness.handlers.get("agent_settled")?.({}, ctx);
      process.exitCode = previousExitCode;
    });
  }
});

test("judge role fails before adjudication when its soul is empty", async () => {
  const harness = extensionHarness("judge");
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => "   \n",
    auditSoulCompliance: async () => ({ status: "pass" }),
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
  let bindingLoads = 0;
  const harness = extensionHarness("coder", {
    "ak-coder-task": "/materials/task.md",
    "ak-coder-phase": "plan",
  });
  installRoleRuntime(harness.pi, {
    loadJudgeSoul: async () => "JUDGE LAW",
    loadCoderSoul: async () => "CODER LAW",
    loadCoderTask: async (path) => {
      loadedTasks.push(path);
      return "IMPLEMENT THE VERTICAL SLICE";
    },
    loadCanonicalSkillBinding: async () => {
      bindingLoads += 1;
      return tddBinding();
    },
    auditSoulCompliance: async () => ({ status: "pass" }),
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
  assert.equal(bindingLoads, 0);
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
  assert.doesNotMatch(prompt, /TDD AND SELF-CHECK/);

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
  assert.deepEqual(sealed.decisiveFacts, output);
  assert.equal(pending.terminate, undefined);
});

test("coder apply unfinished without reason bounces then accepts reasoned resubmit; max two bounces then accept", async () => {
  const harness = extensionHarness("coder", {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => "JUDGE LAW",
    loadCoderSoul: async () => "CODER LAW",
    loadCoderTask: async () => "APPROVED IMPLEMENTATION PLAN",
    loadCanonicalSkillBinding: async () => tddBinding(),
    auditSoulCompliance: async () => ({ status: "pass" }),
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
    assert.deepEqual(sealed.decisiveFacts, reasoned);
  });
  // Negative: continuous bare resubmits bounce at most twice, then accept through Gatekeeper (no loop).
  // Fresh admitted run — prior seal must not cross run boundaries.
  const harness2 = extensionHarness("coder", {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  installRoleRuntime(harness2.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => "JUDGE LAW",
    loadCoderSoul: async () => "CODER LAW",
    loadCoderTask: async () => "APPROVED IMPLEMENTATION PLAN",
    loadCanonicalSkillBinding: async () => tddBinding(),
    auditSoulCompliance: async () => ({ status: "pass" }),
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
    assert.deepEqual(sealed.decisiveFacts, bare);
  });
});

test("Gatekeeper non-pass projects structured details through role-runtime tool_result", async () => {
  // Real entry: judge output → requireGatekeeperPass binds via envelope hostActions → tool_result projects.
  const harness = extensionHarness("judge");
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => "JUDGE LAW",
    auditSoulCompliance: async () => ({ status: "pass" }),
  });
  await withActivationHome({ prefix: "ak-gatekeeper-tool-result-" }, async ({ home }) => {
    const ctx = activationCtx(home);
    await harness.handlers.get("session_start")?.({}, ctx);
    const findings = ["add a focused regression"];
    const toolCallId = "judge-gk-bounce";
    const bounceSubmission = { status: "bounce", findings };
    const expected = {
      status: "bounce" as const,
      officer: "notary" as const,
      disposition: "rewrite" as const,
      findings,
      submission: bounceSubmission,
    };
    const faux = fauxProvider({ provider: "gk-tool-result", api: "gk-tool-result" });
    const model = faux.getModel();
    // #675: offline gate summons inject public terminal results via hostActions.
    defaultGateSummon = async (officer) => ({
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: officer,
          status: "bounce",
          decisiveFacts: bounceSubmission,
        },
        navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
        artifacts: [],
        runId: "test-gk-bounce",
      },
    });
      // Singleton check needs the tool-call leaf on sessionManager; do not clobber it with activationCtx.
    installInstitutionalRunDir(parentInheritedSeats(model));
    const gateContext = Object.assign(toolCallContext([{ id: toolCallId, name: JUDGE_OUTPUT_TOOL_NAME }]), {
      cwd: process.cwd(),
      model,
      modelRegistry: scriptedGatekeeperModelRegistry(model, faux.provider),
      thinkingLevel: "off",
    });
    const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    await assert.rejects(
      tool.execute(toolCallId, { judgeStatus: "converged" }, undefined, undefined, gateContext),
      (error: unknown) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.deepEqual(error.result, expected);
        return true;
      },
    );
    // Real parent seam: envelope tool_result projects bound structured non-pass onto session details.
    const projection = await harness.handlers.get("tool_result")?.({
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId,
      isError: true,
      content: [{ type: "text", text: "model-visible surface" }],
      details: {},
    }, ctx);
    assert.deepEqual(projection, { details: expected, isError: true });
    // Binding is single-consume; a second tool_result must not invent details.
    const second = await harness.handlers.get("tool_result")?.({
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId,
      isError: true,
      content: [{ type: "text", text: "model-visible surface" }],
      details: {},
    }, ctx);
    assert.equal(second, undefined);
  });
});

test("coder completed submissions traverse the direct Inspector gate until pass", async () => {
  const request = "Apply the approved plan.";
  const harness = extensionHarness(undefined, {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
    armGateSummonOnHost(piHostAdapter.host);
  const runtime = createCoderRoleRuntime(
    piHostAdapter.host,
    {
      loadSoul: async () => "CODER LAW",
      loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
      loadCanonicalSkillBinding: async () => tddBinding(),
    },
    testHostActions(),
  );
  await runtime.activate();
  await harness.handlers.get("input")?.({ text: request }, {});
  await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd(request) },
    { abort() {}, mode: "tui" },
  );
  const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const completed = { status: "completed", report: "TDD and verification evidence" };
  const tracer = await workerCompletionGatekeeperHarness({
    execute: (id, output, context) => tool.execute(id, output as typeof completed, undefined, undefined, context),
    toolName: CODER_OUTPUT_TOOL_NAME,
    output: completed,
  });
  await tracer.assertRejectSequence();
  const accepted = await tool.execute("accepted", completed, undefined, undefined, tracer.context("accepted", CODER_OUTPUT_TOOL_NAME));

  assert.equal(accepted.terminate, true);
  // #675: one public summon per gate attempt (transport/unusable/no_receipt/bounce/pass).
  assert.equal(tracer.providerRequests, 5);
  assert.equal(tracer.remainingResponses, 0);
});

test("fixer completed and partially_completed traverse the direct Inspector gate; skip statuses settle without it", async () => {
  const start = async (phase: "plan" | "apply") => {
    const harness = extensionHarness(undefined, {
      "ak-fix-packet": "/materials/fix.md",
      "ak-fixer-phase": phase,
    });
    const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
    armGateSummonOnHost(piHostAdapter.host);
    const runtime = createFixerRoleRuntime(
      piHostAdapter.host,
      { loadSoul: async () => "FIXER LAW", loadPacket: async () => emptyFixPacket },
      testHostActions(),
    );
    await runtime.activate();
    return harness.tools.get(FIXER_OUTPUT_TOOL_NAME)!;
  };
  const completed = {
    status: "completed" as const,
    report: "repair complete",
    classResults: [{ name: "Gate", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }],
  };
  const completedTool = await start("apply");
  const tracer = await workerCompletionGatekeeperHarness({
    execute: (id, output, context) => completedTool.execute(id, output as typeof completed, undefined, undefined, context),
    toolName: FIXER_OUTPUT_TOOL_NAME,
    output: completed,
    // completed + partially_completed consume the direct Inspector pass;
    // planned / refused / unfinished settle without summoning.
    passingRuns: 2,
  });
  const submissionContext = (id: string) => tracer.context(id, FIXER_OUTPUT_TOOL_NAME);
  await tracer.assertRejectSequence();
  assert.equal((await completedTool.execute("pass", completed, undefined, undefined, submissionContext("pass"))).terminate, true);

  const partial = {
    status: "partially_completed" as const,
    report: "mixed lawful settlement",
    classResults: [
      completed.classResults[0],
      { name: "Blocked", disposition: "refused" as const, remainingScope: "owner choice", blocker: { kind: "missing_prerequisite" as const, prerequisiteId: "owner.choice", reason: "owner choice missing" } },
    ],
  };
  const partialHarness = extensionHarness(undefined, { "ak-fix-packet": "/materials/fix.md", "ak-fixer-prerequisites": "/materials/prereqs.json", "ak-fixer-phase": "apply" });
  const partialPiHostAdapter = createPiRoleHostAdapter(partialHarness.pi as unknown as ExtensionAPI);
  armGateSummonOnHost(partialPiHostAdapter.host);
  const partialRuntime = createFixerRoleRuntime(partialPiHostAdapter.host, {
    loadSoul: async () => "FIXER LAW",
    loadPacket: async (path) => path.endsWith("prereqs.json") ? declaredFixPrerequisites : emptyFixPacket,
  }, testHostActions());
  await partialRuntime.activate();
  assert.equal((await partialHarness.tools.get(FIXER_OUTPUT_TOOL_NAME)!.execute("partial", partial, undefined, undefined, submissionContext("partial"))).terminate, true);

  const unfinished = {
    status: "unfinished" as const,
    report: "handover",
    remainingScope: "owner answer",
    reason: "prerequisite_missing: owner answer",
  };
  const unfinishedTool = await start("apply");
  assert.equal(
    (await unfinishedTool.execute("unfinished", unfinished, undefined, undefined, submissionContext("unfinished"))).terminate,
    true,
  );

  const beforeAllStatuses = tracer.providerRequests;
  const planTool = await start("plan");
  assert.equal(
    (await planTool.execute("planned", { status: "planned", report: "plan" }, undefined, undefined, submissionContext("planned"))).terminate,
    true,
  );
  assert.equal(
    (await planTool.execute("plan-refused", { status: "refused", report: "blocked", remainingScope: "owner answer", blocker: { kind: "missing_prerequisite", prerequisiteId: "owner.choice", reason: "missing" } }, undefined, undefined, submissionContext("plan-refused"))).terminate,
    true,
  );
  const applyTool = await start("apply");
  assert.equal(
    (await applyTool.execute("apply-refused", { status: "refused", report: "blocked", classResults: [{ name: "Blocked", disposition: "refused", remainingScope: "owner answer", blocker: { kind: "unconstitutional", authority: "ADR", conflict: "conflict" } }] }, undefined, undefined, submissionContext("apply-refused"))).terminate,
    true,
  );
  // skip statuses must not consume further officer passes.
  assert.equal(tracer.providerRequests, beforeAllStatuses);
  // #675: reject matrix is 4 public summons + two DONE passes = 6.
  assert.equal(tracer.providerRequests, 6);
  assert.equal(tracer.remainingResponses, 0);
});

test("judge submissions traverse the direct Notary gate before auditor", async () => {
  let auditCalls = 0;
  const { harness, tool } = await startJudge(async () => {
    auditCalls += 1;
    return { status: "pass" };
  });
  // Full direct-Notary reject+pass matrix once; production does not branch on judgeStatus.
  const continueVerdict = {
    judgeStatus: "continue" as const,
    fix: { summary: "tighten the gate" },
    note: "ticket-review",
  };
  const tracer = await workerCompletionGatekeeperHarness({
    execute: (id, output, context) => tool.execute(id, output, undefined, undefined, context),
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: continueVerdict,
    officer: "notary",
  });
  await tracer.assertRejectSequence();
  // Shape-unreadable parent-stands past the gate and reaches auditor once (#675 / ADR 0055).
  // bounce/no_receipt/transport still keep auditor dark.
  assert.equal(auditCalls, 1, "auditor runs once when shape-unreadable parent-stands");
  const context = tracer.context("continue-pass", JUDGE_OUTPUT_TOOL_NAME);
  const { sealed, pending } = await acceptThroughTypedRoundClosure({
    handlers: harness.handlers,
    tool,
    toolCallId: "continue-pass",
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: continueVerdict,
    context,
  });
  assert.equal(pending.terminate, undefined);
  assert.deepEqual(sealed.decisiveFacts, continueVerdict);
  assert.equal(auditCalls, 2, "auditor runs again after Notary pass");
  // #675: transport+unreadable+no_receipt+bounce + 1 pass = 5.
  assert.equal(tracer.providerRequests, 5);
  assert.equal(tracer.remainingResponses, 0);

  // Other judgeStatus: cheap same-gate assert — enters Gatekeeper; non-pass keeps auditor dark.
  const convergedVerdict = { judgeStatus: "converged" as const, note: "judgment" };
  const secondGate = await workerCompletionGatekeeperHarness({
    execute: (id, output, context) => tool.execute(id, output, undefined, undefined, context),
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: convergedVerdict,
    officer: "notary",
    passingRuns: 0,
  });
  await assert.rejects(
    tool.execute(
      "converged-gate",
      convergedVerdict,
      undefined,
      undefined,
      secondGate.context("converged-gate", JUDGE_OUTPUT_TOOL_NAME),
    ),
    (error: unknown) => {
      // First harness response is transport failure (plain Error via failInfrastructure).
      assert.ok(error instanceof Error);
      assert.equal(error instanceof GatekeeperDecisionError, false);
      return true;
    },
  );
  assert.equal(auditCalls, 2, "auditor must not start on Gatekeeper transport non-pass for other judgeStatus");
  assert.equal(secondGate.providerRequests, 1);
});

test("direct Inspector submit summons inspector; transport failure stays loud", async () => {
  const request = "Apply the approved plan.";
  const completed = { status: "completed", report: "TDD and verification evidence" };
  const startCoder = async () => {
    const harness = extensionHarness(undefined, {
      "ak-coder-task": "/materials/approved.md",
      "ak-coder-phase": "apply",
    });
    const runtime = createCoderRoleRuntime(
      ((h) => { armGateSummonOnHost(h); return h; })(createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI).host),
      {
        loadSoul: async () => "CODER LAW",
        loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
        loadCanonicalSkillBinding: async () => tddBinding(),
      },
      testHostActions(),
    );
    await runtime.activate();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      { abort() {}, mode: "tui" },
    );
    return harness.tools.get(CODER_OUTPUT_TOOL_NAME)!;
  };

  {
    const tool = await startCoder();
    const officers: string[] = [];
    defaultGateSummon = async (officer) => {
      officers.push(officer);
      return passingOfficerSummon(officer);
    };
      const faux = fauxProvider({ provider: "own-inspector", api: "own-inspector" });
    const model = faux.getModel();
    const runDirectory = installInstitutionalRunDir(parentInheritedSeats(model));
    const context = Object.assign(toolCallContext([{ id: "own-inspector", name: CODER_OUTPUT_TOOL_NAME }]), {
      cwd: process.cwd(),
      model,
      thinkingLevel: "off",
    });
    if (context.sessionManager !== undefined) {
      (context.sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    }
    const accepted = await tool.execute("own-inspector", completed, undefined, undefined, context);
    assert.equal(accepted.terminate, true);
    assert.deepEqual(officers, ["inspector"]);
  }
  {
    const tool = await startCoder();
    defaultGateSummon = async () => ({
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "inspector",
          cause: "provider",
          diagnostic: "provider is not configured: openai-codex",
          decisiveFacts: {},
        },
        navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
        artifacts: [],
        runId: "test-auth-fail",
      },
    });
      const faux = fauxProvider({ provider: "auth-fail", api: "auth-fail" });
    const model = faux.getModel();
    const runDirectory = installInstitutionalRunDir(parentInheritedSeats(model));
    const context = Object.assign(toolCallContext([{ id: "auth-fail", name: CODER_OUTPUT_TOOL_NAME }]), {
      cwd: process.cwd(),
      model,
      thinkingLevel: "off",
    });
    if (context.sessionManager !== undefined) {
      (context.sessionManager as any).getSessionFile = () => join(runDirectory, "session", "session.jsonl");
    }
    await assert.rejects(
      tool.execute("auth-fail", completed, undefined, undefined, context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof GatekeeperDecisionError, false);
        return /provider is not configured/.test(error.message);
      },
    );
  }
});

test("coder apply binds completion to the immediately following canonical tdd expansion", async () => {
  // #319 Batch 3 (M1): lightweight expansion-binding API seam.
  // Publish-surface packaged Pi coverage stays in package-entrypoint (M1.4/M1.5).
  // Unarmed submission gate: completed does not need git baseline (gate ①).
  const request = "Apply the approved plan.";
  const completed = {
    status: "completed",
    report: "TDD evidence and self-check three are recorded here.",
  };
  const agentCtx = { abort() {}, mode: "tui" };

  const start = async () => {
    const harness = extensionHarness(undefined, {
      "ak-coder-task": "/materials/approved.md",
      "ak-coder-phase": "apply",
    });
    const faux = fauxProvider({ provider: "coder-binding-gatekeeper", api: "coder-binding-gatekeeper" });
    const model = faux.getModel();
    // #675: completed submissions summon Inspector via public path; inject pass.
    defaultGateSummon = async (officer) => passingOfficerSummon(officer);
      const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
    armGateSummonOnHost(piHostAdapter.host);
    const runtime = createCoderRoleRuntime(
      piHostAdapter.host,
      {
        loadSoul: async () => "CODER LAW",
        loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
        loadCanonicalSkillBinding: async () => tddBinding(),
      },
      testHostActions(),
    );
    await runtime.activate();
    return Object.assign(harness, {
      model,
      provider: faux.provider,
      providerRequests: () => faux.state.callCount,
      incRequests: () => ++faux.state.callCount,
    });
  };
  const submitCompleted = async (
    harness: Awaited<ReturnType<typeof start>>,
    id: string,
  ) => {
    const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    return withInstitutionalRunDir(parentInheritedSeats(harness.model), () =>
      tool.execute(
        id,
        completed,
        undefined,
        undefined,
        Object.assign(toolCallContext([{ id, name: CODER_OUTPUT_TOOL_NAME }]), {
          cwd: process.cwd(),
          model: harness.model,
          modelRegistry: scriptedGatekeeperModelRegistry(harness.model, harness.provider, {
            matchProvider: false,
          }),
          thinkingLevel: "off",
        }),
      ),
    );
  };

  // M1.1 — completed binds to the immediately following canonical expansion.
  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.(
        { text: request, source: "interactive", images: [{ type: "image", data: "fixture" }] },
        {},
      ),
      {
        action: "transform",
        text: `/skill:tdd ${request}`,
        images: [{ type: "image", data: "fixture" }],
      },
    );
    assert.deepEqual(
      await harness.handlers.get("input")?.(
        { text: "A later message must not reinvoke TDD." },
        {},
      ),
      { action: "continue" },
    );
    const promptResult = await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
    assert.match(prompt, /<coder_phase>\s*apply/);
    assert.doesNotMatch(prompt, /coder_quality_skill/);
    assert.deepEqual((await submitCompleted(harness, "accepted")).details, completed);
  }

  const assertExpansionEvidenceMissing = async (
    promise: Promise<unknown>,
  ): Promise<void> => {
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof CoderSkillExpansionEvidenceMissingError);
      assert.equal(error.code, CODER_SKILL_EXPANSION_EVIDENCE_MISSING_CODE);
      assert.equal(error.result.code, CODER_SKILL_EXPANSION_EVIDENCE_MISSING_CODE);
      return true;
    });
  };

  // M1.2 — one must-reject malformed expansion proves the completed-gate (law ③);
  // the full malformed spelling matrix lives in canonical-skill-binding tests.
  {
    const harness = await start();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request).replace(tddBody, "# Canonical TDD") },
      agentCtx,
    );
    await assertExpansionEvidenceMissing(submitCompleted(harness, "malformed-gate"));
  }

  // M1.2b — host without capability declaration rejects completed even when prompt looks lawful.
  {
    const harness = extensionHarness(undefined, {
      "ak-coder-task": "/materials/approved.md",
      "ak-coder-phase": "apply",
    });
    const faux = fauxProvider({ provider: "coder-no-caps-gatekeeper", api: "coder-no-caps-gatekeeper" });
    const model = faux.getModel();
    const responses: AssistantMessage[] = [];
    for (let i = 0; i < 4; i += 1) {
      responses.push(fauxAssistantMessage(fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] })));
    }
    faux.setResponses(responses);
    await registerInstitutionalProviderFixture(faux);
    const baseHost = ((h) => { armGateSummonOnHost(h); return h; })(createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI).host);
    const hostWithoutCapabilities = new Proxy(baseHost, {
      get(target, prop, receiver) {
        if (prop === "capabilities") return undefined;
        return Reflect.get(target, prop, receiver);
      },
    }) as RoleHost;
    const runtime = createCoderRoleRuntime(
      hostWithoutCapabilities,
      {
        loadSoul: async () => "CODER LAW",
        loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
        loadCanonicalSkillBinding: async () => tddBinding(),
      },
      testHostActions(),
    );
    await runtime.activate();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    await assertExpansionEvidenceMissing(
      withInstitutionalRunDir(parentInheritedSeats(model), () =>
        tool.execute(
          "no-caps",
          completed,
          undefined,
          undefined,
          Object.assign(toolCallContext([{ id: "no-caps", name: CODER_OUTPUT_TOOL_NAME }]), {
            cwd: process.cwd(),
            model,
            modelRegistry: scriptedGatekeeperModelRegistry(model, faux.provider, {
              matchProvider: false,
            }),
            thinkingLevel: "off",
          }),
        ),
      ),
    );
  }

  // M1.3 — later / non-immediate expansion must not authorize completed.
  {
    const harness = await start();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: "not the expansion" },
      agentCtx,
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    await assertExpansionEvidenceMissing(submitCompleted(harness, "later"));
  }

  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.({
        text: `/skill:tdd ${request}`,
      }, {}),
      { action: "continue" },
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    assert.deepEqual((await submitCompleted(harness, "prefixed")).details, completed);
  }

  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.({ text: "/skill:tdd" }, {}),
      { action: "continue" },
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd("") },
      agentCtx,
    );
    assert.deepEqual((await submitCompleted(harness, "bare-native")).details, completed);
  }

  // Prefix-collision transform binding (packaged seam owns real Pi expansion M1.5).
  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.({ text: "/skill:tddfoo" }, {}),
      {
        action: "transform",
        text: "/skill:tdd /skill:tddfoo",
      },
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd("/skill:tddfoo") },
      agentCtx,
    );
    assert.deepEqual((await submitCompleted(harness, "collision")).details, completed);
  }

  // Refusal remains a sole-final-call terminal without the TDD expansion obligation,
  // and settles without summoning the Inspector (skip-statuses).
  {
    const harness = await start();
    const refused = {
      status: "refused",
      report: "The assignment contradicts its authority.",
    };
    const refusalTool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
    assert.ok(refusalTool);
    const requestsBeforeRefusal = harness.providerRequests();
    await withInstitutionalRunDir(parentInheritedSeats(harness.model), async () => {
      assert.deepEqual((await refusalTool.execute(
        "coder-refused",
        refused,
        undefined,
        undefined,
        Object.assign(toolCallContext([{ id: "coder-refused", name: CODER_OUTPUT_TOOL_NAME }]), {
          cwd: process.cwd(),
          model: harness.model,
          modelRegistry: scriptedGatekeeperModelRegistry(harness.model, harness.provider, {
            matchProvider: false,
          }),
          thinkingLevel: "off",
        }),
      )).details, refused);
      assert.equal(harness.providerRequests(), requestsBeforeRefusal);
      await assert.rejects(
        refusalTool.execute(
          "coder-mixed",
          completed,
          undefined,
          undefined,
          toolCallContext([
            { id: "coder-mixed", name: CODER_OUTPUT_TOOL_NAME },
            { id: "sibling", name: "read" },
          ]),
        ),
      );
    });
  }
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
      loadJudgeSoul: async () => "judge",
      loadFixerSoul: async () => "fixer",
      loadFixPacket: async () => row.packet,
      auditSoulCompliance: async () => ({ status: "pass" }),
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

test("undeclared prerequisite submissions are rejected; declared references pass structure then Gatekeeper", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer", loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n", auditSoulCompliance: async () => ({ status: "pass" }),
  });
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
    const seatModel = fauxProvider({ provider: "prereq-seats", api: "prereq-seats" }).getModel();
    const candidate = (prerequisiteId: string) => ({ status: "refused" as const, report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused" as const, remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId, evidence: "Choice absent." } }] });
    // Shape reject: session header supplies run identity (no shared unbound).
    await assert.rejects(tool.execute("bad", candidate("other"), undefined, undefined, Object.assign(toolCallContext([{ id: "bad", name: FIXER_OUTPUT_TOOL_NAME }]), { cwd: process.cwd() })), /Fixer output/);
    // Each accepted sole-final needs its own admitted run — post-seal is terminal.
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
      assert.equal(pending.terminate, undefined);
      assert.deepEqual(sealed.decisiveFacts, candidate("owner.choice"));
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
      assert.deepEqual(sealed.decisiveFacts, partial);
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
      assert.equal(pending.terminate, undefined);
      assert.deepEqual(sealed.decisiveFacts.classResults, [classA, classB]);
    });
  });
});
test("declared plan refusal passes structure then Gatekeeper", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "plan" });
  installRoleRuntime(harness.pi as unknown as ExtensionAPI, {
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer",
    loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n", auditSoulCompliance: async () => ({ status: "pass" }),
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
    assert.deepEqual(sealed.decisiveFacts, candidate);
    assert.equal(pending.terminate, undefined);
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
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW\nCreate one forward commit.",
    loadFixPacket: async (path) => {
      loadedPaths.push(path);
      return instructionBytes;
    },
    auditSoulCompliance: async () => ({ status: "pass" }),
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
  assert.equal(pending.terminate, undefined);
  assert.deepEqual(sealed.decisiveFacts, output);
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
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW",
    loadFixPacket: async () => emptyFixPacket,
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  assert.deepEqual(harness.activeToolSets, []);
  assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), true);
});



test(
  "accepted role terminal races production 10s Navigator grace through role-runtime to Terminal",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(NAVIGATOR_POST_ROLE_GRACE_MS, 10_000);

    const routePlaybookCause = "ROUTEBOOK_FAILED_BEFORE_HELD_PROMPT";
    const modelRoot = await mkdtemp(join(tmpdir(), "ak-judge-grace-model-"));
    const modelSettingPath = join(modelRoot, "navigator-model.json");
    await writeFile(modelSettingPath, JSON.stringify({ model: "provider/model" }), "utf8");

    try {
      const harness = extensionHarness("judge");
      const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
      (harness.pi as { sendMessage?: (message: unknown) => Promise<void> }).sendMessage = async (
        message: unknown,
      ) => {
        sentMessages.push(message as { customType?: string; details?: unknown });
      };

      let releasePreparation!: () => void;
      let preparationStarted!: () => void;
      const preparationStartedPromise = new Promise<void>((resolve) => {
        preparationStarted = resolve;
      });
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      let disposeCalls = 0;
      const events: unknown[] = [];
      let attendance: ReturnType<typeof createNavigatorAttendance> | undefined;
      const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
    armGateSummonOnHost(piHostAdapter.host);

      const extension = createRoleRuntimeExtension({
        loadJudgeSoul: async () => "JUDGE LAW",
        auditSoulCompliance: async () => ({ status: "pass" }),
        loadNavigatorWorkContext: async () => ({
          subjectKey: "/repo/.ak/work/issues/106",
          subject: "issue 106",
          authority: "owner authority",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: async (options) => {
          attendance = createNavigatorAttendance({
            ...options,
            context: toPiContext(options.context),
            modelSettingPath,
            loadSoul: async () => "route law",
            loadRoutePlaybook: async () => {
              throw new Error(routePlaybookCause);
            },
            loadRoleHelp: async (role) => `Usage: pi --ak-role ${role} --help`,
            createSession: async () => ({
              async prompt() {
                preparationStarted();
                await preparationGate;
              },
              appendEntry() {},
              entries: () => [],
              recordPointer: () => "/fixture/navigator-record",
              dispose() {
                disposeCalls += 1;
              },
            }),
            onEvent: async (event, report) => {
              events.push(event);
              await options.onEvent(event, report);
            },
          });
          return attendance;
        },
      });
      extension(piHostAdapter);

      await withActivationHome({ prefix: "ak-judge-grace-" }, async ({ home }) => {
        const ctx = activationCtx(home);
        await harness.handlers.get("session_start")?.({}, ctx);
        assert.ok(attendance, "Navigator attendance must be installed on session_start");
        // Start in-flight preparation that will outlive the post-role grace.
        // Call the production attendance directly (same object role-runtime holds).
        attendance.prepare();
        await preparationStartedPromise;

        // Registered output execute creates only a candidate; typed turn_end owns closure + grace race.
        const executeCtx = await withPassingGatekeeper(ctx);
        const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
        assert.ok(tool);
        await harness.handlers.get("tool_execution_start")?.({
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          toolCallId: "accepted-grace",
        }, executeCtx);
        const pending = await tool.execute(
          "accepted-grace",
          { judgeStatus: "converged", note: "ok" },
          undefined,
          undefined,
          executeCtx,
        );
        assert.deepEqual(pending.details, { submissionDisposition: "pending-round-closure" });
        const turnEndPending = harness.handlers.get("turn_end")?.({
          turnIndex: 0,
          calls: [{ toolCallId: "accepted-grace", toolName: JUDGE_OUTPUT_TOOL_NAME }],
          toolResults: [{ toolCallId: "accepted-grace", toolName: JUDGE_OUTPUT_TOOL_NAME }],
        }, executeCtx);
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(NAVIGATOR_POST_ROLE_GRACE_MS);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await turnEndPending;

        assert.ok(disposeCalls >= 1, "late attendance must be disposed after grace timeout");

        await harness.handlers.get("agent_settled")?.({}, executeCtx);
        assert.equal(sentMessages.length, 1);
        const details = sentMessages[0]?.details as NavigatorEvent;
        assert.equal(details.disposition, "unavailable");
        assert.equal(details.invocationId, "post-role-grace-timeout");
        assert.equal(typeof details.unavailableReason, "string");
        assert.ok(String(details.unavailableReason).length > 0);
        assert.equal(details.unavailableSource, "unknown");
        assert.equal(details.unavailableCause, "unknown");
        assert.equal(details.routePlaybookReadFailure, routePlaybookCause);

        // Late preparation completion must not overwrite the grace unavailable fact.
        releasePreparation();
        const lateDrain = new Promise<void>((resolve) => setTimeout(resolve, 20));
        t.mock.timers.tick(20);
        await lateDrain;
        assert.equal(
          events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              (event as { disposition?: string }).disposition === "recommendation",
          ),
          false,
          "disposed late completion must not publish recommendation",
        );

        // Session attendance fact → typed Terminal navigator (settlement owner, not presentation).
        const terminalInvocationId = "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b";
        const navigator = extractNavigatorFact([
          {
            type: "custom",
            customType: NAVIGATOR_INVOCATION_ENTRY,
            data: {
              invocationId: terminalInvocationId,
              role: "judge",
              phase: null,
              subjectKey: details.subjectKey,
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { judgeStatus: "converged" },
            },
          },
          {
            type: "custom_message",
            customType: "ak-navigator-attendance",
            message: { details: { ...details, invocationId: terminalInvocationId } },
          },
        ] as never);
        assert.equal(navigator.disposition, "unavailable");
        if (navigator.disposition === "unavailable") {
          assert.equal(navigator.source, "unknown");
          assert.equal(typeof navigator.reason, "string");
          assert.ok(navigator.reason.length > 0);
          assert.equal(navigator.advisoryDiagnostic, routePlaybookCause);
        }
        const terminal = {
          roleOutcome: {
            kind: "accepted" as const,
            role: "judge" as const,
            status: "converged",
            decisiveFacts: { judgeStatus: "converged" },
          },
          navigator,
          artifacts: [{ kind: "report" as const, path: "/r/artifacts/report.json" }],
          runId: "run-grace-1",
        };
        assert.equal(terminal.roleOutcome.status, "converged");
        assert.equal(terminal.navigator.disposition, "unavailable");
        // Presentation accepts the typed result once; labels remain unfrozen.
        const formatted = formatTerminalResult(terminal);
        assert.ok(formatted.length > 0);
      });
    } finally {
    // Owner 2026-09-05: leave under tmpdir for OS cleanup.
    }
  },
);

// #420 整改移档（自 package-entrypoint-packaged-workers.integration.test.ts）：
// 纯进程内模块逻辑（Source-tree imports，无任何装包边界），性质属快档。
// Judge/doctor：revise→errored / pass→terminate / escalate 全矩阵。
// Fixer (#242) / Reviewer (#495 S6)：无审刑院闸，typed validate 即受理。
test("role outputs run nested audits through pass, revise, and escalation", async () => {
  // Source-tree imports: cold-install boundary is owned by neighbouring install tests;
  // this carrier owns revise→errored / pass→terminate / escalate per audited role output tool.
  const root = packageRoot;
  const importSrc = (rel: string) => import(resolve(root, rel));
  const nestedLedger = createTempPackageHomeLedger({ prefix: "ak-nested-audit-home-", runName: "nested@judge" });
  const nestedRunDir = nestedLedger.runDirectory;
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = nestedRunDir;
  try {
  {
      const [judge, doctor, judgeRole, workerRole, reviewerRole, doctorRole, terminating] = await Promise.all([
        importSrc("src/judge-auditor.ts"),
        importSrc("src/doctor-auditor.ts"),
        importSrc("src/judge-role.ts"),
        importSrc("src/worker-role.ts"),
        importSrc("src/reviewer-role.ts"),
        importSrc("src/doctor-role.ts"),
        importSrc("src/package-contracts/terminating-tools.ts"),
      ]);

      const patient = {
        version: 1,
        identity: { issueNumber: 58, runsPath: ".ak/work/issues/58/runs" },
        evidence: [],
        cost: { invocations: { total: 0, sources: [] }, bytes: 0 },
      };
      const skill = "canonical review skill";
      const escalation = {
        status: "escalate" as const,
        violations: [],
        conflicts: ["Soul conflicts with controlling authority"],
        decisionGate: {
          question: "Which authority governs this submission?",
          options: ["Soul", "Controlling authority"],
        },
      };
      const revise = {
        status: "revise" as const,
        violations: ["one concrete procedural violation"],
        conflicts: [],
        decisionGate: null,
      };
      const pass = {
        status: "pass" as const,
        violations: [],
        conflicts: [],
        decisionGate: null,
      };
      const outputs = {
        judge: { judgeStatus: "converged" },
        fixer: { status: "completed", report: "done", classResults: [
          { name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
          { name: "Audit", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
        ] },
        reviewer: { status: "refused", diagnostic: "no accepted dispatch" },
        doctor: { status: "refused", reason: "missing", missingEvidence: [{ need: "case evidence", targetKeys: ["case"] }] },
      } as const;
      const toolNames = {
        judge: judge.JUDGE_AUDIT_TOOL_NAME,
        doctor: doctor.DOCTOR_AUDIT_TOOL_NAME,
      } as const;
      const acceptedNames = {
        judge: "ak_judge_output",
        fixer: "ak_fixer_output",
        reviewer: "ak_reviewer_output",
        doctor: "ak_doctor_output",
      } as const;

      const makeHarness = (flags: Record<string, string> = {}) => {
        const tools = new Map<string, any>();
        const handlers = new Map<string, any>();
        const hostTools = ["read", "write", "grep", "find", "bash"];
        let activeTools: string[] = [...hostTools];
        const pi = {
          registerFlag() {},
          getFlag(name: string) { return flags[name]; },
          registerTool(tool: any) { tools.set(tool.name, tool); },
          getAllTools() { return [...hostTools, ...tools.keys()].map((name) => ({ name })); },
          setActiveTools(names: string[]) { activeTools = [...names]; },
          getActiveTools() { return activeTools; },
          on(name: string, handler: any) { handlers.set(name, handler); },
        };
        return { pi, tools, handlers, activeTools: () => [...activeTools] };
      };
      const outputContext = (name: string, id: string, arguments_: Record<string, unknown> = {}) => {
        const sessionManager = SessionManager.inMemory();
        (sessionManager as any).getSessionFile = () => join(nestedRunDir, "session", "session.jsonl");
        sessionManager.appendMessage({ role: "user", content: "assignment", timestamp: Date.now() });
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id, name, arguments: arguments_ }],
          api: "openai-responses",
          provider: "installed-role",
          model: "installed-role",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        return {
          sessionManager,
          model: { api: "openai-responses", provider: "installed-auditor", id: "installed-auditor" },
          modelRegistry: {
            async getProviderAuth() { return { auth: { apiKey: "offline" } }; },
            async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
          },
        } as any;
      };

      const createRole = (role: keyof typeof outputs, decision: typeof pass | typeof revise | typeof escalation) => {
        const harness = role === "fixer"
          ? makeHarness({ "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" })
          : role === "reviewer"
            ? makeHarness({ "ak-review-base": "review-base" })
            : role === "doctor"
              ? makeHarness({ "ak-doctor-case": "/case" })
              : makeHarness();
        const piHostAdapter = createPiRoleHostAdapter(harness.pi as unknown as ExtensionAPI);
    armGateSummonOnHost(piHostAdapter.host);
                let auditCalls = 0;
        let selectedDecision = decision;
        // Judge/doctor: zero-arg materials (#233). Fixer (#242) / Reviewer (#495 S6) no LLM auditor.
        // #675: compliance summons public auditor; offline injects the decision terminal.
        const auditCompliance = async (options: { context: HostContext; signal?: AbortSignal }) => {
          auditCalls += 1;
          const summonAuditor: AuditorSummon = async (_subject) => ({
            exitCode: 0,
            terminal: {
              roleOutcome: {
                kind: "accepted",
                role: "auditor",
                status: selectedDecision.status,
                decisiveFacts: selectedDecision as Record<string, unknown>,
              },
              navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
              artifacts: [],
              runId: "test-compliance",
            },
          });
          const piOptions = {
            ...options,
            context: toPiContext(options.context),
            summonAuditor,
          };
          return (role === "judge" ? judge.createPiJudgeAuditor() : doctor.createPiDoctorAuditor())(piOptions);
        };
        let runtime: any;
        if (role === "judge") {
          runtime = judgeRole.createJudgeRoleRuntime(piHostAdapter.host, {
            loadSoul: async () => "judge law",
            auditSoulCompliance: auditCompliance,
          }, testHostActions());
        } else if (role === "fixer") {
          runtime = workerRole.createFixerRoleRuntime(piHostAdapter.host, {
            loadSoul: async () => "fixer law",
            loadPacket: async () => "repair packet",
          }, testHostActions());
        } else if (role === "doctor") {
          runtime = doctorRole.createDoctorRoleRuntime(piHostAdapter.host, {
            loadSoul: async () => "doctor law",
            loadCase: async () => patient,
            auditCompliance,
          }, testHostActions());
        } else {
          const pin = { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "target", refs: {} };
          runtime = reviewerRole.createReviewerRoleRuntime(piHostAdapter.host, {
            loadSoul: async () => "reviewer law",
            loadCanonicalSkillBinding: async () => ({
              name: "code-review",
              snapshot: { raw: skill, path: "/skill", baseDir: "/", body: skill, snapshotIdentity: Object.freeze({ text: skill }) },
              invocation: (request: string) => request,
              captureExpansion: () => ({ name: "code-review" as const, location: "/skill", content: skill }),
            }),
            createPinnedGitReader: async () => ({
              pin,
              snapshot: async () => pin,
              resolve: async () => "base",
              range: async () => ({ base: "base", target: "target", diffCommand: "git diff base...target", diffSha256: "a".repeat(64), commits: ["target"] }),
              featureTokens: async () => Object.freeze([]),
              listSpecCandidatePaths: async () => Object.freeze([]),
              originRepository: async () => undefined,
              commitMessagesNewestFirst: async () => Object.freeze([]),
              readPinnedText: async () => undefined,
            }),
            runDispatch: async () => { throw new Error("dispatch must not run for refusal"); },
          }, testHostActions());
        }
        return {
          harness,
          runtime,
          setDecision(next: typeof pass | typeof revise | typeof escalation) { selectedDecision = next; },
          get auditCalls() { return auditCalls; },
        };
      };

      for (const role of ["judge", "fixer", "reviewer", "doctor"] as const) {
        const toolName = role === "judge" ? judgeRole.JUDGE_OUTPUT_TOOL_NAME : role === "fixer" ? workerRole.FIXER_OUTPUT_TOOL_NAME : role === "reviewer" ? reviewerRole.REVIEWER_OUTPUT_TOOL_NAME : doctorRole.DOCTOR_OUTPUT_TOOL_NAME;
        if (role === "fixer" || role === "reviewer") {
          // #242 fixer / #495 S6 reviewer: no soul auditor. Fixer still traverses Gatekeeper; reviewer accepts on typed validate.
          const plain = createRole(role, pass);
          if (role === "reviewer") {
            await plain.runtime.activate(undefined, { baseRevision: "review-base" });
            assert.deepEqual(
              plain.harness.activeTools(),
              ["read", "write", "grep", "find", "bash"],
              "Reviewer activation must preserve Pi's evidence tool surface",
            );
          } else {
            await plain.runtime.activate();
          }
          const tool = plain.harness.tools.get(toolName);
          assert.ok(tool);
          const ctx = role === "fixer"
            ? await withPassingGatekeeper(outputContext(tool.name, `${role}-pass`))
            : outputContext(tool.name, `${role}-pass`, outputs[role] as Record<string, unknown>);
          const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, ctx);
          assert.equal(accepted.terminate, true);
          if (role === "fixer") {
            assert.deepEqual(accepted.details, outputs[role]);
          } else {
            // Reviewer receipt is assembled from ledger + intent; status rides the face.
            assert.equal(accepted.details.status, outputs[role].status);
          }
          assert.equal(plain.auditCalls, 0);
          continue;
        }
        const retriable = createRole(role, revise);
        await retriable.runtime.activate();
        const tool = retriable.harness.tools.get(toolName);
        assert.ok(tool);
        const submissionContext = async (id: string) => {
          const bare = outputContext(tool.name, id, outputs[role] as Record<string, unknown>);
          return role === "judge" ? await withPassingGatekeeper(bare) : bare;
        };
        await assert.rejects(tool.execute(`${role}-revise`, outputs[role], undefined, undefined, await submissionContext(`${role}-revise`)), /violation|violates its|closed contract/);
        retriable.setDecision(pass);
        const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, await submissionContext(`${role}-pass`));
        assert.equal(accepted.terminate, true);
        if (role === "judge") assert.equal(accepted.details.judgeStatus, outputs[role].judgeStatus);
        else assert.equal(accepted.details.status, outputs[role].status);
        assert.deepEqual(accepted.details, outputs[role]);
        assert.equal(retriable.auditCalls, 2, `${role} must audit the rejected submission and its resubmission`);

        const escalated = createRole(role, escalation);
        await escalated.runtime.activate();
        const escalationTool = escalated.harness.tools.get(tool.name);
        const result = await escalationTool.execute(`${role}-escalate`, outputs[role], undefined, undefined, await submissionContext(`${role}-escalate`));
        assert.equal(result.terminate, true);
        // Escalation face carries audit kind/conflicts/gate AND the seat's
        // already-delivered fields (ADR 0055). Old "exactly three keys" deepEqual
        // encoded the destruction this ticket forbids.
        assert.equal(result.details.kind, "audit_escalation");
        assert.deepEqual(result.details.conflicts, escalation.conflicts);
        assert.deepEqual(result.details.auditDecisionGate, escalation.decisionGate);
        for (const [key, value] of Object.entries(outputs[role])) {
          assert.deepEqual(
            (result.details as Record<string, unknown>)[key],
            value,
            `${role} delivered field ${key} must ride the escalate face`,
          );
        }
        assert.equal(isAuditEscalationResult(result.details), true);
        assert.throws(
          () => terminating.validateAcceptedDetails(acceptedNames[role], result.details),
          (error: unknown) => error instanceof Error && error.name === "AcceptedDetailsContractError",
        );
        assert.equal(escalated.auditCalls, 1);
      }
  }
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    nestedLedger.dispose();
  }
});
