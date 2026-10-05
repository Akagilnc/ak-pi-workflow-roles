/**
 * #1171 — mid-turn ticket report relocates immediately; missing-ticket soft
 * reask once. Public entry + in-repo fake hosts.
 * - pi: native SessionManager.setSessionFile (not envelope MCP)
 * - codex / grok-build: prepareRoleEnvelope MCP mouth (their real seam)
 * Asserts durable placement and typed fields only — never free text.
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
import {
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
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
  withNestedTrueUnboundDiarist,
} from "../helpers/role-turn-host-fixture.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";
import { loadPublicCliConfig, savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";

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
    /** Nested summons (court diarist) select from this table — not the parent host. */
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
): NonNullable<Parameters<typeof runPublicInstructionSeat>[1]["hostAdapters"]> {
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
  readonly onAfterReport?: () => void;
}) {
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
        await callMcpTool({
          socketPath,
          token,
          name: REPORT_TICKET_TOOL_NAME,
          args: { ticketNumber: input.ticketNumber },
        });
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
    const sessionText = await readFile(sessionFileOf(live), "utf8");
    assert.equal(sessionText.includes("ak_1171_post_relocate"), true);
    assert.equal((readCurrentSection(live, "admitted") as { ticketNumber?: number }).ticketNumber, TICKET);
  });
});

for (const hostName of ["codex", "grok-build"] as const) {
  test(`#1171 ${hostName} envelope: report relocates before tool returns; records under ticket`, async () => {
    await withSeatProject(async ({ home, project, bookKey }) => {
      const runId = `01a011710-0000-7000-8000-${hostName.slice(0, 5).padEnd(5, "0")}env`;
      let afterReport = { unbound: true, ticket: false };
      const roleTurnHost = withPassingReviewHost(
        envelopeHostThatReportsThen({
          hostName,
          ticketNumber: TICKET,
          submit: { ...FIXER_DONE },
          onAfterReport: () => {
            afterReport = {
              unbound: existsSync(unboundLeaf(home, bookKey, runId, "fixer")),
              ticket: existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")),
            };
          },
        }),
      );
      const result = await runPublicInstructionSeat(
        ["apply", "Repair #1171."],
        seatEnv(home, project, runId, hostName, roleTurnHost),
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(result.exitCode, 0, `${hostName} ${result.terminal?.roleOutcome.kind}`);
      assert.deepEqual(afterReport, { unbound: false, ticket: true });
      assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
      assert.equal(result.admitted?.ticketNumber, TICKET);
    });
  });
}

test("#1171 report then exit without submit: leg stays under ticket as no_receipt", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000norec";
    const result = await runPublicInstructionSeat(
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
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
  });
});

test("#1171 submit without ticket soft-reasks once; second reply with ticket relocates", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000reask";
    let turns = 0;
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        turns += 1;
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            status: "completed",
            report: turns === 1 ? "no ticket yet" : "with ticket",
            ...(turns === 1 ? {} : { ticketNumber: TICKET }),
            classResults: FIXER_DONE.classResults,
          },
          ...(turns === 1 ? {} : { sessionWriteMode: "append" as const }),
        })(args, options);
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Repair without declaring ticket first."],
      seatEnv(home, project, runId, "pi", withPassingReviewHost(host)),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(turns, 2, "exactly one soft reask turn");
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});

test("#1171 still no ticket on second submit: ask once, stay unbound, sealed receipt kept", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000still";
    let turns = 0;
    const captured = captureIo();
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        turns += 1;
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            status: "completed",
            report: `still unbound turn ${turns}`,
            classResults: FIXER_DONE.classResults,
          },
          ...(turns === 1 ? {} : { sessionWriteMode: "append" as const }),
        })(args, options);
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Repair with no ticket ever."],
      seatEnv(home, project, runId, "pi", withPassingReviewHost(host)),
      captured.io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(turns, 2, "reask once then stop");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), false);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(captured.stdout.join("\n").includes("still unbound turn"), true);
  });
});

test("#1171 submit with ticketNumber and no report tool: bind as today, no reask", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000direct";
    let turns = 0;
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      seatEnv(
        home, project, runId, "pi",
        withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
            turns += 1;
            return scriptedTerminatingToolSession({
              role: "fixer",
              toolName: FIXER_OUTPUT_TOOL_NAME,
              details: {
                status: "completed",
                report: "direct ticket",
                ticketNumber: TICKET,
                classResults: FIXER_DONE.classResults,
              },
            })(args, options);
          },
        })),
      ),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(turns, 1);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});

