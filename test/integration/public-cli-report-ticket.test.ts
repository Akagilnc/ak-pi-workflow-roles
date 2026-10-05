/**
 * #1171 — mid-turn ticket report relocates immediately; missing-ticket soft
 * reask once. Public entry + in-repo fake hosts.
 * - pi: native SessionManager.setSessionFile (not envelope MCP)
 * - codex / grok-build: prepareRoleEnvelope MCP mouth (their real seam)
 * Asserts durable placement and typed fields only — never free text / stdout.
 */
import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { HostContext, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import {
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import {
  REPORT_TICKET_TOOL_NAME,
  reportTicketFromHostContext,
} from "../../src/report-ticket-tool.ts";
import { formatRunLeaf, sessionDirectoryOf, sessionFileOf } from "../../src/role-run-placement.ts";
import { RUN_HISTORY_FILE } from "../../src/run-dossier-files.ts";
import { TICKET_PROVENANCE_KIND } from "../../src/ticket-provenance-contracts.ts";
import { resolveTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import { readCurrentSection, seedCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import { addRoleRepoOrigin, packageRoot } from "../helpers/pi-test-harness.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";
import { loadPublicCliConfig, savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { isRecord } from "../../src/unknown-value.ts";

const TICKET = 1171;

const FIXER_DONE = {
  status: "completed",
  report: "done",
  classResults: [{
    name: "main",
    disposition: "completed",
    searchScope: "src",
    exceptions: [],
    commitSha: "abc1234",
  }],
} as const;

async function withSeatProject(
  run: (ctx: { home: string; project: string; bookKey: string }) => Promise<void>,
): Promise<void> {
  await withTempRoot("ak-report-ticket-", async (home) => {
    const binDir = join(home, "bin");
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    await withPrimaryAwareCleanup(
      async () => {
        const project = join(home, "project");
        await mkdir(project, { recursive: true });
        seedGitProject(project);
        addRoleRepoOrigin(project);
        await installGhFixture(binDir, {
          issues: { [TICKET]: { body: "issue body", comments: [] } },
        });
        await configurePassingReviewSeats(home);
        let config = await loadPublicCliConfig(home);
        const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
        for (const role of ["fixer", "secretariat", "diarist", "countersign"] as const) {
          config = setPersistentSeatConfig(config, role, seat);
        }
        await savePublicCliConfig(config, home);
        await run({ home, project, bookKey: resolveBookKeyFromGit(project) });
      },
      async () => {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      },
    );
  });
}

function unboundLeaf(home: string, bookKey: string, runId: string, role: string): string {
  return join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@${role}`);
}

function ticketLeaf(home: string, bookKey: string, ticket: number, runId: string, role: string): string {
  return join(home, ".ak-roles", "books", bookKey, String(ticket), "runs", `${runId}@${role}`);
}

function seatEnv(
  home: string,
  project: string,
  runId: string,
  host: string,
  roleTurnHost: NonNullable<Parameters<typeof runPublicInstructionSeat>[1]["roleTurnHost"]>,
  extra?: {
    readonly autoResumeLimit?: number;
    readonly hostAdapters?: Parameters<typeof runPublicInstructionSeat>[1]["hostAdapters"];
  },
) {
  return {
    home,
    agentDir: join(home, ".pi"),
    packageRoot,
    cwd: project,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    roleTurnHost,
    createRunId: () => runId,
    host,
    ...(extra?.autoResumeLimit === undefined ? {} : { autoResumeLimit: extra.autoResumeLimit }),
    ...(extra?.hostAdapters === undefined ? {} : { hostAdapters: extra.hostAdapters }),
  };
}

function nestAdaptersFor(
  host: NonNullable<Parameters<typeof runPublicInstructionSeat>[1]["roleTurnHost"]>,
) {
  return [
    { name: "pi", create: () => ({ ok: true as const, host }) },
    { name: "codex", create: () => ({ ok: true as const, host }) },
    { name: "grok-build", create: () => ({ ok: true as const, host }) },
  ];
}

/** MCP tools/call — same socket protocol as public-cli-secretariat-run / host-axis. */
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

/** Headless / ACP seam: report via envelope MCP, then optional submit. */
function envelopeHostThatReportsThen(input: {
  readonly hostName: "codex" | "grok-build";
  readonly ticketNumber: number;
  readonly submit?: Record<string, unknown>;
  readonly reportCount?: number;
  readonly beforeReport?: (request: RoleTurnRequest) => void | Promise<void>;
  readonly onAfterReport?: () => void;
}) {
  const reportCount = input.reportCount ?? 1;
  return {
    async executeTurn(request: RoleTurnRequest) {
      const socketPath = join(await mkdtemp(join(tmpdir(), "ak-1171-sock-")), "mcp.sock");
      const prepared = await prepareRoleEnvelope({
        request: { ...request, host: input.hostName },
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath,
        listTerminatingToolOnMcp: input.hostName === "grok-build",
        sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
      });
      try {
        const token = mcpTokenFromPrepared(prepared);
        process.env.AK_ROLE_RUN_DIR = request.runDirectory;
        await input.beforeReport?.(request);
        for (let i = 0; i < reportCount; i += 1) {
          await callMcpTool({
            socketPath,
            token,
            name: REPORT_TICKET_TOOL_NAME,
            args: { ticketNumber: input.ticketNumber },
          });
        }
        input.onAfterReport?.();
        if (input.submit !== undefined) {
          if (input.hostName === "grok-build") {
            await callMcpTool({
              socketPath, token, name: FIXER_OUTPUT_TOOL_NAME, args: input.submit,
            });
          } else {
            await prepared.ingestStructuredOutput(input.submit);
          }
        }
        return await driveExternalRoleTurnRounds(prepared, request, {
          roundLimitName: "ReportTicketRoundLimit",
          currentSessionId: () => undefined,
          async runRound() {
            return { status: "delivered" };
          },
        });
      } finally {
        delete process.env.AK_ROLE_RUN_DIR;
        await prepared.dispose?.();
      }
    },
  };
}

/**
 * Pi seam: open native SessionManager, reportTicket → setSessionFile, later
 * appends land under ticket; submit writes the new session path (never revive unbound).
 */
function piHostThatReportsThenSubmits(input: {
  readonly ticketNumber: number;
  readonly onAfterReport?: (paths: { oldSession: string; newSession: string }) => void;
}) {
  return roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args, options) => {
      const oldSession = argvFlagValue(args, "--session");
      const oldSessionDir = argvFlagValue(args, "--session-dir");
      assert.ok(oldSession && oldSessionDir);
      const runDirectory = dirname(oldSessionDir);
      await mkdir(oldSessionDir, { recursive: true });
      if (!existsSync(oldSession)) {
        await writeFile(oldSession, "", "utf8");
      }
      const sessionManager = SessionManager.open(oldSession, oldSessionDir, options.cwd);
      const context: HostContext = {
        cwd: options.cwd,
        mode: "rpc",
        model: undefined,
        runDirectory,
        sessionManager: {
          getLeafEntry: () => sessionManager.getLeafEntry(),
          getLeafId: () => sessionManager.getLeafId(),
          getEntries: () => sessionManager.getEntries(),
          getSessionDir: () => sessionManager.getSessionDir(),
          getSessionFile: () => sessionManager.getSessionFile(),
          getHeader: () => sessionManager.getHeader(),
          setSessionFile: (path) => sessionManager.setSessionFile(path),
          appendCustomEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
        },
        abort() {},
      };
      const reported = await reportTicketFromHostContext(context, input.ticketNumber);
      assert.equal(reported.relocated, true);
      assert.equal("runDirectory" in reported, false);
      const nextRunDirectory = context.runDirectory;
      assert.ok(nextRunDirectory);
      // Spawn env still held the unbound path; seal/ledger must follow the live leaf.
      options.env.AK_ROLE_RUN_DIR = nextRunDirectory;
      sessionManager.appendCustomEntry("ak_1171_post_relocate", { ok: true });
      const newSession = sessionManager.getSessionFile();
      assert.ok(newSession && newSession.includes(`/${input.ticketNumber}/`));
      assert.equal(existsSync(oldSession), false, "old session path must not remain");
      input.onAfterReport?.({ oldSession, newSession });
      const patched = args.flatMap((arg, i) => {
        if (args[i - 1] === "--session") return [newSession];
        if (args[i - 1] === "--session-dir") return [dirname(newSession)];
        return [arg];
      });
      return scriptedTerminatingToolSession({
        role: "fixer",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        details: { ...FIXER_DONE },
        sessionWriteMode: "append",
      })(patched, options);
    },
  });
}

/** Seed an unbound child diarist + staged 起居录 row under the live parent leaf. */
async function seedUnboundChildWithStaging(input: {
  readonly parentDir: string;
  readonly childRunId: string;
  readonly bookKey: string;
  readonly project: string;
  readonly identity: string;
  readonly payload: Record<string, unknown>;
}): Promise<string> {
  const childDir = join(dirname(input.parentDir), formatRunLeaf(input.childRunId, "diarist"));
  await mkdir(sessionDirectoryOf(childDir), { recursive: true });
  const identity = { bookKey: input.bookKey, projectRoot: input.project };
  const parentAdmitted = readCurrentSection(input.parentDir, "admitted");
  seedCurrentSection(input.parentDir, "admitted", {
    ...parentAdmitted,
    childDiaristRunIds: [input.childRunId],
  });
  seedCurrentSection(childDir, "invocation", { role: "diarist", runId: input.childRunId, ...identity });
  seedCurrentSection(childDir, "admitted", { role: "diarist", runId: input.childRunId, ...identity });
  await writeFile(
    join(childDir, RUN_HISTORY_FILE),
    `${JSON.stringify({
      kind: TICKET_PROVENANCE_KIND,
      identity: input.identity,
      level: "event",
      timestamp: "2026-10-05T00:00:00.000Z",
      payload: input.payload,
    })}\n`,
    "utf8",
  );
  return childDir;
}

async function assertProvenanceRow(input: {
  readonly ticket: number;
  readonly project: string;
  readonly home: string;
  readonly identity: string;
  readonly payload: Record<string, unknown>;
}): Promise<void> {
  const volume = resolveTicketProvenanceVolume(input.ticket, input.project, input.home);
  assert.equal(existsSync(volume.recordFile), true);
  const rows = (await readFile(volume.recordFile, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
  const hit = rows.find((row) => row.identity === input.identity);
  assert.ok(hit, `provenance identity ${input.identity}`);
  assert.deepEqual(hit.payload, input.payload);
}

test("#1171 pi SessionManager: report relocates; post-relocate append stays under ticket", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-00000pihost";
    let afterReport = { unbound: true, ticket: false, oldAlive: true };
    const roleTurnHost = withPassingReviewHost(
      piHostThatReportsThenSubmits({
        ticketNumber: TICKET,
        onAfterReport: ({ oldSession }) => {
          afterReport = {
            unbound: existsSync(unboundLeaf(home, bookKey, runId, "fixer")),
            ticket: existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")),
            oldAlive: existsSync(oldSession),
          };
        },
      }),
    );
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      seatEnv(home, project, runId, "pi", roleTurnHost),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
    assert.deepEqual(afterReport, { unbound: false, ticket: true, oldAlive: false });
    const live = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(result.admitted?.runDirectory, live);
    const sessionEntries = (await readFile(sessionFileOf(live), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown)
      .filter(isRecord);
    assert.equal(
      sessionEntries.some((row) => row.customType === "ak_1171_post_relocate"),
      true,
    );
    assert.equal((readCurrentSection(live, "admitted") as { ticketNumber?: number }).ticketNumber, TICKET);
  });
});

function fixerTurnHost(detailsForTurn: (turn: number) => Record<string, unknown>) {
  let turns = 0;
  return {
    get turns() { return turns; },
    host: withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        turns += 1;
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: detailsForTurn(turns),
          ...(turns === 1 ? {} : { sessionWriteMode: "append" as const }),
        })(args, options);
      },
    })),
  };
}

for (const caseRow of [
  {
    name: "codex envelope relocate+submit",
    runId: "01a011710-0000-7000-8000-codex0env",
    hostName: "codex" as const,
    reportCount: 1,
    submit: { ...FIXER_DONE },
    expectKind: undefined as string | undefined,
  },
  {
    name: "grok-build envelope relocate+submit",
    runId: "01a011710-0000-7000-8000-grok-env",
    hostName: "grok-build" as const,
    reportCount: 1,
    submit: { ...FIXER_DONE },
    expectKind: undefined,
  },
  {
    name: "report then exit without submit → no_receipt",
    runId: "01a011710-0000-7000-8000-0000000norec",
    hostName: "codex" as const,
    reportCount: 1,
    submit: undefined,
    expectKind: "no_receipt",
  },
  {
    name: "second report does not invent a second leaf",
    runId: "01a011710-0000-7000-8000-0000000again",
    hostName: "codex" as const,
    reportCount: 2,
    submit: { ...FIXER_DONE },
    expectKind: undefined,
  },
]) {
  test(`#1171 ${caseRow.name}`, async () => {
    await withSeatProject(async ({ home, project, bookKey }) => {
      let afterReport = { unbound: true, ticket: false };
      const roleTurnHost = withPassingReviewHost(
        envelopeHostThatReportsThen({
          hostName: caseRow.hostName,
          ticketNumber: TICKET,
          reportCount: caseRow.reportCount,
          ...(caseRow.submit === undefined ? {} : { submit: caseRow.submit }),
          onAfterReport: () => {
            afterReport = {
              unbound: existsSync(unboundLeaf(home, bookKey, caseRow.runId, "fixer")),
              ticket: existsSync(ticketLeaf(home, bookKey, TICKET, caseRow.runId, "fixer")),
            };
          },
        }),
      );
      const result = await runPublicInstructionSeat(
        ["apply", "Repair #1171."],
        seatEnv(
          home, project, caseRow.runId, caseRow.hostName, roleTurnHost,
          caseRow.submit === undefined ? { autoResumeLimit: 0 } : {},
        ),
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.deepEqual(afterReport, { unbound: false, ticket: true });
      assert.equal(existsSync(unboundLeaf(home, bookKey, caseRow.runId, "fixer")), false);
      assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, caseRow.runId, "fixer")), true);
      if (caseRow.expectKind !== undefined) {
        assert.equal(result.terminal?.roleOutcome.kind, caseRow.expectKind);
      } else {
        assert.equal(result.exitCode, 0, `${caseRow.name} ${result.terminal?.roleOutcome.kind}`);
        assert.equal(result.admitted?.ticketNumber, TICKET);
      }
    });
  });
}

test("#1171 submit without ticket soft-reasks once; second reply with ticket relocates", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000reask";
    const scripted = fixerTurnHost((turn) => ({
      status: "completed",
      report: turn === 1 ? "no ticket yet" : "with ticket",
      ...(turn === 1 ? {} : { ticketNumber: TICKET }),
      classResults: FIXER_DONE.classResults,
    }));
    const result = await runPublicInstructionSeat(
      ["apply", "Repair without declaring ticket first."],
      seatEnv(home, project, runId, "pi", scripted.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(scripted.turns, 2, "exactly one soft reask turn");
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});

test("#1171 still no ticket on second submit: ask once, stay unbound, sealed receipt kept", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000still";
    const scripted = fixerTurnHost((turn) => ({
      status: "completed",
      report: turn === 1 ? "still unbound turn 1" : "still unbound turn 2",
      classResults: FIXER_DONE.classResults,
    }));
    const result = await runPublicInstructionSeat(
      ["apply", "Repair with no ticket ever."],
      seatEnv(home, project, runId, "pi", scripted.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(scripted.turns, 2, "reask once then stop");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), false);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      objectPayloads(result.terminal!.roleOutcome).at(-1)?.report,
      "still unbound turn 2",
    );
  });
});

