/**
 * #1171 / #1199 — true adapter entry (createHeadlessRoleTurnHost / createAcpRoleTurnHost)
 * after mid-turn ak_report_ticket: exit-copy lands under the live ticket leaf;
 * ticket progress points at the host original; resume reuses bound identity and
 * appends the same original. Driven through public entry + in-repo fake host —
 * same seam as public-cli-report-ticket.test.ts (no second admission model).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import type { HeadlessHostDescription } from "../../src/headless-host/description.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { resolveHostDossierLandingPath } from "../../src/host-session-record.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import {
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { REPORT_TICKET_TOOL_NAME } from "../../src/report-ticket-tool.ts";
import { sessionDirectoryOf } from "../../src/role-run-placement.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
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

const FIXER_DONE = {
  status: "completed",
  report: "ok",
  summary: "adapter host progress summary text",
  ticketNumber: TICKET,
  classResults: [{
    name: "main",
    disposition: "completed",
    searchScope: "src",
    exceptions: [],
    commitSha: "abc1234",
  }],
} as const;

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

function subjectDir(home: string, bookKey: string, ticket: number): string {
  return join(home, ".ak-roles", "books", bookKey, String(ticket));
}

/** One ACP mid-turn report assembly shared by happy-path and close-fault cases. */
async function runAcpMidTurnReportViaPublicEntry(input: {
  readonly home: string;
  readonly project: string;
  readonly runId: string;
  readonly instruction: string;
  readonly autoResumeLimit?: number;
  readonly onClose?: () => Promise<void>;
  readonly submit?: Record<string, unknown>;
}): Promise<{ disposeCalls: number; result: Awaited<ReturnType<typeof runPublicInstructionSeat>> }> {
  const socketDir = await mkdtemp(join(tmpdir(), "ak-1171-acp-"));
  const socketPath = join(socketDir, "mcp.sock");
  const grokNative = join(
    input.home,
    ".grok",
    "sessions",
    encodeURIComponent(input.project),
    SESSION_ID,
  );
  await mkdir(grokNative, { recursive: true });
  await writeFile(join(grokNative, "chat_history.jsonl"), `${JSON.stringify({ t: 1 })}\n`, "utf8");
  await writeFile(join(grokNative, "usage.json"), `${JSON.stringify({ tokens: 1 })}\n`, "utf8");

  let preparedToken = "";
  let disposeCalls = 0;
  let activeSessionId = SESSION_ID;
  const sessionIdentity = createSessionIdentityAuthority(piDurablePrincipalAuthority, "grok-build");
  const connection: AcpConnection = {
    async request(method, params) {
      if (method === "initialize") {
        return { protocolVersion: 1, _meta: { modelState: { availableModels: [{ modelId: "grok" }] } } };
      }
      // #1199 J4/S3: load resumes an existing id; new must mint a peer — never
      // return the bound SESSION_ID from session/new (that washes wrong new→resume).
      if (method === "session/load") {
        const id = typeof (params as { sessionId?: unknown } | undefined)?.sessionId === "string"
          ? (params as { sessionId: string }).sessionId
          : "";
        if (id.length === 0) throw new Error("session/load missing sessionId");
        const native = join(
          input.home,
          ".grok",
          "sessions",
          encodeURIComponent(input.project),
          id,
        );
        if (!existsSync(native)) throw new Error(`session/load unknown sessionId: ${id}`);
        activeSessionId = id;
        return { sessionId: id };
      }
      if (method === "session/new") {
        const minted = `ak-1199-new-${Date.now().toString(36)}`;
        activeSessionId = minted;
        return { sessionId: minted };
      }
      if (method === "session/prompt") {
        const native = join(
          input.home,
          ".grok",
          "sessions",
          encodeURIComponent(input.project),
          activeSessionId,
        );
        await mkdir(native, { recursive: true });
        // Native originals for exit-copy: chat_history + usage (ADR 0086 grok pair).
        await writeFile(
          join(native, "chat_history.jsonl"),
          `${JSON.stringify({ t: 1, sessionId: activeSessionId })}\n`,
          { flag: "a" },
        );
        await writeFile(join(native, "usage.json"), `${JSON.stringify({ tokens: 1 })}\n`, "utf8");
        await callMcpTool({
          socketPath,
          token: preparedToken,
          name: REPORT_TICKET_TOOL_NAME,
          args: { ticketNumber: TICKET },
        });
        if (input.submit !== undefined) {
          await callMcpTool({
            socketPath,
            token: preparedToken,
            name: FIXER_OUTPUT_TOOL_NAME,
            args: input.submit,
          });
        }
        return { stopReason: "end_turn" };
      }
      if (method === "session/close") return {};
      return {};
    },
    notify() {},
    async close() {
      await input.onClose?.();
    },
  };

  try {
    const host = createAcpRoleTurnHost({
      hostName: "grok-build",
      modelPassing: "argv",
      sessionIdentity,
      connect: async () => connection,
      prepare: async (req: RoleTurnRequest) => {
        const prepared = await prepareRoleEnvelope({
          request: req,
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath,
          sessionFile: piDurablePrincipalAuthority.decode(req.principal).sessionFile,
          principalAuthority: piDurablePrincipalAuthority,
        });
        preparedToken = mcpTokenFromPrepared(prepared);
        const innerDispose = prepared.dispose?.bind(prepared);
        return {
          ...prepared,
          async dispose() {
            disposeCalls += 1;
            await innerDispose?.();
          },
        };
      },
    });

    const result = await runPublicInstructionSeat(
      ["apply", input.instruction],
      seatEnv(input.home, input.project, input.runId, "grok-build", withPassingReviewHost(host), {
        ...(input.autoResumeLimit === undefined ? {} : { autoResumeLimit: input.autoResumeLimit }),
      }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    return { disposeCalls, result };
  } finally {
    await rm(socketDir, { recursive: true, force: true });
  }
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
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { callMcpTool } from ${JSON.stringify(MCP_HELPER)};

function argvValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && typeof process.argv[i + 1] === "string" ? process.argv[i + 1] : undefined;
}
// #1199 J4: consume and check native resume/--session-id — do not hardcode a fixture id.
const resumeId = argvValue("--resume");
const sessionId = resumeId ?? argvValue("--session-id");
if (typeof sessionId !== "string" || sessionId.length === 0) {
  throw new Error("fake-claude requires --resume or --session-id");
}

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
const nativePath = join(projectsDir, sessionId + ".jsonl");
// Resume must continue an existing original — minting a peer id washes wrong resume.
if (typeof resumeId === "string" && !existsSync(nativePath)) {
  throw new Error("fake-claude --resume session not found: " + resumeId);
}
const row = JSON.stringify({ native: "claude-after-report", at: Date.now() }) + "\\n";
if (existsSync(nativePath)) appendFileSync(nativePath, row);
else writeFileSync(nativePath, row);
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", uuid: "1171-adapter",
  session_id: sessionId, is_error: false,
  structured_output: ${JSON.stringify(FIXER_DONE)},
}) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const socketDir = await mkdtemp(join(tmpdir(), "ak-1171-headless-"));
    const socketPath = join(socketDir, "mcp.sock");
    const sessionIdentity = createSessionIdentityAuthority(piDurablePrincipalAuthority, "claude");
    try {
      const host = createHeadlessRoleTurnHost({
        description: claudeDescription,
        hostName: "claude",
        binary: fakeBin,
        env: { HOME: home, PATH: process.env.PATH },
        sessionIdentity,
        prepare: (req) => prepareRoleEnvelope({
          request: req,
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath,
          listTerminatingToolOnMcp: false,
          sessionFile: piDurablePrincipalAuthority.decode(req.principal).sessionFile,
          principalAuthority: piDurablePrincipalAuthority,
        }),
      });

      const firstInstruction = "Repair #1171 via headless adapter.";
      const resumeInstruction = "continue on bound claude session";
      const result = await runPublicInstructionSeat(
        ["apply", firstInstruction],
        seatEnv(home, project, runId, "claude", withPassingReviewHost(host)),
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
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

      // #1199: progress session pointer is the host original; whole receipt equals submit.
      const progress = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
        .filter((line) => line.seat === "fixer");
      assert.equal(progress.length, 1);
      assert.equal(join(subjectDir(home, bookKey, TICKET), progress[0]!.session), landing);
      assert.equal(progress[0]!.instruction, firstInstruction);
      const receipt = JSON.parse(
        await readFile(join(subjectDir(home, bookKey, TICKET), progress[0]!.receipt), "utf8"),
      ) as unknown;
      assert.deepEqual(receipt, FIXER_DONE);
      const beforeBytes = await readFile(landing, "utf8");
      const beforeLines = beforeBytes.trim().split("\n").filter(Boolean).length;

      // Resume reuses bound host session id and appends the same original.
      const resumed = await runPublicInstructionSeatResume(
        { runId, message: resumeInstruction },
        seatEnv(home, project, runId, "claude", withPassingReviewHost(host)),
        captureIo().io,
      );
      assert.equal(resumed.exitCode, 0, `${resumed.terminal?.roleOutcome.kind}`);
      const afterProgress = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
        .filter((line) => line.seat === "fixer");
      assert.equal(afterProgress.length, 2);
      assert.equal(afterProgress[0]!.session, afterProgress[1]!.session);
      assert.equal(afterProgress[1]!.instruction, resumeInstruction);
      const afterBytes = await readFile(landing, "utf8");
      const afterLines = afterBytes.trim().split("\n").filter(Boolean).length;
      assert.ok(afterLines > beforeLines, "resume must append host original, not mint a peer copy");
    } finally {
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("#1171 ACP true adapter via public entry: mid-turn report → exit-copy under ticket", async () => {
  await withAdapterSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-adapter02";
    const firstInstruction = "Repair #1171 via ACP adapter.";
    const { result } = await runAcpMidTurnReportViaPublicEntry({
      home,
      project,
      runId,
      instruction: firstInstruction,
      submit: { ...FIXER_DONE },
    });
    assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
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
    const progress = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
      .filter((line) => line.seat === "fixer");
    assert.equal(progress.length, 1);
    assert.equal(join(subjectDir(home, bookKey, TICKET), progress[0]!.session), landing);
    assert.equal(progress[0]!.instruction, firstInstruction);
    const receipt = JSON.parse(
      await readFile(join(subjectDir(home, bookKey, TICKET), progress[0]!.receipt), "utf8"),
    ) as unknown;
    assert.deepEqual(receipt, FIXER_DONE);
    const beforeLines = (await readFile(join(landing, "chat_history.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).length;
    // Native grok original — exit-copy refreshes landing from here on each turn.
    const grokNative = join(
      home,
      ".grok",
      "sessions",
      encodeURIComponent(project),
      SESSION_ID,
    );

    // #1199: post-relocate public resume reuses the same grok original and appends a row.
    const socketDir = await mkdtemp(join(tmpdir(), "ak-1171-acp-resume-"));
    const socketPath = join(socketDir, "mcp.sock");
    let preparedToken = "";
    const sessionIdentity = createSessionIdentityAuthority(piDurablePrincipalAuthority, "grok-build");
    const resumeInstruction = "continue on bound grok session after relocate";
    let activeSessionId = SESSION_ID;
    const connection: AcpConnection = {
      async request(method, params) {
        if (method === "initialize") {
          return { protocolVersion: 1, _meta: { modelState: { availableModels: [{ modelId: "grok" }] } } };
        }
        // #1199 J4/S3: load resumes existing id; new mints a peer id (never the bound one).
        if (method === "session/load") {
          const id = typeof (params as { sessionId?: unknown } | undefined)?.sessionId === "string"
            ? (params as { sessionId: string }).sessionId
            : "";
          if (id.length === 0) throw new Error("session/load missing sessionId");
          const native = join(
            home,
            ".grok",
            "sessions",
            encodeURIComponent(project),
            id,
          );
          if (!existsSync(native)) throw new Error(`session/load unknown sessionId: ${id}`);
          activeSessionId = id;
          return { sessionId: id };
        }
        if (method === "session/new") {
          const minted = `ak-1199-new-${Date.now().toString(36)}`;
          activeSessionId = minted;
          return { sessionId: minted };
        }
        if (method === "session/prompt") {
          const native = join(
            home,
            ".grok",
            "sessions",
            encodeURIComponent(project),
            activeSessionId,
          );
          await mkdir(native, { recursive: true });
          await writeFile(
            join(native, "chat_history.jsonl"),
            `${JSON.stringify({ t: 2, resume: true })}\n`,
            { flag: "a" },
          );
          await writeFile(join(native, "usage.json"), `${JSON.stringify({ tokens: 2 })}\n`, "utf8");
          await callMcpTool({
            socketPath,
            token: preparedToken,
            name: FIXER_OUTPUT_TOOL_NAME,
            args: {
              ...FIXER_DONE,
              report: "grok-resume-ok",
              summary: "grok resume progress summary text",
            },
          });
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      async close() {},
    };
    try {
      const host = createAcpRoleTurnHost({
        hostName: "grok-build",
        modelPassing: "argv",
        sessionIdentity,
        connect: async () => connection,
        prepare: async (req: RoleTurnRequest) => {
          const prepared = await prepareRoleEnvelope({
            request: req,
            dependencies: createRoleRuntimeDependencies(packageRoot),
            socketPath,
            sessionFile: piDurablePrincipalAuthority.decode(req.principal).sessionFile,
            principalAuthority: piDurablePrincipalAuthority,
          });
          preparedToken = mcpTokenFromPrepared(prepared);
          return prepared;
        },
      });
      const resumed = await runPublicInstructionSeatResume(
        { runId, message: resumeInstruction },
        seatEnv(home, project, runId, "grok-build", withPassingReviewHost(host)),
        captureIo().io,
      );
      assert.equal(resumed.exitCode, 0, `${resumed.terminal?.roleOutcome.kind}`);
      const afterProgress = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
        .filter((line) => line.seat === "fixer");
      assert.equal(afterProgress.length, 2);
      assert.equal(afterProgress[0]!.session, afterProgress[1]!.session);
      assert.equal(afterProgress[1]!.instruction, resumeInstruction);
      const afterLines = (await readFile(join(landing, "chat_history.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).length;
      assert.ok(afterLines > beforeLines, "grok resume must append host original, not mint a peer copy");
    } finally {
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("#1199 codex headless true adapter via public entry: exit-copy + resume same original", async () => {
  await withAdapterSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011990-0000-7000-8000-codexad1";
    const firstInstruction = "Repair #1199 via codex headless adapter.";
    const resumeInstruction = "continue on bound codex session after relocate";
    const binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = join(binDir, "fake-codex");
    // Codex headless has no --mcp-config file; ticket lands via receipt ticketNumber
    // at settle (exit-copy still runs on the true headless path). Resume uses
    // `exec resume <thread>` and must append the same native landing.
    await writeFile(
      fakeBin,
      `#!/usr/bin/env -S node --import tsx
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0;
// #1199 S3: native new mints its own thread/rollout; resume continues that id.
// Wrong new-instead-of-resume must not append the bound original.
const sessionsDir = ${JSON.stringify(join(home, ".codex", "sessions"))};
const thread = resumed
  ? (args[resumeAt + 1] ?? "")
  : ("thread-1199-codex-new-" + Date.now().toString(36));
if (resumed && thread.length === 0) {
  throw new Error("fake-codex resume missing thread id");
}
const rollout = sessionsDir + "/rollout-" + thread + ".jsonl";
mkdirSync(dirname(rollout), { recursive: true });
const row = JSON.stringify({ native: "codex", resumed, at: Date.now() }) + "\\n";
if (resumed) {
  if (!existsSync(rollout)) throw new Error("fake-codex resume rollout not found: " + thread);
  appendFileSync(rollout, row);
} else {
  writeFileSync(rollout, row);
}

// Same lawful fixer receipt every turn — first-call auto-resume (if any) and
// explicit public resume both settle through structured agent_message.
const receipt = ${JSON.stringify(FIXER_DONE)};
const events = [
  { type: "thread.started", thread_id: thread },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(receipt) } },
  { type: "turn.completed" },
];
process.stdout.write(events.map((e) => JSON.stringify(e)).join("\\n") + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const socketDir = await mkdtemp(join(tmpdir(), "ak-1199-codex-headless-"));
    const socketPath = join(socketDir, "mcp.sock");
    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    const sessionIdentity = createSessionIdentityAuthority(piDurablePrincipalAuthority, "codex");
    try {
      const host = createHeadlessRoleTurnHost({
        description,
        hostName: "codex",
        binary: fakeBin,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          CODEX_HOME: join(home, ".codex"),
        },
        sessionIdentity,
        prepare: (req) => prepareRoleEnvelope({
          request: req,
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath,
          // Receipt arrives via structured agent_message, not MCP terminating tool.
          listTerminatingToolOnMcp: false,
          sessionFile: piDurablePrincipalAuthority.decode(req.principal).sessionFile,
          principalAuthority: piDurablePrincipalAuthority,
        }),
      });

      const result = await runPublicInstructionSeat(
        ["apply", firstInstruction],
        seatEnv(home, project, runId, "codex", withPassingReviewHost(host)),
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
      const unboundDir = unboundLeaf(home, bookKey, runId, "fixer");
      const ticketDir = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
      assert.equal(existsSync(unboundDir), false, "unbound must not revive after codex exit-copy");
      assert.equal(existsSync(ticketDir), true);
      assert.equal(result.admitted?.runDirectory, ticketDir);
      const landing = resolveHostDossierLandingPath({
        host: "codex",
        sessionDirectory: sessionDirectoryOf(ticketDir),
      });
      assert.equal(existsSync(landing), true, `codex native copy under ticket: ${landing}`);

      const progress = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
        .filter((line) => line.seat === "fixer");
      assert.equal(progress.length, 1);
      assert.equal(join(subjectDir(home, bookKey, TICKET), progress[0]!.session), landing);
      assert.equal(progress[0]!.instruction, firstInstruction);
      const receipt = JSON.parse(
        await readFile(join(subjectDir(home, bookKey, TICKET), progress[0]!.receipt), "utf8"),
      ) as unknown;
      assert.deepEqual(receipt, FIXER_DONE);
      const beforeLines = (await readFile(landing, "utf8")).trim().split("\n").filter(Boolean).length;

      const resumed = await runPublicInstructionSeatResume(
        { runId, message: resumeInstruction },
        seatEnv(home, project, runId, "codex", withPassingReviewHost(host)),
        captureIo().io,
      );
      assert.equal(resumed.exitCode, 0, `${resumed.terminal?.roleOutcome.kind}`);
      const afterProgress = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
        .filter((line) => line.seat === "fixer");
      assert.equal(afterProgress.length, 2);
      assert.equal(afterProgress[0]!.session, afterProgress[1]!.session);
      assert.equal(afterProgress[1]!.instruction, resumeInstruction);
      const afterLines = (await readFile(landing, "utf8")).trim().split("\n").filter(Boolean).length;
      assert.ok(afterLines > beforeLines, "codex resume must append host original, not mint a peer copy");
    } finally {
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("#1171 ACP close fault retained when live placement vanishes (B1)", async () => {
  await withAdapterSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-b1fault";
    const ticketDir = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    const { disposeCalls } = await runAcpMidTurnReportViaPublicEntry({
      home,
      project,
      runId,
      instruction: "Repair #1171 B1 fault retain.",
      autoResumeLimit: 0,
      async onClose() {
        // Vanish at close time (prompt-time deletes get rewritten before finally).
        await rm(ticketDir, { recursive: true, force: true });
        throw Object.assign(new Error("native-close-original-fault"), { code: "ECONNRESET" });
      },
    });
    // Structured contract: soft retain must not block cleanup after the leaf vanishes.
    // Close-fault presentation may appear on stderr as dossier observation — not asserted
    // (CLAUDE.md 锚定宪法 / quality-law 盯文禁令).
    assert.ok(disposeCalls >= 1, `dispose must run even when live placement vanished; calls=${disposeCalls}`);
  });
});
