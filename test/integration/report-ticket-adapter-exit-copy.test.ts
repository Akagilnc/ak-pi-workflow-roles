/**
 * #1171 — true adapter entry (createHeadlessRoleTurnHost / createAcpRoleTurnHost)
 * after mid-turn ak_report_ticket: exit-copy + turn records land under the live
 * ticket leaf; unbound must not be revived. Fake host only — no LLM.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { REPORT_TICKET_TOOL_NAME } from "../../src/report-ticket-tool.ts";
import { sessionDirectoryOf, sessionFileOf } from "../../src/role-run-placement.ts";
import { resolveHostDossierLandingPath } from "../../src/host-session-record.ts";
import { seedCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const TICKET = 1171;
const SESSION_ID = "ak-1171-adapter-sid";

const claudeDescription: HeadlessHostDescription = Object.freeze({
  protocol: "claude-print",
  binaryFromHome: Object.freeze(["bin", "fake-claude"]),
  fixedArgs: Object.freeze(["--output-format", "stream-json", "--verbose"]),
  promptFlag: "-p",
  modelFlag: "--model",
  effortFlag: "--effort",
  systemPromptFlag: "--system-prompt-file",
  jsonSchemaFlag: "--json-schema",
  mcpConfigFlag: "--mcp-config",
  sessionIdFlag: "--session-id",
  resumeFlag: "--resume",
});

async function callMcpTool(input: {
  readonly socketPath: string;
  readonly token: string;
  readonly name: string;
  readonly args: unknown;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = connect(input.socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      if (!buf.includes("\n")) return;
      sock.destroy();
      const reply = JSON.parse(buf.split("\n")[0]!) as { error?: unknown };
      if (reply.error !== undefined) reject(new Error(JSON.stringify(reply.error)));
      else resolve();
    });
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: 1,
          token: input.token,
          method: "tools/call",
          params: { name: input.name, arguments: input.args },
        })}\n`,
      );
    });
  });
}

function mcpTokenFromPrepared(prepared: { mcpServers: readonly unknown[] }): string {
  const envRows = (prepared.mcpServers[0] as { env?: Array<{ name: string; value: string }> } | undefined)
    ?.env ?? [];
  const token = envRows.find((row) => row.name === "AK_ACP_MCP_TOKEN")?.value;
  assert.ok(token, "MCP token required");
  return token;
}

async function withUnboundJudgeRun(
  run: (ctx: {
    home: string;
    project: string;
    bookKey: string;
    runId: string;
    unboundDir: string;
    ticketDir: string;
    request: RoleTurnRequest;
  }) => Promise<void>,
): Promise<void> {
  await withTempRoot("ak-1171-adapter-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const runId = "01a011710-0000-7000-8000-adapter01";
    const unboundDir = join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@judge`);
    const ticketDir = join(home, ".ak-roles", "books", bookKey, String(TICKET), "runs", `${runId}@judge`);
    await mkdir(sessionDirectoryOf(unboundDir), { recursive: true });
    const identity = { role: "judge", runId, bookKey, projectRoot: project };
    seedCurrentSection(unboundDir, "invocation", identity);
    seedCurrentSection(unboundDir, "admitted", identity);
    await writeFile(sessionFileOf(unboundDir), `${JSON.stringify({ type: "session", id: runId })}\n`, "utf8");
    const principal = piDurablePrincipalAuthority.seal({
      sessionDirectory: sessionDirectoryOf(unboundDir),
      sessionFile: sessionFileOf(unboundDir),
    });
    const request: RoleTurnRequest = {
      principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "report then exit" },
      cwd: project,
      home,
      agentDir: join(home, ".pi"),
      runDirectory: unboundDir,
      host: "claude",
    };
    await run({ home, project, bookKey, runId, unboundDir, ticketDir, request });
  });
}

test("#1171 headless true adapter: mid-turn report → exit-copy under ticket, unbound stays gone", async () => {
  await withUnboundJudgeRun(async ({ home, unboundDir, ticketDir, request }) => {
    const binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = join(binDir, "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const mcpIdx = process.argv.indexOf("--mcp-config");
if (mcpIdx < 0) throw new Error("missing --mcp-config");
const cfg = JSON.parse(readFileSync(process.argv[mcpIdx + 1], "utf8"));
const server = Object.values(cfg.mcpServers)[0];
const socketPath = server.env.AK_ACP_MCP_SOCKET;
const token = server.env.AK_ACP_MCP_TOKEN;

await new Promise((resolve, reject) => {
  const sock = connect(socketPath);
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    if (!buf.includes("\\n")) return;
    sock.destroy();
    const reply = JSON.parse(buf.split("\\n")[0]);
    if (reply.error) reject(new Error(JSON.stringify(reply.error)));
    else resolve();
  });
  sock.on("error", reject);
  sock.on("connect", () => {
    sock.write(JSON.stringify({
      id: 1,
      token,
      method: "tools/call",
      params: { name: "${REPORT_TICKET_TOOL_NAME}", arguments: { ticketNumber: ${TICKET} } },
    }) + "\\n");
  });
});

const homeEnv = process.env.HOME;
const cwd = process.cwd();
const sanitizedCwd = cwd.replace(/[^a-zA-Z0-9]/g, "-");
const projectsDir = join(homeEnv, ".claude", "projects", sanitizedCwd);
mkdirSync(projectsDir, { recursive: true });
writeFileSync(join(projectsDir, "${SESSION_ID}.jsonl"), JSON.stringify({ native: "claude-after-report" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", uuid: "1171-adapter",
  session_id: "${SESSION_ID}", is_error: false,
  structured_output: { status: "completed", report: "ok" },
}) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const socketPath = join(await mkdtemp(join(tmpdir(), "ak-1171-headless-")), "mcp.sock");
    const host = createHeadlessRoleTurnHost({
      description: claudeDescription,
      hostName: "claude",
      binary: fakeBin,
      env: { HOME: home, PATH: process.env.PATH },
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: (principal) => piDurablePrincipalAuthority.decode(principal).sessionFile,
      },
      prepare: (req) => prepareRoleEnvelope({
        request: req,
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath,
        listTerminatingToolOnMcp: false,
        sessionFile: piDurablePrincipalAuthority.decode(req.principal).sessionFile,
      }),
    });

    const result = await host.executeTurn(request);
    assert.equal(result.knownFailure, undefined, JSON.stringify(result.knownFailure));
    assert.equal(existsSync(unboundDir), false, "unbound must not revive after exit-copy");
    assert.equal(existsSync(ticketDir), true);
    const landing = resolveHostDossierLandingPath({
      host: "claude",
      sessionDirectory: sessionDirectoryOf(ticketDir),
    });
    assert.equal(existsSync(landing), true, `native copy under ticket: ${landing}`);
    assert.equal(request.runDirectory, ticketDir);
  });
});

test("#1171 ACP true adapter: mid-turn report → exit-copy under ticket, unbound stays gone", async () => {
  await withUnboundJudgeRun(async ({ home, project, unboundDir, ticketDir, request }) => {
    const socketPath = join(await mkdtemp(join(tmpdir(), "ak-1171-acp-")), "mcp.sock");
    const grokNative = join(
      home,
      ".grok",
      "sessions",
      encodeURIComponent(project),
      SESSION_ID,
    );
    await mkdir(grokNative, { recursive: true });
    await writeFile(join(grokNative, "chat_history.jsonl"), `${JSON.stringify({ t: 1 })}\n`, "utf8");
    await writeFile(join(grokNative, "usage.json"), `${JSON.stringify({ tokens: 1 })}\n`, "utf8");

    let preparedToken = "";
    const connection: AcpConnection = {
      async request(method) {
        if (method === "initialize") {
          return { protocolVersion: 1, _meta: { modelState: { availableModels: [{ modelId: "grok" }] } } };
        }
        if (method === "session/new") return { sessionId: SESSION_ID };
        if (method === "session/prompt") {
          await callMcpTool({
            socketPath,
            token: preparedToken,
            name: REPORT_TICKET_TOOL_NAME,
            args: { ticketNumber: TICKET },
          });
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      async close() {},
    };

    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: (principal) => piDurablePrincipalAuthority.decode(principal).sessionFile,
      },
      connect: async () => connection,
      prepare: async (req) => {
        const prepared = await prepareRoleEnvelope({
          request: req,
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath,
          sessionFile: piDurablePrincipalAuthority.decode(req.principal).sessionFile,
        });
        preparedToken = mcpTokenFromPrepared(prepared);
        return prepared;
      },
    });

    const turnRequest: RoleTurnRequest = {
      ...request,
      host: "grok-build",
      model: { provider: "xai", model: "grok" },
    };
    const result = await host.executeTurn(turnRequest);
    assert.equal(result.knownFailure, undefined, JSON.stringify(result.knownFailure));
    assert.equal(existsSync(unboundDir), false, "unbound must not revive after ACP exit-copy");
    assert.equal(existsSync(ticketDir), true);
    const landing = resolveHostDossierLandingPath({
      host: "grok-build",
      sessionDirectory: sessionDirectoryOf(ticketDir),
    });
    assert.equal(existsSync(landing), true, `grok dossier under ticket: ${landing}`);
    assert.equal(turnRequest.runDirectory, ticketDir);
  });
});