test("#1171 submit with ticketNumber and no report tool: bind as today, no reask", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000direct";
    const scripted = fixerTurnHost(() => ({
      status: "completed",
      report: "direct ticket",
      ticketNumber: TICKET,
      classResults: FIXER_DONE.classResults,
    }));
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      seatEnv(home, project, runId, "pi", scripted.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(scripted.turns, 1);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});

test("#1171 secretariat unbound mid-report relocates; child diarist + 起居录 staging follow", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000secre";
    const childRunId = "01a011710-0000-7000-8000-0000000child";
    const stagingIdentity = "stage-1";
    const stagingPayload = { staged: true };
    let childDir = "";
    let afterReport = { unbound: true, ticket: false, childUnbound: true, childTicket: false };
    const nested = withPassingReviewHost(
      envelopeHostThatReportsThen({
        hostName: "codex",
        ticketNumber: TICKET,
        beforeReport: async (request) => {
          childDir = await seedUnboundChildWithStaging({
            parentDir: request.runDirectory,
            childRunId,
            bookKey,
            project,
            identity: stagingIdentity,
            payload: stagingPayload,
          });
        },
        onAfterReport: () => {
          afterReport = {
            unbound: existsSync(unboundLeaf(home, bookKey, runId, "secretariat")),
            ticket: existsSync(ticketLeaf(home, bookKey, TICKET, runId, "secretariat")),
            childUnbound: existsSync(childDir),
            childTicket: existsSync(ticketLeaf(home, bookKey, TICKET, childRunId, "diarist")),
          };
        },
      }),
    );
    const result = await runPublicInstructionSeat(
      ["propose", "Open a ticket once the number exists."],
      seatEnv(home, project, runId, "codex", nested, {
        autoResumeLimit: 0,
        hostAdapters: nestAdaptersFor(nested),
      }),
      captureIo().io,
      "secretariat",
      (args) => parsePublicSeatArgv("secretariat", args),
    );
    assert.deepEqual(afterReport, {
      unbound: false, ticket: true, childUnbound: false, childTicket: true,
    });
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "secretariat")), false);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, childRunId, "diarist")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
    await assertProvenanceRow({
      ticket: TICKET, project, home, identity: stagingIdentity, payload: stagingPayload,
    });
  });
});

test("#1171 public resume after relocate reaches host on ticket path", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000resum";
    let resumeSession: string | undefined;
    await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      seatEnv(
        home, project, runId, "codex",
        withPassingReviewHost(envelopeHostThatReportsThen({ hostName: "codex", ticketNumber: TICKET })),
        { autoResumeLimit: 0 },
      ),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    const live = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(live), true);
    const resumeHost = withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        resumeSession = argvFlagValue(args, "--session");
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: { ...FIXER_DONE, ticketNumber: TICKET },
          sessionWriteMode: "append",
        })(args, options);
      },
    }));
    const resumed = await runPublicInstructionSeatResume(
      { runId, message: "continue after relocate" },
      seatEnv(home, project, runId, "pi", resumeHost),
      captureIo().io,
    );
    assert.ok(resumeSession?.startsWith(join(live, "session")));
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(resumed.admitted?.runDirectory, live);
  });
});
