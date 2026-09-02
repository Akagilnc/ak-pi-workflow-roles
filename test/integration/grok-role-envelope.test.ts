import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
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
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  const priorEngine = process.env.AK_ROLE_ENGINE;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  // Tool-list contract is engine-free; ambient factory AK_ROLE_ENGINE must not leak detour.
  delete process.env.AK_ROLE_ENGINE;
  try {
    const socketPath = join(root, "mcp.sock");
    const request = {
      principal: {}, activation: { role: "judge" }, methods: [],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.6" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: join(root, "runs", "judge-run"),
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
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
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
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const socketPath = join(root, "mcp.sock");
    const taskPath = join(root, "task.md");
    const tddPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
    const request = {
      principal: {}, activation: { role: "coder", phase: "apply", taskPath }, methods: [{ kind: "skill", path: tddPath }],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: join(root, "runs", "coder-run"),
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
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok MCP projection routes a correctable rejection as a structured non-pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-coder-reject-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
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
      agentDir: join(root, "agent"), runDirectory: join(root, "runs", "coder-run"),
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
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("public Notary --ticket: admit→activation→ACP systemPromptOverride folds typed bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-notary-ticket-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
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

      // Session custom entry is the envelope durable twin of the flag-derived bound.
      // Durable principal layout is session/session.jsonl (settlement history face).
      const sessionFile = join(envelopeRequest.runDirectory, "session", "session.jsonl");
      const lines = (await readFile(sessionFile, "utf8"))
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { type?: string; customType?: string; data?: unknown });
      const boundEntry = lines.find(
        (row) => row.type === "custom" && row.customType === NOTARY_SESSION_BOUND_ENTRY,
      );
      assert.ok(boundEntry, "session must retain notary-session-bound custom entry");
      const sessionBound = boundEntry.data as {
        sourceRunPath?: string;
        ticketNumber?: number;
      };
      assert.equal(sessionBound.ticketNumber, 582);
      assert.equal(sessionBound.sourceRunPath, admitted.sourceRunPath);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok MCP projection seals only after closeRound typed boundary; terminal candidate alone does not accept", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-notary-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const socketPath = join(root, "mcp.sock");
    // Production run face is `<runId>@<role>`; settlement reads bare admitted.runId.
    const runId = "01a0551c-77b9-73e5-a62a-61bd812266ac";
    const runDirectory = join(root, "runs", `${runId}@notary`);
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
      // Durable principal layout is seeded at prepare (settlement history / attempt append).
      const sessionPath = join(runDirectory, "session", "session.jsonl");
      const sessionHeader = JSON.parse((await readFile(sessionPath, "utf8")).trim().split("\n")[0]!) as {
        type?: string;
        id?: string;
      };
      assert.equal(sessionHeader.type, "session");
      assert.equal(sessionHeader.id, `${runId}@notary`);

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
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok accepted closeRound books navigator attendance onto parent session for extractNavigatorFact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-nav-books-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const runId = "01a0551c-77b9-73e5-a62a-61bd812266ae";
    const runDirectory = join(root, "runs", `${runId}@notary`);
    const subjectKey = join(root, "work");
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
          subjectKey,
          subject: "navigator book regression",
          authority: "test",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: (options) => ({
          prepare() {},
          setWorkContext() {},
          warmHelp() {},
          isPreparing: () => false,
          settle: async () => {
            const event = {
              version: 1 as const,
              disposition: "no-advice" as const,
              invocationId: options.invocationId,
              role: options.role,
              phase: options.phase,
              subjectKey: options.subjectKey,
            };
            await options.onEvent(event, { disposition: "no-advice" });
          },
          dispose() {},
        }),
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
      assert.equal(reply.error, undefined);
      const closure = await prepared.closeRound();
      assert.deepEqual(closure, { accepted: true });

      const sessionPath = join(runDirectory, "session", "session.jsonl");
      const entries = (await readFile(sessionPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as {
          type?: string;
          customType?: string;
          message?: { details?: unknown };
        });
      const attendance = entries.find(
        (row) => row.type === "custom_message" && row.customType === "ak-navigator-attendance",
      );
      assert.ok(attendance, "accepted grok-build round must book navigator attendance on parent session");
      const fact = extractNavigatorFact(entries as never);
      assert.equal(fact.disposition, "no-advice");
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok prepare keeps existing durable session history on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-resume-session-"));
  const priorHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const runDirectory = join(root, "runs", "resume-run");
    const sessionPath = join(runDirectory, "session", "session.jsonl");
    const subjectKey = join(root, "work");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const priorInvocationId = uuidv7();
    const priorHeader = JSON.stringify({
      type: "session",
      version: 3,
      id: "resume-run",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: process.cwd(),
    });
    // Unfinished marker: same role/phase/subjectKey, no packaged terminal after it.
    const priorMarker = JSON.stringify({
      type: "custom",
      customType: NAVIGATOR_INVOCATION_ENTRY,
      data: {
        invocationId: priorInvocationId,
        role: "judge",
        phase: null,
        subjectKey,
      },
    });
    const priorHistory = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "prior turn" }] },
    });
    const priorBytes = `${priorHeader}\n${priorMarker}\n${priorHistory}\n`;
    await writeFile(sessionPath, priorBytes, "utf8");

    let resumedInvocationId: string | undefined;
    const prepared = await prepareGrokRoleEnvelope({
      request: {
        principal: {}, activation: { role: "judge" }, methods: [],
        continuation: { kind: "resume", prompt: "continue" },
        model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
        agentDir: join(root, "agent"), runDirectory,
      } as RoleTurnRequest,
      socketPath: join(root, "mcp.sock"),
      dependencies: {
        loadJudgeSoul: async () => "JUDGE SOUL",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
        loadNavigatorWorkContext: async () => ({
          subjectKey,
          subject: "resume work",
          authority: "test",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: (options) => {
          resumedInvocationId = options.invocationId;
          return {
            prepare() {},
            setWorkContext() {},
            warmHelp() {},
            isPreparing: () => false,
            settle: async () => {},
            dispose() {},
          };
        },
      },
    });
    try {
      // Bytes preserved through the seeded history; lifecycle may append only after.
      const after = await readFile(sessionPath, "utf8");
      assert.ok(after.startsWith(priorBytes), "resume must keep every prior durable byte");
      // Shared lifecycle reuses the unfinished marker — no second mint.
      assert.equal(resumedInvocationId, priorInvocationId);
      const markerRows = after
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type?: string; customType?: string })
        .filter((row) => row.type === "custom" && row.customType === NAVIGATOR_INVOCATION_ENTRY);
      assert.equal(markerRows.length, 1, "unfinished resume must not re-mint ak-navigator-invocation");
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok delayed sibling after terminal candidate is not early-accepted at closeRound", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-sibling-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const runId = "01a0551c-77b9-73e5-a62a-61bd812266ad";
    const runDirectory = join(root, "runs", `${runId}@notary`);
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
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR; else process.env.AK_ROLE_RUN_DIR = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});
