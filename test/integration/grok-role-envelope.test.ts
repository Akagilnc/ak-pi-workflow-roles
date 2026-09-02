import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** #604: nest grok run dirs under home/.ak-roles so session path-derive finds package home. */
function grokRunDirectory(home: string, runName: string): string {
  return join(home, ".ak-roles", "books", "grok-test", "runs", runName);
}

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { DOCTOR_OUTPUT_TOOL_NAME, type DoctorCase } from "../../src/doctor-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import {
  NOTARY_SESSION_BOUND_ENTRY,
  projectNotarySessionBound,
} from "../../src/notary-role.ts";
import { loadNotarySourceRunLocator } from "../../src/notary-source-run.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { loadPackagedCanonicalSkillBinding } from "../../src/package-resources/method-skill-binding.ts";
import { resolvePackagedMethodSkillPath, stripSkillFrontmatter } from "../../src/package-resources/method-skill.ts";
import { buildGrokSkillExpansion, prepareGrokRoleEnvelope, projectGrokActivationFlags } from "../../src/grok/role-envelope.ts";
import { NAVIGATOR_INVOCATION_ENTRY } from "../../src/navigator-invocation-identity.ts";
import { uuidv7 } from "../../src/uuidv7.ts";
import { createGrokRoleTurnHost } from "../../src/grok/role-turn-host.ts";
import {
  issuePiDurablePrincipalCoordinates,
  piDurablePrincipalAuthority,
} from "../../src/pi/durable-principal.ts";
import {
  admitNotaryInvocation,
  buildNotaryTransportPrompt,
  parseNotaryArgv,
} from "../../src/public-cli/invocation.ts";
import { buildNotaryTurnRequest } from "../../src/public-cli/notary-run.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { extractNavigatorFact } from "../../src/public-cli/settlement.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import { callThroughMcp, listThroughMcp, type GrokMcpServer } from "../helpers/grok-mcp-harness.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

type McpServer = GrokMcpServer;

test("Grok projection maps public activations onto the shared envelope", () => {
  const activations: RoleTurnRequest["activation"][] = [
    { role: "judge" },
    { role: "fixer", phase: "apply", packetPath: "/fix", prerequisitesPath: "/prereqs" },
    { role: "coder", phase: "plan", taskPath: "/task" },
    { role: "reviewer", baseRevision: "base", authorityRefs: ["issue:1"], ticketNumber: 1 },
    { role: "collector", repo: "owner/repo", pr: "2", requestManifestPath: "/manifest" },
    { role: "doctor", casePath: "/case" },
    { role: "merger", inputPath: "/merge" },
    { role: "notary", sourceRun: "/source" },
    { role: "countersign", ticketNumber: 582 },
    { role: "gleaner-left", baseRevision: "HEAD" },
    { role: "inspector" },
  ];
  for (const activation of activations) {
    const flags = projectGrokActivationFlags({ activation } as RoleTurnRequest);
    assert.equal(flags.get("ak-role"), activation.role);
  }
  assert.equal(projectGrokActivationFlags({ activation: activations[1]! } as RoleTurnRequest).get("ak-fixer-prerequisites"), "/prereqs");
  assert.equal(projectGrokActivationFlags({ activation: activations[3]! } as RoleTurnRequest).get("ak-review-authority-refs"), JSON.stringify(["issue:1"]));
  assert.equal(projectGrokActivationFlags({ activation: activations[4]! } as RoleTurnRequest).get("ak-collector-request-manifest"), "/manifest");
  assert.equal(
    projectGrokActivationFlags({ activation: activations[8]! } as RoleTurnRequest).get(
      "ak-countersign-ticket-number",
    ),
    "582",
  );
  assert.equal(
    projectGrokActivationFlags({
      activation: { role: "countersign" },
    } as RoleTurnRequest).has("ak-countersign-ticket-number"),
    false,
  );
  assert.equal(
    projectGrokActivationFlags({
      activation: { role: "gleaner-left", baseRevision: "HEAD" },
    } as RoleTurnRequest).get("ak-gleaner-left-base"),
    "HEAD",
  );
});

