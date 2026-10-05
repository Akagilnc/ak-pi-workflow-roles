/**
 * #1171 — mid-turn ticket report relocates immediately; missing-ticket soft
 * reask once. Public entry + in-repo fake hosts (pi / headless / ACP).
 * Asserts durable placement and typed ticket fields only — never free text.
 */
import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import {
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import {
  REPORT_TICKET_TOOL_NAME,
} from "../../src/report-ticket-tool.ts";
import { readCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import { addRoleRepoOrigin, packageRoot } from "../helpers/pi-test-harness.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";

const TICKET = 1171;

// failInfrastructure may stamp process.exitCode during recovered activation faults.
test.after(() => {
  process.exitCode = undefined;
});

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
      if (buf.includes("\n")) {
        sock.destroy();
        const line = buf.split("\n")[0]!;
        const reply = JSON.parse(line) as { error?: unknown };
        if (reply.error !== undefined) reject(new Error(JSON.stringify(reply.error)));
        else resolve();
      }
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

/**
 * Fake host turn through the shared envelope (same tool mouth as pi / headless / ACP).
 * Reports ticket mid-turn via MCP, then optionally submits.
 */
function envelopeHostThatReportsThen(input: {
  readonly packageRoot: string;
  readonly hostName: "pi" | "codex" | "grok-build";
  readonly ticketNumber: number;
  readonly submit?: Record<string, unknown>;
  readonly onAfterReport?: () => void;
}) {
  return {
    async executeTurn(request: RoleTurnRequest) {
      const socketPath = join(
        await mkdtemp(join(tmpdir(), "ak-1171-sock-")),
        "mcp.sock",
      );
      const prepared = await prepareRoleEnvelope({
        request: { ...request, host: input.hostName },
        dependencies: createRoleRuntimeDependencies(input.packageRoot),
        socketPath,
        listTerminatingToolOnMcp: input.hostName === "grok-build",
        sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
      });
      try {
        const envRows = (prepared.mcpServers[0] as { env?: Array<{ name: string; value: string }> } | undefined)?.env ?? [];
        const token = envRows.find((row) => row.name === "AK_ACP_MCP_TOKEN")?.value;
        assert.ok(token, "MCP token required");
        // Pi child path also projects AK_ROLE_RUN_DIR; keep it aligned for relocate.
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
              socketPath,
              token,
              name: FIXER_OUTPUT_TOOL_NAME,
              args: input.submit,
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

for (const hostName of ["pi", "codex", "grok-build"] as const) {
  test(`#1171 ${hostName} fake host: report-ticket relocates before tool returns; later records stay under ticket`, async () => {
    await withSeatProject(async ({ home, project, bookKey }) => {
      const runId = `01a011710-0000-7000-8000-${hostName.slice(0, 5).padEnd(5, "0")}fix`;
      let afterReport = { unbound: true, ticket: false };
      const roleTurnHost = withPassingReviewHost(
        envelopeHostThatReportsThen({
          packageRoot,
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
        {
          home,
          agentDir: join(home, ".pi"),
          packageRoot,
          cwd: project,
          principalAuthority: piDurablePrincipalAuthority,
          sessionAppender: appendPiSessionCustomEntry,
          roleTurnHost,
          createRunId: () => runId,
          host: hostName,
        },
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(result.exitCode, 0, `${hostName} exit ${result.terminal?.roleOutcome.kind}`);
      assert.deepEqual(afterReport, { unbound: false, ticket: true }, `${hostName} placement at tool return`);
      assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
      const live = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
      assert.equal(existsSync(live), true);
      assert.equal(result.admitted?.ticketNumber, TICKET);
      assert.equal(result.admitted?.runDirectory, live);
      const admitted = readCurrentSection(live, "admitted") as { ticketNumber?: number };
      assert.equal(admitted.ticketNumber, TICKET);
    });
  });
}

test("#1171 report then exit without submit: leg stays under ticket as no_receipt", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000norec";
    const roleTurnHost = withPassingReviewHost(
      envelopeHostThatReportsThen({
        packageRoot,
        hostName: "codex",
        ticketNumber: TICKET,
      }),
    );
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost,
        createRunId: () => runId,
        host: "codex",
        autoResumeLimit: 0,
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
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
      piRunner: async (args) => {
        turns += 1;
        if (turns === 1) {
          return scriptedTerminatingToolSession({
            role: "fixer",
            toolName: FIXER_OUTPUT_TOOL_NAME,
            details: {
              status: "completed",
              report: "no ticket yet",
              classResults: FIXER_DONE.classResults,
            },
          })(args, { cwd: project, env: process.env as NodeJS.ProcessEnv });
        }
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            status: "completed",
            report: "with ticket",
            ticketNumber: TICKET,
            classResults: FIXER_DONE.classResults,
          },
          sessionWriteMode: "append",
        })(args, { cwd: project, env: process.env as NodeJS.ProcessEnv });
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Repair without declaring ticket first."],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: withPassingReviewHost(host),
        createRunId: () => runId,
        host: "pi",
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(turns, 2, "exactly one soft reask turn");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});

test("#1171 submit with ticketNumber and no report tool: bind as today, no reask", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000direct";
    let turns = 0;
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171."],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: withPassingReviewHost(
          roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
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
              })(args, { cwd: project, env: process.env as NodeJS.ProcessEnv });
            },
          }),
        ),
        createRunId: () => runId,
        host: "pi",
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(turns, 1, "no soft reask when submission carries ticket");
    assert.equal(result.admitted?.ticketNumber, TICKET);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
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
          const token = ((prepared.mcpServers[0] as { env?: Array<{ name: string; value: string }> })
            ?.env ?? []).find((row) => row.name === "AK_ACP_MCP_TOKEN")?.value;
          assert.ok(token);
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
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost,
        createRunId: () => runId,
        host: "codex",
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
  });
});
