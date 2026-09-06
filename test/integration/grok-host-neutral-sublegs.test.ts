import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
/**
 * #590 production-deps tracers — separate contracts, shared fixtures.
 * Entry: createGrokRoleRuntimeDependencies (+ Grok envelope for doctor).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import type { DoctorCase } from "../../src/doctor-contracts.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { DOCTOR_CANDIDATE_ENTRY_TYPE, JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";
import { createGrokRoleRuntimeDependencies } from "../../src/grok/production-host.ts";
import { prepareGrokRoleEnvelope } from "../../src/grok/role-envelope.ts";
import type { HostContext, RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runWithAutoResumeLoop } from "../../src/public-cli/auto-resume.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/navigator-session-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { callThroughMcp, listThroughMcp, type GrokMcpServer } from "../helpers/grok-mcp-harness.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";
import { packageRoot, seedGitRepository, withInstitutionalProviderFixture } from "../helpers/pi-test-harness.ts";

const zero = { count: 0, sources: [] as string[] };
function patient(runsPath: string): DoctorCase {
  return {
    version: 1,
    identity: { issueNumber: 28, runsPath },
    evidence: [{
      id: "review/session/live.jsonl",
      kind: "session",
      byteLength: 6,
      contentLength: 2,
      sha256: "abc",
      content: "中文",
    }],
    cost: {
      invocations: zero,
      legs: zero,
      modelApiTurns: zero,
      outputTokens: zero,
      toolCalls: zero,
      retries: { ...zero, evidence: "literal run-dir naming" },
      statuses: [],
      commits: [],
      sessions: [],
      outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" },
    },
  };
}

function hostContext(cwd: string, runDirectory: string, entries: unknown[]): HostContext {
  return {
    cwd,
    mode: "print",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => entries.at(-1) as never,
      getLeafId: () => "leaf",
      getEntries: () => entries as never,
      getSessionDir: () => join(runDirectory, "session"),
      getSessionFile: () => join(runDirectory, "session", "session.jsonl"),
      appendCustomEntry() {},
    },
    abort() {},
  };
}

async function withGrokRoot<T>(run: (ctx: {
  root: string;
  runDirectory: string;
  deps: ReturnType<typeof createGrokRoleRuntimeDependencies>;
}) => Promise<T>): Promise<T> {
  return await withTempRoot("ak-grok-leg-", async (root) => {
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorEngine = process.env.AK_ROLE_ENGINE;
  delete process.env.AK_ROLE_ENGINE;
    return withPrimaryAwareCleanup(
      async () => {

    seedGitRepository(root);
    execFileSync("git", ["-C", root, "config", "user.email", "leg@test.local"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.name", "Leg Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "seed"], { stdio: "ignore" });
    const bookKey = basename(root);
    const runDirectory = join(root, ".ak-roles", "books", bookKey, "runs", "leg");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    process.env.AK_ROLE_RUN_DIR = runDirectory;
    return await run({
      root,
      runDirectory,
      deps: createGrokRoleRuntimeDependencies(packageRoot),
    });
        },
      async () => { if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun; },
      async () => { if (priorEngine === undefined) delete process.env.AK_ROLE_ENGINE; else process.env.AK_ROLE_ENGINE = priorEngine; }
    );
  });
}

test("production Grok deps: public inspector activates with packaged session materials", async () => {
  await withGrokRoot(async ({ root, runDirectory, deps }) => {
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {},
        activation: { role: "inspector" },
        methods: [],
        continuation: { kind: "initial", prompt: "inspect the material" },
        model: { provider: "xai", model: "grok-4.6" },
        cwd: root,
        home: root,
        agentDir: join(root, "agent"),
        runDirectory,
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: deps,
    });
    try {
      const server = prepared.mcpServers[0] as GrokMcpServer;
      const listed = await listThroughMcp(server) as { tools?: Array<{ name: string }> };
      const names = listed.tools?.map(({ name }) => name) ?? [];
      assert.ok(names.includes(INSPECTOR_OUTPUT_TOOL_NAME), `expected ${INSPECTOR_OUTPUT_TOOL_NAME}, got ${JSON.stringify(names)}`);
      const reply = await callThroughMcp(server, INSPECTOR_OUTPUT_TOOL_NAME, {
        status: "pass",
        findings: ["material inspected"],
      });
      assert.equal(reply.error, undefined);
      const result = reply.result as { isError?: boolean; structuredContent?: { submissionDisposition?: unknown } };
      assert.equal(result?.isError, undefined);
      assert.equal(result?.structuredContent?.submissionDisposition, "pending-round-closure");
      assert.equal((await prepared.closeRound()).accepted, true);
    } finally {
      await prepared.dispose?.();
    }
  });
});

test("production Grok deps: judge soul audit institutional child returns typed pass", async () => {
  await withGrokRoot(async ({ root, runDirectory, deps }) => {
    const faux = fauxProvider({ provider: "grok-judge-leg", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection(model.provider, model.id),
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(JUDGE_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        { stopReason: "toolUse" },
      ),
    ]);
    const entries = [
      { type: "message", message: { role: "user", content: "OWNER ASSIGNMENT" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "v1", name: JUDGE_OUTPUT_TOOL_NAME, arguments: { judgeStatus: "converged" } }],
        },
      },
    ];
    await withInstitutionalProviderFixture(faux, async () => {
      const decision = await deps.auditSoulCompliance({
        context: hostContext(root, runDirectory, entries),
      });
      assert.equal(decision.status, "pass");
    });
  });
});

test("production Grok deps: doctor envelope terminal seals after institutional audit pass", async () => {
  await withGrokRoot(async ({ root, runDirectory, deps }) => {
    const runsPath = join(root, "case-runs");
    await mkdir(runsPath, { recursive: true });
    const casePath = join(root, "case.json");
    const caseBody = patient(runsPath);
    await writeFile(casePath, `${JSON.stringify(caseBody)}\n`, "utf8");

    const faux = fauxProvider({ provider: "grok-doctor-leg", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      auditor: seatSelection(model.provider, model.id),
      navigator: seatSelection(model.provider, model.id),
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(DOCTOR_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        { stopReason: "toolUse" },
      ),
    ]);

    let bookedCandidate = false;
    const { createNavigatorAttendance: _nav, ...depsWithoutNavigator } = deps;
    const traced = {
      ...depsWithoutNavigator,
      loadDoctorCase: async () => caseBody,
      async auditDoctorCompliance(options: Parameters<NonNullable<typeof deps.auditDoctorCompliance>>[0]) {
        bookedCandidate = [...options.context.sessionManager.getEntries()].some((entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { customType?: unknown }).customType === DOCTOR_CANDIDATE_ENTRY_TYPE);
        return deps.auditDoctorCompliance!(options);
      },
    };

    await withInstitutionalProviderFixture(faux, async () => {
      const prepared = await prepareGrokRoleEnvelope({
        request: {
          principal: {},
          activation: { role: "doctor", casePath },
          methods: [],
          continuation: { kind: "initial", prompt: "diagnose" },
          model: { provider: model.provider, model: model.id },
          cwd: root,
          home: root,
          agentDir: join(root, "agent"),
          runDirectory,
        } as RoleTurnRequest,
        socketPath: join(root, "mcp.sock"),
        dependencies: traced,
      });
      try {
        const reply = await callThroughMcp(prepared.mcpServers[0] as GrokMcpServer, DOCTOR_OUTPUT_TOOL_NAME, {
          status: "refused",
          reason: "Session bytes are incomplete.",
          missingEvidence: [{ need: "session header", targetKeys: ["case"] }],
        });
        assert.equal(reply.error, undefined);
        const result = reply.result as { isError?: boolean; structuredContent?: { submissionDisposition?: unknown } };
        assert.equal(result?.isError, undefined);
        assert.equal(result?.structuredContent?.submissionDisposition, "pending-round-closure");
        assert.equal(bookedCandidate, true);
        assert.equal((await prepared.closeRound()).accepted, true);
      } finally {
        await prepared.dispose?.();
      }
    });
  });
});

test("production Grok deps: navigator prepare opens institutional child and accepts typed candidates", async () => {
  await withGrokRoot(async ({ root, runDirectory, deps }) => {
    const faux = fauxProvider({ provider: "grok-nav-leg", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      navigator: seatSelection(model.provider, model.id),
    });
    const setting = join(root, "navigator-model.json");
    await writeFile(setting, JSON.stringify({ model: `${model.provider}/${model.id}` }));
    const prepareTurn = fauxAssistantMessage(
      fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
        candidates: [{ next: { role: "coder", phase: "apply" }, reason: "next slice" }],
      }),
      { stopReason: "toolUse" },
    );
    // Queue spare turns: prepare may solicit delivery if the first tool batch is rejected.
    faux.setResponses([prepareTurn, prepareTurn, prepareTurn]);

    await withInstitutionalProviderFixture(faux, async () => {
      const reports: Array<{ disposition?: string; next?: { role?: string; phase?: unknown } }> = [];
      const nav = await deps.createNavigatorAttendance!({
        context: hostContext(root, runDirectory, []),
        role: "coder",
        phase: "apply",
        subjectKey: join(root, "subject"),
        subject: "implement the slice",
        authority: "typed owner authority for navigator prepare",
        invocationId: "inv-nav-leg",
        onEvent: (_event, report) => {
          reports.push(report as { disposition?: string; next?: { role?: string; phase?: unknown } });
        },
      });
      try {
        // Background prepare opens institutional child + prepare tool; settle drains it.
        nav.prepare();
        await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
        const recommendation = reports.find((r) => r.disposition === "recommendation");
        assert.ok(recommendation, `expected recommendation report, got ${JSON.stringify(reports)}`);
        assert.equal(recommendation.next?.role, "coder");
        assert.equal(recommendation.next?.phase, "apply");
      } finally {
        await nav.dispose();
      }
    });
  });
});

test("production Grok deps: reviewer dispatch runs institutional evidence child to successful leg", async () => {
  await withGrokRoot(async ({ root, runDirectory, deps }) => {
    const faux = fauxProvider({ provider: "grok-reviewer-leg", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      evidenceChild: seatSelection(model.provider, model.id),
    });
    faux.setResponses([
      fauxAssistantMessage("Standards review report body with enough substance.", { stopReason: "stop" }),
    ]);

    const objectFormat = execFileSync("git", ["-C", root, "rev-parse", "--show-object-format"], { encoding: "utf8" }).trim() as "sha1" | "sha256";
    const targetHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
    const execution = {
      identity: "four-legs-reviewer",
      recipe: "reviewer-common-bundle-v1" as const,
      targetSnapshot: {
        repositoryRoot: root,
        objectFormat,
        targetHead,
        refs: Object.freeze({}),
      },
      legs: Object.freeze([
        Object.freeze({ axis: "standards" as const, prompt: "Review standards against quality-law." }),
      ]),
    };

    try {
      await withInstitutionalProviderFixture(faux, async () => {
        const outcome = await deps.runReviewerDispatch!(execution, {
          context: hostContext(root, runDirectory, []),
        });
        assert.equal(outcome.legs.standards.status, "successful");
      });
    } finally {
      await deps.shutdownReviewerAgent?.();
    }
  });
});

test("production Grok reviewer one-shot runner is recreated across executeTurn auto-resume", async () => {
  await withGrokRoot(async ({ root, runDirectory, deps }) => {
    const faux = fauxProvider({ provider: "grok-reviewer-resume", api: "openai-completions" });
    const model = faux.getModel();
    await writeInstitutionalSeatTable(runDirectory, {
      evidenceChild: seatSelection(model.provider, model.id),
    });
    faux.setResponses([
      fauxAssistantMessage("Standards review report body with enough substance.", { stopReason: "stop" }),
      fauxAssistantMessage("Second-turn standards review report body with enough substance.", { stopReason: "stop" }),
    ]);

    const objectFormat = execFileSync("git", ["-C", root, "rev-parse", "--show-object-format"], { encoding: "utf8" }).trim() as "sha1" | "sha256";
    const targetHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
    const execution = {
      identity: "auto-resume-reviewer",
      recipe: "reviewer-common-bundle-v1" as const,
      targetSnapshot: {
        repositoryRoot: root,
        objectFormat,
        targetHead,
        refs: Object.freeze({}),
      },
      legs: Object.freeze([
        Object.freeze({ axis: "standards" as const, prompt: "Review standards against quality-law." }),
      ]),
    };

    let turns = 0;
    const host: RoleTurnHost = {
      async executeTurn() {
        turns += 1;
        const outcome = await deps.runReviewerDispatch!(execution, {
          context: hostContext(root, runDirectory, []),
        });
        assert.equal(outcome.legs.standards.status, "successful");
        if (turns === 1) return { code: 1, stderr: "non-lawful", timedOut: false };
        return { code: 0, stderr: "", timedOut: false };
      },
    };

    const sessionFile = join(runDirectory, "session", "session.jsonl");
    await writeFile(sessionFile, "{}\n", "utf8");
    const accepted: TerminalResult = {
      roleOutcome: { kind: "accepted", role: "reviewer", status: "completed", decisiveFacts: {} },
      navigator: { disposition: "no-advice" },
      artifacts: [],
      runId: "auto-resume-reviewer",
    } as unknown as TerminalResult;

    try {
      await withInstitutionalProviderFixture(faux, async () => {
        const result = await runWithAutoResumeLoop({
          principalAuthority: piDurablePrincipalAuthority,
          sessionAppender: appendPiSessionCustomEntry,
          admitted: {
            principal: fixturePrincipal(join(runDirectory, "session"), sessionFile),
            runDirectory,
            role: "reviewer",
            runId: "auto-resume-reviewer",
          },
          io: { stdout() {}, stderr() {} },
          autoResumeLimit: 1,
          buildInitialPayload: () => ["--initial"],
          buildResumePayload: () => ["--resume"],
          dispatch: async (_payload, lease) => {
            try {
              const turn = await host.executeTurn({} as RoleTurnRequest);
              if (turn.code === 0) return { exitCode: 0, terminal: accepted };
              return { exitCode: 1 };
            } finally {
              await lease.release();
            }
          },
        });
        assert.equal(turns, 2);
        assert.equal(result.exitCode, 0);
        assert.equal(result.terminal?.autoResumeCount, 1);
      });
    } finally {
      await deps.shutdownReviewerAgent?.();
    }
  });
});