test("Grok MCP projection activates shared Judge materials and all active AK tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-envelope-"));
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorEngine = process.env.AK_ROLE_ENGINE;
  delete process.env.AK_ROLE_RUN_DIR;
  // Tool-list contract is engine-free; ambient factory AK_ROLE_ENGINE must not leak detour.
  delete process.env.AK_ROLE_ENGINE;
  try {
    const socketPath = join(root, "mcp.sock");
    const request = {
      principal: {}, activation: { role: "judge" }, methods: [],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.6" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, "judge-run"),
    } as RoleTurnRequest;
    const prepared = await prepareGrokRoleEnvelope({
      request,
      socketPath,
      dependencies: {
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const listed = await listThroughMcp(server) as { tools?: Array<{ name: string }> };
      const names = listed.tools?.map(({ name }) => name) ?? [];
      // Judge output is required; shared envelope may also register engine detour.
      assert.ok(names.includes(JUDGE_OUTPUT_TOOL_NAME));
      assert.equal(names.filter((name) => name === JUDGE_OUTPUT_TOOL_NAME).length, 1);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    if (priorEngine === undefined) delete process.env.AK_ROLE_ENGINE; else process.env.AK_ROLE_ENGINE = priorEngine;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok Skill expansion evidence aligns with the packaged canonical binding", async () => {
  const tddPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
  const raw = await readFile(tddPath, "utf8");
  const methodSkills = new Map([["tdd", { path: tddPath, body: stripSkillFrontmatter(raw).trim() }]]);
  const evidence = buildGrokSkillExpansion(methodSkills, "/skill:tdd decide");
  const binding = await loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
  assert.notEqual(binding.captureExpansion(evidence, "decide"), undefined);
});

test("Grok MCP projection expands the canonical Coder tdd Skill from typed methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-coder-"));
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const socketPath = join(root, "mcp.sock");
    const taskPath = join(root, "task.md");
    const tddPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
    const request = {
      principal: {}, activation: { role: "coder", phase: "apply", taskPath }, methods: [{ kind: "skill", path: tddPath }],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, "coder-run"),
    } as RoleTurnRequest;
    const prepared = await prepareGrokRoleEnvelope({
      request,
      socketPath,
      dependencies: {
        loadCoderSoul: async () => "CODER SOUL",
        loadCoderTask: async () => "implement the plan",
        loadCanonicalSkillBinding: async (name) =>
          name === "tdd"
            ? loadPackagedCanonicalSkillBinding(packageRoot, "tdd")
            : loadPackagedCanonicalSkillBinding(packageRoot, "code-review"),
        loadJudgeSoul: async () => "judge",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      // The shared input transform rewrites the prompt to the canonical Skill invocation.
      assert.equal(prepared.prompt, "/skill:tdd decide");
      // Coder agent-start carries no typed reading materials on this path.
      assert.deepEqual(prepared.systemPrompt.materials, []);
      assert.equal(typeof prepared.systemPrompt.body, "string");
      assert.ok(prepared.systemPrompt.body.length > 0);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok typed infrastructureFailure aborts the round and closeRound returns knownFailure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-infra-fail-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorExitCode = process.exitCode;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const diagnostic = "劳务引擎 agy authentication timed out (case #593)";
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "judge" }, methods: [],
        continuation: { kind: "initial", prompt: "decide" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, "judge-infra"),
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: {
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      assert.ok(prepared.abortSignal instanceof AbortSignal);
      assert.equal(prepared.abortSignal.aborted, false);

      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, JUDGE_OUTPUT_TOOL_NAME, {
        infrastructureFailure: { diagnostic },
      });
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as { isError?: boolean })?.isError, true);

      // failInfrastructure must actually abort the host context — not empty abort(){}.
      assert.equal(prepared.abortSignal.aborted, true);

      const closure = await prepared.closeRound();
      assert.equal(closure.accepted, false);
      assert.ok("failure" in closure, "infrastructure declaration must not fall to MissingSubmission or retry");
      assert.equal(closure.failure.identity?.name, "InfrastructureFailure");
      assert.equal(closure.failure.diagnostic, diagnostic);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    // failInfrastructure stamps exitCode=1 under print mode; restore for the test process.
    process.exitCode = priorExitCode;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok infra abort fills knownFailure before hanging tool_result projection so closeRound cannot race MissingSubmission", async () => {
  // #593 r3 finding 1: hostAbort must not win an empty infrastructureRoundFailure slot
  // while tool_result projection (navigator settle) is still in flight.
  const root = await mkdtemp(join(tmpdir(), "ak-grok-infra-race-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorExitCode = process.exitCode;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const diagnostic = "infra abort/projection race (#593 r3)";
    let releaseSettle!: () => void;
    const settleHang = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "judge" }, methods: [],
        continuation: { kind: "initial", prompt: "decide" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, "judge-infra-race"),
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: {
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
        loadNavigatorWorkContext: async () => ({
          subjectKey: join(root, "work"),
          subject: "infra race regression",
          authority: "test",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: () => ({
          prepare() {},
          setWorkContext() {},
          warmHelp() {},
          isPreparing: () => false,
          settle: async () => settleHang,
          dispose() {},
        }),
      },
    });
    try {
      assert.ok(prepared.abortSignal instanceof AbortSignal);
      assert.equal(prepared.abortSignal.aborted, false);

      // closeRound on abort — mirrors role-turn-host host-aborted path racing projection.
      const closeOnAbort = new Promise<Awaited<ReturnType<typeof prepared.closeRound>>>((resolve, reject) => {
        prepared.abortSignal!.addEventListener("abort", () => {
          void prepared.closeRound().then(resolve, reject);
        }, { once: true });
      });

      const server = prepared.mcpServers[0] as McpServer;
      const mcpPromise = callThroughMcp(server, JUDGE_OUTPUT_TOOL_NAME, {
        infrastructureFailure: { diagnostic },
      });

      const closure = await closeOnAbort;
      assert.equal(closure.accepted, false);
      assert.ok("failure" in closure, "closeRound during hung projection must not fall to MissingSubmission");
      assert.equal(closure.failure.identity?.name, "InfrastructureFailure");
      assert.equal(closure.failure.diagnostic, diagnostic);

      releaseSettle();
      const reply = await mcpPromise;
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as { isError?: boolean })?.isError, true);
    } finally {
      releaseSettle?.();
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok pre-execution observation failure terminates as typed InfrastructureFailure not MissingSubmission", async () => {
  // #593 r3 finding 2: tool_execution_start / tool_call throws must share the same
  // non-correctable infra pathway (slot + hostAbort), not bare outer RPC only.
  const root = await mkdtemp(join(tmpdir(), "ak-grok-preexec-infra-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorExitCode = process.exitCode;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const diagnostic = "observation writer failed at tool_execution_start (#593 r3)";
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "judge" }, methods: [],
        continuation: { kind: "initial", prompt: "decide" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, "judge-preexec-infra"),
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: {
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
        toolExecutionObservationWriter: async () => {
          throw new Error(diagnostic);
        },
      },
    });
    try {
      assert.ok(prepared.abortSignal instanceof AbortSignal);
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, JUDGE_OUTPUT_TOOL_NAME, {
        judgeStatus: "continue",
        fixSummary: "x",
        classes: [{ name: "c", owner: "o", boundary: "b", disposition: "d" }],
        classCount: 1,
        note: "n",
        evidence: "e",
      });
      // Structured infra reply preferred over bare RPC error; either way abort must arm.
      assert.equal(prepared.abortSignal.aborted, true);

      const closure = await prepared.closeRound();
      assert.equal(closure.accepted, false);
      assert.ok("failure" in closure, "pre-execution emit failure must not fall to MissingSubmission");
      assert.equal(closure.failure.identity?.name, "InfrastructureFailure");
      assert.equal(closure.failure.diagnostic, diagnostic);
      // Reply should carry structured infra when projection path is reachable.
      if (reply.error === undefined) {
        assert.equal((reply.result as { isError?: boolean })?.isError, true);
      }
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok MCP projection routes a correctable rejection as a structured non-pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-coder-reject-"));
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const socketPath = join(root, "mcp.sock");
    const taskPath = join(root, "task.md");
    // Method path whose body disagrees with the packaged canonical binding, so
    // expansion capture fails and the completed apply rejects as correctable.
    const wrongTddPath = join(root, "tdd", "SKILL.md");
    await mkdir(join(root, "tdd"), { recursive: true });
    await writeFile(wrongTddPath, "WRONG TDD BODY\n");
    const request = {
      principal: {}, activation: { role: "coder", phase: "apply", taskPath }, methods: [{ kind: "skill", path: wrongTddPath }],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, "coder-run"),
    } as RoleTurnRequest;
    const prepared = await prepareGrokRoleEnvelope({
      request,
      socketPath,
      dependencies: {
        loadCoderSoul: async () => "CODER SOUL",
        loadCoderTask: async () => "implement the plan",
        loadCanonicalSkillBinding: async (name) =>
          name === "tdd"
            ? loadPackagedCanonicalSkillBinding(packageRoot, "tdd")
            : loadPackagedCanonicalSkillBinding(packageRoot, "code-review"),
        loadJudgeSoul: async () => "judge",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, CODER_OUTPUT_TOOL_NAME, { status: "completed", report: "done" });
      assert.equal(reply.error, undefined);
      const structured = (reply.result as { structuredContent?: Record<string, unknown> })?.structuredContent;
      assert.equal(structured?.code, "coder_skill_expansion_evidence_missing");
      assert.equal((reply.result as { isError?: boolean })?.isError, true);
      // Branded correctable must not arm hostAbort (#593 r3: slot-before-abort must not
      // swallow bindSubmissionNonPass throws that the same session may correct).
      assert.equal(prepared.abortSignal?.aborted, false);
      // Real envelope closeRound must surface the same correctable rejection as retry
      // so executeTurn can re-prompt in the same ACP session (P3 sole-final bounce).
      const closure = await prepared.closeRound();
      assert.equal(closure.accepted, false);
      assert.ok("retry" in closure, "correctable non-pass must not fall to MissingSubmission");
      assert.equal(closure.retry.code, "coder_skill_expansion_evidence_missing");
      assert.equal(closure.retry.toolCallIds.length, 1);
      assert.equal(typeof closure.retry.toolCallIds[0], "string");
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("public Notary --ticket: admit→activation→ACP systemPromptOverride folds typed bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-notary-ticket-"));
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    // Real public admission needs a git project book + retained source-run under ledger.
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "notary@test.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Notary Test"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });

    const sourceRunId = "01a034f1-75bf-71a6-bcf5-d1299145b1a5";
    const sourceRole = "judge" as const;
    const sourceCoords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId: sourceRunId,
      role: sourceRole,
      home: root,
    });
    await mkdir(sourceCoords.sessionDirectory, { recursive: true });
    const sourceAdmittedPath = join(sourceCoords.runDirectory, "admitted-request.json");
    await writeFile(
      sourceCoords.sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "draft" } })}\n`,
      "utf8",
    );
    await writeFile(
      sourceAdmittedPath,
      `${JSON.stringify({ role: sourceRole, runId: sourceRunId })}\n`,
      "utf8",
    );
    await writeRoleRunState(sourceCoords.runDirectory, {
      runId: sourceRunId,
      role: sourceRole,
      state: "terminal",
      bookKey: sourceCoords.bookKey,
      projectRoot: project,
      sessionDirectory: sourceCoords.sessionDirectory,
      sessionFile: sourceCoords.sessionFile,
      admittedRequestPath: sourceAdmittedPath,
    });
    const sourceRunPath = await realpath(sourceCoords.runDirectory);

    // Public argv → admit (typed --ticket) → turn request → envelope agent-start.
    const parsed = parseNotaryArgv([
      "--source-run",
      sourceRunPath,
      "--ticket",
      "582",
    ]);
    assert.equal(parsed.ticket, 582);
    const notaryRunId = "01a0551c-77b9-73e5-a62a-61bd812266ad";
    const admitted = await admitNotaryInvocation({
      home: root,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      sourceRun: parsed.sourceRun,
      ticket: parsed.ticket,
      createRunId: () => notaryRunId,
    });
    assert.equal(admitted.ticketNumber, 582);
    assert.equal(admitted.sourceRunPath, sourceRunPath);

    // Kickoff ignores ticketNumber — no free-text parallel copy.
    const kickoffBound = buildNotaryTransportPrompt(admitted);
    const { ticketNumber: _omitTicket, ...admittedUnbound } = admitted;
    assert.equal(kickoffBound, buildNotaryTransportPrompt(admittedUnbound));

    const request = buildNotaryTurnRequest(admitted, {
      packageRoot,
      home: root,
      agentDir: join(root, "agent"),
      continuation: { kind: "initial", prompt: kickoffBound },
    });
    assert.equal(request.activation.role, "notary");
    assert.equal(
      "ticketNumber" in request.activation ? request.activation.ticketNumber : undefined,
      582,
    );
    const envelopeRequest: RoleTurnRequest = {
      ...request,
      model: { provider: "xai", model: "grok-4.5" },
    };

    const socketPath = join(root, "mcp.sock");
    const prepared = await prepareGrokRoleEnvelope({
      request: envelopeRequest,
      socketPath,
      dependencies: {
        loadNotarySoul: async () => "NOTARY SOUL",
        // Real activation loader — same retained source-run admission resolved.
        loadNotarySourceRun: loadNotarySourceRunLocator,
        loadJudgeSoul: async () => "judge",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      // Structured authority after real admit→activation→agent-start (typed bound, not prompt text).
      const expectedBound = projectNotarySessionBound({
        sourceRun: admitted.sourceRun,
        ticketNumber: 582,
      });
      assert.deepEqual(prepared.systemPrompt.materials, [expectedBound]);

      // Provider send boundary: capture ACP systemPromptOverride under controlled materials.
      // Observation is differential (not renderer self-compare): materials must change the wire
      // form; empty materials must passthrough body; distinct materials must differ.
      // closeRound stubbed — this probe is the systemPromptOverride seam only.
      async function captureOverride(
        materials: readonly unknown[],
      ): Promise<unknown> {
        const sessionIds = new WeakMap<object, string>();
        const acpCalls: Array<[string, unknown]> = [];
        const host = createGrokRoleTurnHost({
          sessionIdentity: {
            async load(principal) {
              return sessionIds.get(principal);
            },
            async bind(principal, sessionId) {
              sessionIds.set(principal, sessionId);
            },
            resolveSessionFile(principal) {
              const record = principal as { sessionFile?: unknown; sessionDirectory?: unknown };
              if (typeof record.sessionFile === "string" && record.sessionFile.trim() !== "") {
                return record.sessionFile;
              }
              if (typeof record.sessionDirectory === "string" && record.sessionDirectory.trim() !== "") {
                return join(record.sessionDirectory, "session.jsonl");
              }
              return join(request.runDirectory, "session", "session.jsonl");
            },
          },
          recordCapabilities: async () => {},
          connect: async () => ({
            async request(method, params) {
              acpCalls.push([method, params]);
              if (method === "initialize") {
                return {
                  _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } },
                };
              }
              if (method === "session/new") return { sessionId: `notary-${acpCalls.length}` };
              if (method === "session/prompt") return { stopReason: "end_turn" };
              return {};
            },
            notify() {},
            async close() {},
          }),
          inspect: async () => ({
            privateActive: [],
            akActive: [NOTARY_OUTPUT_TOOL_NAME],
          }),
          prepare: async () => ({
            ...prepared,
            systemPrompt: { body: prepared.systemPrompt.body, materials },
            closeRound: async () => ({ accepted: true as const }),
          }),
        });
        // Fresh principal each capture so session identity does not resume.
        const turnRequest = { ...envelopeRequest, principal: {} };
        assert.deepEqual(await host.executeTurn(turnRequest), {
          code: 0,
          stderr: "",
          timedOut: false,
        });
        const sessionNew = acpCalls.find(([method]) => method === "session/new")?.[1] as
          | { _meta?: { systemPromptOverride?: unknown } }
          | undefined;
        return sessionNew?._meta?.systemPromptOverride;
      }

      const overrideWithBound = await captureOverride(prepared.systemPrompt.materials);
      const overrideEmpty = await captureOverride([]);
      const otherBound = projectNotarySessionBound({
        sourceRun: admitted.sourceRun,
        ticketNumber: 999,
      });
      const overrideOtherTicket = await captureOverride([otherBound]);

      assert.equal(overrideEmpty, prepared.systemPrompt.body);
      assert.notEqual(overrideWithBound, overrideEmpty);
      assert.notEqual(overrideWithBound, overrideOtherTicket);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok MCP projection seals only after closeRound typed boundary; terminal candidate alone does not accept", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-notary-"));
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const socketPath = join(root, "mcp.sock");
    // Production run face is `<runId>@<role>`; settlement reads bare admitted.runId.
    const runId = "01a0551c-77b9-73e5-a62a-61bd812266ac";
    const runDirectory = grokRunDirectory(root, `${runId}@notary`);
    const request = {
      principal: {}, activation: { role: "notary", sourceRun: join(root, "source-run") }, methods: [],
      continuation: { kind: "initial", prompt: "attest" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory,
    } as RoleTurnRequest;

    let settleCount = 0;

    const prepared = await prepareGrokRoleEnvelope({
      request,
      socketPath,
      dependencies: {
        loadNotarySoul: async () => "NOTARY SOUL",
        loadNotarySourceRun: async () => ({ runDirectory: root, runId: "run-1", role: "notary" }),
        loadJudgeSoul: async () => "judge",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
        loadNavigatorWorkContext: async () => ({
          subjectKey: join(root, "work"),
          subject: "envelope seal regression",
          authority: "test",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: () => ({
          prepare() {},
          setWorkContext() {},
          warmHelp() {},
          isPreparing: () => false,
          settle: async () => { settleCount += 1; },
          dispose() {},
        }),
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as { isError?: boolean })?.isError, undefined);
      const disposition = (reply.result as { structuredContent?: { submissionDisposition?: unknown } })?.structuredContent?.submissionDisposition;
      assert.equal(disposition, "pending-round-closure");

      // Candidate after tool path must not seal: no settle, no ledger accept.
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settleCount, 0);
      assert.equal(await readSealedSubmission(process.cwd(), runId, root), undefined);

      const closure = await prepared.closeRound();
      assert.deepEqual(closure, { accepted: true });
      assert.equal(settleCount, 1);

      // Settlement seam: bare runId must resolve the sealed projection written under
      // AK_ROLE_RUN_DIR → runIdFromRunDirectory identity (not session header `<uuid>@role`).
      const sealed = await readSealedSubmission(process.cwd(), runId, root);
      assert.equal(sealed?.kind, "accepted");
      assert.equal(sealed?.role, "notary");
      assert.equal(sealed?.status, "pass");
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok delayed sibling after terminal candidate is not early-accepted at closeRound", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-sibling-"));
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const runId = "01a0551c-77b9-73e5-a62a-61bd812266ad";
    const runDirectory = grokRunDirectory(root, `${runId}@notary`);
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "notary", sourceRun: join(root, "source-run") }, methods: [],
        continuation: { kind: "initial", prompt: "attest" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory,
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: {
        loadNotarySoul: async () => "NOTARY SOUL",
        loadNotarySourceRun: async () => ({ runDirectory: root, runId: "run-1", role: "notary" }),
        loadJudgeSoul: async () => "judge",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
        loadNavigatorWorkContext: async () => ({
          subjectKey: join(root, "work"),
          subject: "sibling round",
          authority: "test",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: () => ({
          prepare() {},
          setWorkContext() {},
          warmHelp() {},
          isPreparing: () => false,
          settle: async () => {},
          dispose() {},
        }),
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const terminal = await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
      assert.equal(terminal.error, undefined);
      assert.equal(
        (terminal.result as { structuredContent?: { submissionDisposition?: unknown } })?.structuredContent?.submissionDisposition,
        "pending-round-closure",
      );

      const sibling = await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
      assert.equal(sibling.error, undefined);

      const closure = await prepared.closeRound();
      assert.equal(closure.accepted, false);
      assert.ok("retry" in closure);
      assert.equal(closure.retry.code, "non-sole-round");
      assert.equal(closure.retry.toolCallIds.length, 2);
      assert.equal(await readSealedSubmission(process.cwd(), runId, root), undefined);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("real-seam: non-sole submit triggers turn_end rejection, closeRound retries, and re-prompt succeeds in same ACP session", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-real-seam-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const runId = "01a034f1-75bf-71a6-bcf5-d1299145b1a6";
    const socketPath = join(root, "mcp.sock");
    const request = {
      principal: {}, activation: { role: "notary", sourceRun: "/source" }, methods: [],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, `${runId}@notary`),
    } as RoleTurnRequest;
    const prompts: Array<Readonly<Record<string, unknown>>> = [];
    let promptCount = 0;
    let preparedInstance: import("../../src/grok/role-turn-host.ts").GrokPreparedTurn | undefined;
    const host = createGrokRoleTurnHost({
      sessionIdentity: {
        load: async () => undefined,
        bind: async () => {},
        resolveSessionFile: () => join(request.runDirectory, "session", "session.jsonl"),
      },
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          if (method === "session/new") return { sessionId: "real-seam-session" };
          if (method === "session/prompt") {
            prompts.push(params);
            promptCount += 1;
            const server = preparedInstance!.mcpServers[0] as McpServer;
            if (promptCount === 1) {
              // Round 1: non-sole submission (two terminal tool calls)
              await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
              await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
              return { stopReason: "end_turn" };
            }
            if (promptCount === 2) {
              // Round 2 (retry): sole terminal tool call
              await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
              return { stopReason: "end_turn" };
            }
          }
          if (method === "session/close") return {};
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_notary_output"] }),
      prepare: async (req) => {
        const prep = await prepareGrokRoleEnvelope({
          request: req,
          socketPath,
          dependencies: {
            loadJudgeSoul: async () => "JUDGE SOUL",
            auditSoulCompliance: async () => ({ status: "pass" }),
            loadNotarySoul: async () => "NOTARY SOUL",
            loadNotarySourceRun: async () => ({ runDirectory: root, runId, role: "notary" }),
            createNavigatorAttendance: () => ({
              prepare() {},
              setWorkContext() {},
              warmHelp() {},
              isPreparing: () => false,
              settle: async () => {},
              dispose() {},
            }),
          },
        });
        preparedInstance = prep;
        return prep;
      },
    });

    const result = await host.executeTurn(request);
    assert.equal(result.code, 0);
    assert.equal(result.knownFailure, undefined);
    assert.equal(prompts.length, 2);
    assert.equal((prompts[0] as { sessionId: string }).sessionId, "real-seam-session");
    assert.equal((prompts[1] as { sessionId: string }).sessionId, "real-seam-session");
    assert.ok(await readSealedSubmission(process.cwd(), runId, root) !== undefined);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok MCP projection extracts typed evidence keys from failInfrastructure thrown error", async () => {
  // Doctor has no gatekeeper-before-audit: auditCompliance throw reaches failInfrastructure
  // with the original error, so closeRound.details must carry NAVIGATOR evidence keys.
  const root = await mkdtemp(join(tmpdir(), "ak-grok-infra-evidence-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorExitCode = process.exitCode;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const runId = "01a034f1-75bf-71a6-bcf5-d1299145b1a7";
    const runDir = grokRunDirectory(root, `${runId}@doctor`);
    const casePath = join(root, "case.json");
    const zero = { count: 0, sources: [] as string[] };
    const patient: DoctorCase = {
      version: 1,
      identity: { issueNumber: 593, runsPath: join(root, "case-runs") },
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
    const diagnostic = "doctor audit provider unavailable with typed evidence (#593)";
    const evidenceError = Object.assign(new Error(diagnostic), {
      name: "InfrastructureFailure",
      stage: "doctor-audit",
      reason: "timeout",
      submission: { case: patient.identity },
      observation: "provider stream stalled",
      candidate: null,
    });
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "doctor", casePath }, methods: [],
        continuation: { kind: "initial", prompt: "testify" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory: runDir,
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: {
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        loadDoctorSoul: async () => "DOCTOR SOUL",
        loadDoctorCase: async () => patient,
        auditDoctorCompliance: async () => { throw evidenceError; },
        activationTraceWriter: async () => {},
      },
    });
    try {
      assert.ok(prepared.abortSignal instanceof AbortSignal);
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, DOCTOR_OUTPUT_TOOL_NAME, {
        status: "completed",
        case: patient.identity,
        findings: [],
      });
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as { isError?: boolean })?.isError, true);
      assert.equal(prepared.abortSignal.aborted, true);

      const closure = await prepared.closeRound();
      assert.equal(closure.accepted, false);
      assert.ok("failure" in closure, "evidence-bearing infra throw must not fall to retry or MissingSubmission");
      assert.equal(closure.failure.identity?.name, "InfrastructureFailure");
      assert.equal(closure.failure.diagnostic, diagnostic);
      const details = closure.failure.details as Record<string, unknown> | undefined;
      assert.ok(details !== undefined);
      assert.equal(details.kind, "role_infrastructure_failure");
      assert.equal(details.source, "shared-role-lifecycle");
      assert.equal(details.reasonCode, "host_failure");
      assert.equal(details.stage, "doctor-audit");
      assert.equal(details.reason, "timeout");
      assert.deepEqual(details.submission, { case: patient.identity });
      assert.equal(details.observation, "provider stream stalled");
      assert.equal(details.candidate, null);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    process.exitCode = priorExitCode;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok MCP projection routes thrown correctable submission error as retry without arming infrastructure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-worker-reminder-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const runId = "01a034f1-75bf-71a6-bcf5-d1299145b1a8";
    const socketPath = join(root, "mcp.sock");
    const taskPath = join(root, "task.md");
    await writeFile(taskPath, "TASK");
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "coder", phase: "plan", taskPath }, methods: [],
        continuation: { kind: "initial", prompt: "decide" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory: grokRunDirectory(root, `${runId}@coder`),
      } as RoleTurnRequest,
      socketPath,
      dependencies: {
        loadCoderSoul: async () => "CODER SOUL",
        loadCoderTask: async () => "implement plan",
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      // In plan phase, completed requires plan report
      const reply = await callThroughMcp(server, CODER_OUTPUT_TOOL_NAME, { status: "completed", report: "" });
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as { isError?: boolean })?.isError, true);
      assert.equal(prepared.abortSignal?.aborted, false);

      const closure = await prepared.closeRound();
      assert.equal(closure.accepted, false);
      assert.ok("retry" in closure, "thrown correctable reminder must route to retry");
      assert.equal(closure.retry.toolCallIds.length, 1);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});
