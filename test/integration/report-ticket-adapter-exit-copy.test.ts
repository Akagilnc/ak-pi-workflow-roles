/**
 * #1171 — true adapter entry (createHeadlessRoleTurnHost / createAcpRoleTurnHost)
 * after mid-turn ak_report_ticket: exit-copy lands under the live ticket leaf.
 * Driven through public entry + in-repo fake host — same seam as
 * public-cli-report-ticket.test.ts (no second admission model).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { REPORT_TICKET_TOOL_NAME } from "../../src/report-ticket-tool.ts";
import { sessionDirectoryOf } from "../../src/role-run-placement.ts";
import { resolveHostDossierLandingPath } from "../../src/host-session-record.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { callMcpTool, mcpTokenFromPrepared } from "../helpers/mcp-tool-call.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withPassingReviewHost } from "../helpers/passing-review-host.ts";
import {
  reportTicketSeatEnv as seatEnv,
  ticketLeaf,
  unboundLeaf,
  withReportTicketSeatProject as withSeatProject,
} from "../helpers/report-ticket-seat-project.ts";

const TICKET = 1171;
const SESSION_ID = "ak-1171-adapter-sid";
const MCP_HELPER = join(packageRoot, "test/helpers/mcp-tool-call.ts");

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

async function withAdapterSeatProject(
  run: (ctx: { home: string; project: string; bookKey: string }) => Promise<void>,
): Promise<void> {
  await withSeatProject(run, {
    prefix: "ak-1171-adapter-",
    seatRoles: ["fixer", "judge"],
  });
}

test("#1171 headless true adapter via public entry: mid-turn report → exit-copy under ticket", async () => {
  await withAdapterSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-adapter01";
    const binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = join(binDir, "fake-claude");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env -S node --import tsx
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcpTool } from ${JSON.stringify(MCP_HELPER)};

const mcpIdx = process.argv.indexOf("--mcp-config");
if (mcpIdx < 0) throw new Error("missing --mcp-config");
const cfg = JSON.parse(readFileSync(process.argv[mcpIdx + 1], "utf8"));
const server = Object.values(cfg.mcpServers)[0];

await callMcpTool({
  socketPath: server.env.AK_ACP_MCP_SOCKET,
  token: server.env.AK_ACP_MCP_TOKEN,
  name: ${JSON.stringify(REPORT_TICKET_TOOL_NAME)},
  args: { ticketNumber: ${TICKET} },
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

    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171 via headless adapter."],
      seatEnv(home, project, runId, "claude", withPassingReviewHost(host)),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    const unboundDir = unboundLeaf(home, bookKey, runId, "fixer");
    const ticketDir = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(unboundDir), false, "unbound must not revive after exit-copy");
    assert.equal(existsSync(ticketDir), true);
    assert.equal(result.admitted?.runDirectory, ticketDir);
    const landing = resolveHostDossierLandingPath({
      host: "claude",
      sessionDirectory: sessionDirectoryOf(ticketDir),
    });
    assert.equal(existsSync(landing), true, `native copy under ticket: ${landing}`);
  });
});

test("#1171 ACP true adapter via public entry: mid-turn report → exit-copy under ticket", async () => {
  await withAdapterSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-adapter02";
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
      prepare: async (req: RoleTurnRequest) => {
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

    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171 via ACP adapter."],
      seatEnv(home, project, runId, "grok-build", withPassingReviewHost(host)),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    const unboundDir = unboundLeaf(home, bookKey, runId, "fixer");
    const ticketDir = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(unboundDir), false, "unbound must not revive after ACP exit-copy");
    assert.equal(existsSync(ticketDir), true);
    assert.equal(result.admitted?.runDirectory, ticketDir);
    const landing = resolveHostDossierLandingPath({
      host: "grok-build",
      sessionDirectory: sessionDirectoryOf(ticketDir),
    });
    assert.equal(existsSync(landing), true, `grok dossier under ticket: ${landing}`);
  });
});