test("#1171 already under ticket: second report does not invent a second leaf", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000again";
    const roleTurnHost = withPassingReviewHost({
      async executeTurn(request: RoleTurnRequest) {
        const socketPath = join(await mkdtemp(join(tmpdir(), "ak-1171-again-")), "mcp.sock");
        const prepared = await prepareRoleEnvelope({
          request: { ...request, host: "codex" },
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath,
          listTerminatingToolOnMcp: false,
          sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
        });
        try {
          const token = mcpTokenFromPrepared(prepared);
          process.env.AK_ROLE_RUN_DIR = request.runDirectory;
          await callMcpTool({
            socketPath, token, name: REPORT_TICKET_TOOL_NAME, args: { ticketNumber: TICKET },
          });
          await callMcpTool({
            socketPath, token, name: REPORT_TICKET_TOOL_NAME, args: { ticketNumber: TICKET },
          });
          await prepared.ingestStructuredOutput({ ...FIXER_DONE });
          return await driveExternalRoleTurnRounds(prepared, request, {
            roundLimitName: "ReportAgain",
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
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      seatEnv(home, project, runId, "codex", roleTurnHost),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
  });
});

test("#1171 secretariat unbound then mid-turn report relocates (no submit)", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000secre";
    let afterReport = { unbound: true, ticket: false };
    const nested = withPassingReviewHost(
      withNestedTrueUnboundDiarist(
        envelopeHostThatReportsThen({
          hostName: "codex",
          ticketNumber: TICKET,
          onAfterReport: () => {
            afterReport = {
              unbound: existsSync(unboundLeaf(home, bookKey, runId, "secretariat")),
              ticket: existsSync(ticketLeaf(home, bookKey, TICKET, runId, "secretariat")),
            };
          },
        }),
      ),
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
    assert.deepEqual(afterReport, { unbound: false, ticket: true });
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "secretariat")), false);
    assert.equal(result.admitted?.ticketNumber, TICKET);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
  });
});

test("#1171 public resume after relocate reaches host on ticket path", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000resum";
    let resumeSession: string | undefined;
    const firstHost = withPassingReviewHost(
      envelopeHostThatReportsThen({ hostName: "codex", ticketNumber: TICKET }),
    );
    await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      seatEnv(home, project, runId, "codex", firstHost, { autoResumeLimit: 0 }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    const live = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(live), true);
    const resumeHost = withPassingReviewHost(
      roleTurnHostFromLegacyPiRunner({
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
      }),
    );
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

test("#1171 report-ticket moves child diarist and rehomes 起居录 staging (measured)", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const parentRunId = "01a011710-0000-7000-8000-0000000parent";
    const childRunId = "01a011710-0000-7000-8000-0000000child";
    const parentDir = unboundLeaf(home, bookKey, parentRunId, "fixer");
    const childDir = join(dirname(parentDir), formatRunLeaf(childRunId, "diarist"));
    await mkdir(sessionDirectoryOf(parentDir), { recursive: true });
    await mkdir(sessionDirectoryOf(childDir), { recursive: true });
    const parentSession = SessionManager.create(project, sessionDirectoryOf(parentDir));
    const childSession = SessionManager.create(project, sessionDirectoryOf(childDir));
    // Force durable session files under the unbound leaves.
    parentSession.setSessionFile(sessionFileOf(parentDir));
    childSession.setSessionFile(sessionFileOf(childDir));
    parentSession.appendCustomEntry("ak_1171_parent_seed", { ok: true });
    childSession.appendCustomEntry("ak_1171_child_seed", { ok: true });

    const identity = { bookKey, projectRoot: project };
    seedCurrentSection(parentDir, "invocation", { role: "fixer", runId: parentRunId, ...identity });
    seedCurrentSection(parentDir, "admitted", {
      role: "fixer", runId: parentRunId, ...identity, childDiaristRunIds: [childRunId],
    });
    seedCurrentSection(childDir, "invocation", { role: "diarist", runId: childRunId, ...identity });
    seedCurrentSection(childDir, "admitted", { role: "diarist", runId: childRunId, ...identity });
    await writeFile(
      join(childDir, RUN_HISTORY_FILE),
      `${JSON.stringify({
        kind: TICKET_PROVENANCE_KIND,
        identity: "stage-1",
        level: "event",
        timestamp: "2026-10-05T00:00:00.000Z",
        payload: { staged: true },
      })}\n`,
      "utf8",
    );

    const context: HostContext = {
      cwd: project,
      mode: "rpc",
      model: undefined,
      runDirectory: parentDir,
      sessionManager: {
        getLeafEntry: () => parentSession.getLeafEntry(),
        getLeafId: () => parentSession.getLeafId(),
        getEntries: () => parentSession.getEntries(),
        getSessionDir: () => parentSession.getSessionDir(),
        getSessionFile: () => parentSession.getSessionFile(),
        getHeader: () => parentSession.getHeader(),
        setSessionFile: (path) => parentSession.setSessionFile(path),
        appendCustomEntry: (t, d) => parentSession.appendCustomEntry(t, d),
      },
      abort() {},
    };
    const reported = await reportTicketFromHostContext(context, TICKET);
    assert.equal(reported.relocated, true);
    assert.equal(existsSync(parentDir), false);
    assert.equal(existsSync(childDir), false);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, parentRunId, "fixer")), true);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, childRunId, "diarist")), true);
    const volume = resolveTicketProvenanceVolume(TICKET, project, home);
    assert.equal(existsSync(volume.recordFile), true);
    assert.equal((await readFile(volume.recordFile, "utf8")).includes("stage-1"), true);
  });
});
