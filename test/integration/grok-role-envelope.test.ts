import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { loadPackagedCanonicalSkillBinding } from "../../src/package-resources/method-skill-binding.ts";
import { resolvePackagedMethodSkillPath, stripSkillFrontmatter } from "../../src/package-resources/method-skill.ts";
import { buildGrokSkillExpansion, prepareGrokRoleEnvelope, projectGrokActivationFlags } from "../../src/grok/role-envelope.ts";
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

test("Grok projection maps all eight public activations onto the shared envelope", () => {
  const activations: RoleTurnRequest["activation"][] = [
    { role: "judge" },
    { role: "fixer", phase: "apply", packetPath: "/fix", prerequisitesPath: "/prereqs" },
    { role: "coder", phase: "plan", taskPath: "/task" },
    { role: "reviewer", baseRevision: "base", authorityRefs: ["issue:1"], ticketNumber: 1 },
    { role: "collector", repo: "owner/repo", pr: "2", requestManifestPath: "/manifest" },
    { role: "doctor", casePath: "/case" },
    { role: "merger", inputPath: "/merge" },
    { role: "notary", sourceRun: "/source" },
  ];
  for (const activation of activations) {
    const flags = projectGrokActivationFlags({ activation } as RoleTurnRequest);
    assert.equal(flags.get("ak-role"), activation.role);
  }
  assert.equal(projectGrokActivationFlags({ activation: activations[1]! } as RoleTurnRequest).get("ak-fixer-prerequisites"), "/prereqs");
  assert.equal(projectGrokActivationFlags({ activation: activations[3]! } as RoleTurnRequest).get("ak-review-authority-refs"), JSON.stringify(["issue:1"]));
  assert.equal(projectGrokActivationFlags({ activation: activations[4]! } as RoleTurnRequest).get("ak-collector-request-manifest"), "/manifest");
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
      assert.deepEqual(listed.tools?.map(({ name }) => name), [JUDGE_OUTPUT_TOOL_NAME]);
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
      assert.ok(prepared.systemPrompt.includes("CODER SOUL"));
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

test("Grok prepare keeps existing durable session history on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-resume-session-"));
  const priorHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const runDirectory = join(root, "runs", "resume-run");
    const sessionPath = join(runDirectory, "session", "session.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const priorHeader = JSON.stringify({
      type: "session",
      version: 3,
      id: "resume-run",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: process.cwd(),
    });
    const priorHistory = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "prior turn" }] },
    });
    const priorBytes = `${priorHeader}\n${priorHistory}\n`;
    await writeFile(sessionPath, priorBytes, "utf8");

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
      },
    });
    try {
      assert.equal(await readFile(sessionPath, "utf8"), priorBytes);
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
