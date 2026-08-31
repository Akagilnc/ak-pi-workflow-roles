import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
import { renderGrokSystemPromptOverride } from "../../src/grok/role-turn-host.ts";
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
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

type McpServer = { command: string; args: string[]; env: Array<{ name: string; value: string }> };

async function listThroughMcp(server: McpServer): Promise<Record<string, unknown>> {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    const response = JSON.parse(line.value) as { result?: Record<string, unknown>; error?: unknown };
    assert.equal(response.error, undefined);
    return response.result ?? {};
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

async function callThroughMcp(server: McpServer, name: string, args: unknown): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value) as { result?: Record<string, unknown>; error?: unknown };
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

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
});

test("Grok MCP projection activates shared Judge materials and all active AK tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-envelope-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
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
      assert.ok(prepared.systemPrompt.body.includes("CODER SOUL"));
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

test("public Notary --ticket: admit→activation→agent-start reading material carries typed bound", async () => {
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
      // Agent-start consumption seam: typed readingMaterial from before_agent_start lands
      // in the structured systemPrompt authority (machine face; not prompt text).
      const expectedBound = projectNotarySessionBound({
        sourceRun: admitted.sourceRun,
        ticketNumber: 582,
      });
      assert.deepEqual(prepared.systemPrompt.materials, [expectedBound]);
      assert.equal(
        (prepared.systemPrompt.materials[0] as { ticketNumber?: number }).ticketNumber,
        582,
      );
      // Prove the send path: the provider-visible override folds exactly the typed bound.
      // No free-text / substring / sentinel lock — only the authoritative renderer equality.
      assert.equal(
        renderGrokSystemPromptOverride(prepared.systemPrompt),
        renderGrokSystemPromptOverride({ body: prepared.systemPrompt.body, materials: [expectedBound] }),
      );

      // Session custom entry is the envelope durable twin of the flag-derived bound.
      const sessionFile = join(envelopeRequest.runDirectory, "grok-envelope.jsonl");
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

test("Grok MCP projection executes a terminal submission through the single ledger gate to typed closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-notary-"));
  const priorHome = process.env.HOME;
  const priorRun = process.env.AK_ROLE_RUN_DIR;
  process.env.HOME = root;
  delete process.env.AK_ROLE_RUN_DIR;
  try {
    const socketPath = join(root, "mcp.sock");
    // Production run face is `<runId>@<role>`; settlement reads bare admitted.runId.
    const runId = "01a0551c-77b9-73e5-a62a-61bd812266ac";
    const request = {
      principal: {}, activation: { role: "notary", sourceRun: join(root, "source-run") }, methods: [],
      continuation: { kind: "initial", prompt: "attest" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: process.cwd(), home: root,
      agentDir: join(root, "agent"), runDirectory: join(root, "runs", `${runId}@notary`),
    } as RoleTurnRequest;
    const prepared = await prepareGrokRoleEnvelope({
      request,
      socketPath,
      dependencies: {
        loadNotarySoul: async () => "NOTARY SOUL",
        loadNotarySourceRun: async () => ({ runDirectory: root, runId: "run-1", role: "notary" }),
        loadJudgeSoul: async () => "judge",
        auditSoulCompliance: async () => ({ status: "pass" }),
        activationTraceWriter: async () => {},
      },
    });
    try {
      const server = prepared.mcpServers[0] as McpServer;
      const reply = await callThroughMcp(server, NOTARY_OUTPUT_TOOL_NAME, { status: "pass", findings: [] });
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as { isError?: boolean })?.isError, undefined);
      const closure = await prepared.closeRound();
      assert.deepEqual(closure, { accepted: true });
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
