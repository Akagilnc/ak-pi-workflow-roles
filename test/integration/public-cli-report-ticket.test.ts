/**
 * #1171 — mid-turn ticket report relocates immediately; missing-ticket soft
 * reask once. Public entry + in-repo fake hosts.
 * - pi: native SessionManager.setSessionFile (not envelope MCP)
 * - codex / grok-build: prepareRoleEnvelope MCP mouth (their real seam)
 * Asserts durable placement and typed fields only — never free text / stdout.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { HostContext, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
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
import { formatRunLeaf, isUnboundRunDirectory, sessionDirectoryOf, sessionFileOf } from "../../src/role-run-placement.ts";
import { RUN_HISTORY_FILE } from "../../src/run-dossier-files.ts";
import { TICKET_PROVENANCE_KIND } from "../../src/ticket-provenance-contracts.ts";
import { resolveTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import {
  historyPayloads,
  lockCurrentJson,
  readCurrentJson,
  readCurrentSection,
  seedCurrentSection,
} from "../helpers/run-dossier-fixture.ts";
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
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";
import { isRecord } from "../../src/unknown-value.ts";

const TICKET = 1171;

/** #1183: current.json location fields match the live run directory. */
function assertCurrentLocationPaths(runDirectory: string, label: string): void {
  const current = readCurrentJson(runDirectory);
  const expectedSessionDirectory = sessionDirectoryOf(runDirectory);
  const expectedSessionFile = sessionFileOf(runDirectory);
  for (const section of ["invocation", "admitted", "runState"] as const) {
    const page = current[section];
    assert.ok(page !== undefined && typeof page === "object" && page !== null, `${label}: ${section}`);
    const record = page as Record<string, unknown>;
    assert.equal(record.runDirectory, runDirectory, `${label}: ${section}.runDirectory`);
    assert.equal(existsSync(String(record.runDirectory)), true, `${label}: ${section}.runDirectory exists`);
    if (typeof record.sessionDirectory === "string") {
      assert.equal(record.sessionDirectory, expectedSessionDirectory, `${label}: ${section}.sessionDirectory`);
      assert.equal(existsSync(record.sessionDirectory), true, `${label}: sessionDirectory exists`);
    }
    if (typeof record.sessionFile === "string") {
      assert.equal(record.sessionFile, expectedSessionFile, `${label}: ${section}.sessionFile`);
    }
  }
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

function nestAdaptersFor(
  host: NonNullable<Parameters<typeof runPublicInstructionSeat>[1]["roleTurnHost"]>,
) {
  return [
    { name: "pi", create: () => ({ ok: true as const, host }) },
    { name: "codex", create: () => ({ ok: true as const, host }) },
    { name: "grok-build", create: () => ({ ok: true as const, host }) },
  ];
}

/** Headless / ACP seam: report via envelope MCP, then optional submit. */
function envelopeHostThatReportsThen(input: {
  readonly hostName: "codex" | "grok-build";
  readonly ticketNumber: number;
  /** When set, each entry is one report call (overrides reportCount + ticketNumber). */
  readonly ticketNumbers?: readonly number[];
  readonly submit?: Record<string, unknown>;
  readonly reportCount?: number;
  readonly beforeReport?: (request: RoleTurnRequest) => void | Promise<void>;
  readonly onAfterReport?: () => void;
  readonly afterReportOnly?: boolean;
}) {
  const tickets = input.ticketNumbers
    ?? Array.from({ length: input.reportCount ?? 1 }, () => input.ticketNumber);
  return {
    async executeTurn(request: RoleTurnRequest) {
      const socketPath = join(await mkdtemp(join(tmpdir(), "ak-1171-sock-")), "mcp.sock");
      const prepared = await prepareRoleEnvelope({
        request: { ...request, host: input.hostName },
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath,
        listTerminatingToolOnMcp: input.hostName === "grok-build",
        sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
        principalAuthority: piDurablePrincipalAuthority,
      });
      try {
        const token = mcpTokenFromPrepared(prepared);
        process.env.AK_ROLE_RUN_DIR = request.runDirectory;
        await input.beforeReport?.(request);
        for (const ticketNumber of tickets) {
          await callMcpTool({
            socketPath,
            token,
            name: REPORT_TICKET_TOOL_NAME,
            args: { ticketNumber },
          });
        }
        input.onAfterReport?.();
        if (input.afterReportOnly === true) {
          return await driveExternalRoleTurnRounds(prepared, request, {
            roundLimitName: "ReportTicketRoundLimit",
            currentSessionId: () => undefined,
            async runRound() {
              return { status: "delivered" };
            },
          });
        }
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
 *
 * `refuseDerivedRender`: plant EISDIR on the still-unbound leaf at seal (pre-rename
 * commit). Rename carries the poison; post-rename render refuses at the same external
 * fault regardless of when setSessionFile runs (#1171 F6-R3 / F4-R2).
 */
function piHostThatReportsThenSubmits(input: {
  readonly ticketNumber: number;
  readonly onAfterReport?: (paths: { oldSession: string; newSession: string }) => void;
  readonly refuseDerivedRender?: true;
  readonly onReportOutcome?: (observed: {
    threw: boolean;
    code?: string | undefined;
    contextRunDirectory?: string | undefined;
    sessionFile?: string | undefined;
    appendOk?: boolean | undefined;
  }) => void;
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
      const authority = input.refuseDerivedRender === true
        ? {
            ...piDurablePrincipalAuthority,
            seal(coordinates: Parameters<typeof piDurablePrincipalAuthority.seal>[0]) {
              // Relocate seals the ticket target before rename; admitted construction
              // seals the still-unbound path. Plant only on the relocate seal so bind
              // can render, then rename carries the poison to post-rename render.
              const live = context.runDirectory;
              const targetRun = dirname(coordinates.sessionDirectory);
              if (
                live !== undefined
                && isUnboundRunDirectory(live)
                && !isUnboundRunDirectory(targetRun)
              ) {
                lockCurrentJson(live);
              }
              return piDurablePrincipalAuthority.seal(coordinates);
            },
          }
        : piDurablePrincipalAuthority;
      const priorAmbient = process.env.AK_ROLE_RUN_DIR;
      if (input.refuseDerivedRender === true) {
        process.env.AK_ROLE_RUN_DIR = runDirectory;
      }
      try {
        const reported = await reportTicketFromHostContext(context, input.ticketNumber, authority);
        assert.equal(reported.relocated, true);
        assert.equal("runDirectory" in reported, false);
        input.onReportOutcome?.({
          threw: false,
          contextRunDirectory: context.runDirectory,
          sessionFile: sessionManager.getSessionFile(),
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        let appendOk = false;
        try {
          sessionManager.appendCustomEntry("ak_1171_f4r2_after_render_refuse", { ok: true });
          appendOk = true;
        } catch {
          appendOk = false;
        }
        input.onReportOutcome?.({
          threw: true,
          code,
          contextRunDirectory: context.runDirectory,
          sessionFile: sessionManager.getSessionFile(),
          appendOk,
        });
        throw error;
      } finally {
        if (input.refuseDerivedRender === true) {
          if (priorAmbient === undefined) delete process.env.AK_ROLE_RUN_DIR;
          else process.env.AK_ROLE_RUN_DIR = priorAmbient;
        }
      }
      const nextRunDirectory = context.runDirectory;
      assert.ok(nextRunDirectory);
      // Host native: setSessionFile moves the file handle; getSessionDir stays the open dir.
      assert.equal(sessionManager.getSessionDir(), oldSessionDir);
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

test("#1171 F4-R2 derived render refuse after rename keeps live handles on ticket path", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000f4r2eis";
    const unbound = unboundLeaf(home, bookKey, runId, "fixer");
    const ticket = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    let observed: {
      threw: boolean;
      code?: string | undefined;
      contextRunDirectory?: string | undefined;
      sessionFile?: string | undefined;
      appendOk?: boolean | undefined;
    } = { threw: false };
    const roleTurnHost = withPassingReviewHost(
      piHostThatReportsThenSubmits({
        ticketNumber: TICKET,
        refuseDerivedRender: true,
        onReportOutcome: (outcome) => { observed = outcome; },
      }),
    );
    const result = await runPublicInstructionSeat(
      ["apply", "Report then derived render refuses."],
      seatEnv(home, project, runId, "pi", roleTurnHost, { autoResumeLimit: 0 }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(observed.threw, true, "derived render must keep the original I/O refuse");
    assert.equal(observed.code, "EISDIR");
    assert.equal(existsSync(unbound), false);
    assert.equal(existsSync(ticket), true);
    assert.equal(observed.contextRunDirectory, ticket);
    assert.ok(observed.sessionFile?.startsWith(join(ticket, "session")));
    assert.equal(observed.appendOk, true, "native SessionManager must follow setSessionFile after rename");
    assert.notEqual(result.exitCode, 0, "real render refuse must not wash to exit 0");
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
    // Same public line also covers already-placed re-report identity (B2):
    // second call may carry a different number; durable placement stays TICKET.
    ticketNumbers: [TICKET, 1172] as const,
    submit: { ...FIXER_DONE },
    expectKind: undefined as string | undefined,
  },
]) {
  test(`#1171 ${caseRow.name}`, async () => {
    await withSeatProject(async ({ home, project, bookKey }) => {
      let afterReport = { unbound: true, ticket: false };
      let unboundAtStart: string | undefined;
      const roleTurnHost = withPassingReviewHost(
        envelopeHostThatReportsThen({
          hostName: caseRow.hostName,
          ticketNumber: TICKET,
          ...("ticketNumbers" in caseRow
            ? { ticketNumbers: caseRow.ticketNumbers }
            : { reportCount: caseRow.reportCount }),
          ...(caseRow.submit === undefined ? {} : { submit: caseRow.submit }),
          beforeReport: (request) => {
            unboundAtStart = request.runDirectory;
          },
          onAfterReport: () => {
            const placement = ticketLeaf(home, bookKey, TICKET, caseRow.runId, "fixer");
            afterReport = {
              unbound: existsSync(unboundLeaf(home, bookKey, caseRow.runId, "fixer")),
              ticket: existsSync(placement),
            };
            // #1183: mid-turn current.json already tracks the ticket leaf.
            assertCurrentLocationPaths(placement, `${caseRow.name} mid-turn`);
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
      const placement = ticketLeaf(home, bookKey, TICKET, caseRow.runId, "fixer");
      assert.equal(existsSync(placement), true);
      // #1183: settle (incl. no_receipt) keeps current location paths on the ticket leaf.
      assertCurrentLocationPaths(placement, `${caseRow.name} after settle`);
      if (caseRow.expectKind === "no_receipt") {
        assert.ok(unboundAtStart !== undefined);
        const stateRaw = await readFile(join(placement, "state.jsonl"), "utf8");
        assert.ok(
          stateRaw.includes(unboundAtStart!),
          "state.jsonl keeps pre-relocate unbound path bytes",
        );
      }
      if (caseRow.expectKind !== undefined) {
        assert.equal(result.terminal?.roleOutcome.kind, caseRow.expectKind);
      } else {
        assert.equal(result.exitCode, 0, `${caseRow.name} ${result.terminal?.roleOutcome.kind}`);
        assert.equal(result.admitted?.ticketNumber, TICKET);
        assert.equal(result.admitted?.runDirectory, placement);
        if ("ticketNumbers" in caseRow) {
          for (const foreignTicket of caseRow.ticketNumbers) {
            if (foreignTicket === TICKET) continue;
            assert.equal(
              existsSync(ticketLeaf(home, bookKey, foreignTicket, caseRow.runId, "fixer")),
              false,
              "must not migrate or invent a foreign ticket leaf",
            );
          }
          assert.equal(
            (readCurrentSection(placement, "admitted") as { ticketNumber?: number }).ticketNumber,
            TICKET,
          );
          assert.equal(
            (readCurrentSection(placement, "invocation") as { ticketNumber?: number }).ticketNumber,
            TICKET,
          );
        }
      }
    });
  });
}
test("#1171 delivery throw after mid-turn report does not revive unbound", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-delivthrow";
    let turns = 0;
    const deliveryHost = envelopeHostThatReportsThen({
      hostName: "codex",
      ticketNumber: TICKET,
      onAfterReport: () => {
        throw new Error("injected delivery host throw after report");
      },
    });
    const host = withPassingReviewHost({
      async executeTurn(request: RoleTurnRequest) {
        turns += 1;
        if (turns === 1) {
          // First turn: host ends without a receipt so AK seam 催交一次.
          return { timedOut: false, code: 0, stderr: "" };
        }
        return deliveryHost.executeTurn(request);
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1171; delivery throws after report."],
      seatEnv(home, project, runId, "codex", host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.ok(turns >= 2, `delivery turn must run after silent first turn; turns=${turns}`);
    assert.notEqual(result.exitCode, 0, "delivery throw must keep true failure");
    const unbound = unboundLeaf(home, bookKey, runId, "fixer");
    const ticket = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(unbound), false, "unbound must not revive after delivery throw settle");
    assert.equal(existsSync(ticket), true);
    assert.equal(result.admitted?.runDirectory, ticket);
  });
});

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
    // F2-R4b duplicate full present is human-observed on mutation (no stdout count lock).
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
    // #1183: public resume keeps current.json location paths on the ticket leaf.
    assertCurrentLocationPaths(live, "public resume after relocate");
  });
});

test("#1171 public resume first sealed submit without ticket soft-reasks once", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000resreask";
    // Spend the initial soft-reask budget so the leg stays unbound with a sealed receipt.
    const seed = fixerTurnHost((turn) => ({
      status: "completed",
      report: turn === 1 ? "seed turn 1" : "seed turn 2 still unbound",
      classResults: FIXER_DONE.classResults,
    }));
    await runPublicInstructionSeat(
      ["apply", "Seed unbound sealed receipt."],
      seatEnv(home, project, runId, "pi", seed.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(seed.turns, 2);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);

    const resumed = fixerTurnHost((turn) => ({
      status: "completed",
      report: turn === 1 ? "resume no ticket" : "resume still no ticket",
      classResults: FIXER_DONE.classResults,
    }));
    const result = await runPublicInstructionSeatResume(
      { runId, message: "resume without ticket" },
      seatEnv(home, project, runId, "pi", resumed.host),
      captureIo().io,
    );
    assert.equal(resumed.turns, 2, "resume must soft-reask missing ticket once");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      objectPayloads(result.terminal!.roleOutcome).at(-1)?.report,
      "resume still no ticket",
    );
  });
});

test("#1171 F2-R6 resume prior seals; silence soft reask keeps this seal", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000f2r6hist";
    // Seed two sealed unbound rows so full-run sealed.length > 1 before this call.
    // Distinct toolCallIds so later audit is not skipped as "already passed".
    const seedRoles: string[] = [];
    const seedHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = args[args.indexOf("--ak-role") + 1]!;
        seedRoles.push(role);
        if (role === "fixer") {
          const turn = seedRoles.filter((r) => r === "fixer").length;
          return scriptedTerminatingToolSession({
            role: "fixer",
            toolName: FIXER_OUTPUT_TOOL_NAME,
            details: {
              ...FIXER_DONE,
              report: turn === 1 ? "seed-1" : "seed-2",
            },
            toolCallId: `call_fixer_seed_${turn}`,
            ...(turn === 1 ? {} : { sessionWriteMode: "append" as const }),
          })(args, options);
        }
        return scriptedTerminatingToolSession({
          role: role as "inspector",
          toolName: INSPECTOR_OUTPUT_TOOL_NAME,
          details: { status: "converged", findings: [], reason: "ok", ticketNumber: TICKET },
          toolCallId: `call_inspector_seed_${seedRoles.filter((r) => r === "inspector").length}`,
        })(args, options);
      },
    });
    await runPublicInstructionSeat(
      ["apply", "Seed multi-seal unbound history."],
      seatEnv(home, project, runId, "pi", seedHost),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(seedRoles.filter((r) => r === "fixer").length, 2);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);

    const roles: string[] = [];
    const resumeHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = args[args.indexOf("--ak-role") + 1]!;
        roles.push(role);
        if (role === "fixer") {
          const turn = roles.filter((r) => r === "fixer").length;
          if (turn === 1) {
            return scriptedTerminatingToolSession({
              role: "fixer",
              toolName: FIXER_OUTPUT_TOOL_NAME,
              details: { ...FIXER_DONE, report: "resume-this-seal" },
              toolCallId: "call_fixer_resume_1",
              sessionWriteMode: "append",
            })(args, options);
          }
          // Soft reask silence: historical sealed.count must not invent a substitute.
          return { code: 0, stderr: "", timedOut: false };
        }
        return scriptedTerminatingToolSession({
          role: role as "inspector",
          toolName: INSPECTOR_OUTPUT_TOOL_NAME,
          details: { status: "converged", findings: [], reason: "ok", ticketNumber: TICKET },
          toolCallId: "call_inspector_resume_1",
        })(args, options);
      },
    });
    const result = await runPublicInstructionSeatResume(
      { runId, message: "resume; soft reask silent" },
      seatEnv(home, project, runId, "pi", resumeHost),
      captureIo().io,
    );
    assert.equal(roles.filter((r) => r === "fixer").length, 2, "resume soft-reasks once");
    assert.ok(roles.includes("inspector"), "kept this-call seal must still enter audit");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      objectPayloads(result.terminal!.roleOutcome).some((p) => p.report === "resume-this-seal"),
      true,
      "silence must keep this resume seal; must not wash via nested no_receipt ownership",
    );
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
  });
});

test("#1171 F1 nested child report does not rewrite parent ambient AK_ROLE_RUN_DIR", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000f1nest";
    const parentUnbound = join(home, ".ak-roles", "books", "parent-book", "unbound", "runs", "parent@fixer");
    await mkdir(parentUnbound, { recursive: true });
    const prior = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = parentUnbound;
    try {
      let observed = false;
      const host = withPassingReviewHost(
        piHostThatReportsThenSubmits({
          ticketNumber: TICKET,
          onAfterReport: ({ newSession }) => {
            // Parent ambient stays parent; child HostContext owns this turn's leaf.
            assert.equal(
              process.env.AK_ROLE_RUN_DIR,
              parentUnbound,
              "parent ambient env must stay parent when child relocates",
            );
            assert.ok(newSession.includes(`/${TICKET}/`));
            observed = true;
          },
        }),
      );
      const result = await runPublicInstructionSeat(
        ["apply", "Child report under foreign ambient."],
        seatEnv(home, project, runId, "pi", host),
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(observed, true);
      assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
      assert.equal(process.env.AK_ROLE_RUN_DIR, parentUnbound);
      assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
      assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    } finally {
      if (prior === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = prior;
    }
  });
});

test("#1171 F2-R1 reask host failure keeps original volume but delivers nonzero exit", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000f2fail";
    const roles: string[] = [];
    const parent = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = args[args.indexOf("--ak-role") + 1]!;
        roles.push(role);
        if (role === "fixer") {
          const turn = roles.filter((r) => r === "fixer").length;
          if (turn === 1) {
            return scriptedTerminatingToolSession({
              role: "fixer",
              toolName: FIXER_OUTPUT_TOOL_NAME,
              details: { ...FIXER_DONE },
            })(args, options);
          }
          // Soft reask: real host failure — no substitute sealed submission.
          return { code: 7, stderr: "injected reask host failure", timedOut: false };
        }
        return scriptedTerminatingToolSession({
          role: role as "inspector",
          toolName: "ak_submission_output",
          details: { status: "converged", findings: [], reason: "ok" },
        })(args, options);
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Repair without ticket; reask host fails."],
      seatEnv(home, project, runId, "pi", parent),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(roles.filter((r) => r === "fixer").length, 2, "must soft-reask once");
    assert.notEqual(result.exitCode, 0, "real reask failure must not wash to exit 0");
    assert.notEqual(
      result.terminal?.roleOutcome.kind,
      "accepted",
      "must not present washed accepted over a failed reask",
    );
    assert.equal(
      roles.includes("inspector"),
      false,
      "failed reask must not continue into audit as accepted",
    );
    // Original sealed volume remains under unbound (no ticket reported).
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
  });
});

async function assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory(input: {
  readonly home: string;
  readonly project: string;
  readonly bookKey: string;
  readonly runId: string;
  readonly reask:
    | "report-only"
    | "silence"
    | "substitute"
    | "substitute-with-ticket"
    /** #1171 F2-R9: soft reask seals unreadable status + ticket; status reask is ordinary. */
    | "bad-status-with-ticket";
  /** #1171 F2-R4a / F2-R5 / F2-R6: inspector continue once after the first sealed chain. */
  readonly inspectorContinuesOnce?: boolean;
  /**
   * Ordinary turn after inspector continue.
   * - reseal: F2-R4a — spent budget must block a second soft reask; reseal reaches audit
   * - no-volume: F2-R5 / F2-R6 / F2-R9 — honest no_receipt; no outer restore of a prior volume
   */
  readonly ordinaryContinue?: "reseal" | "no-volume";
  /**
   * #1171 F2-R8: during plain soft-reask silence, another public resume seals
   * foreign-volume and passes台院 — original must not borrow that pass.
   */
  readonly foreignCourtPassesAudit?: boolean;
}): Promise<void> {
  const { home, project, bookKey, runId, reask } = input;
  const ordinaryContinue = input.ordinaryContinue
    ?? (input.inspectorContinuesOnce === true ? "no-volume" : undefined);
  const roles: string[] = [];
  let inspectorTurns = 0;
  /** Structured report field from parent-host inspector summons (F2-R8). */
  const parentInspectorReports: string[] = [];
  const parent = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args, options) => {
      const role = args[args.indexOf("--ak-role") + 1]!;
      roles.push(role);
      if (role === "fixer") {
        const turn = roles.filter((r) => r === "fixer").length;
        if (turn === 1) {
          return scriptedTerminatingToolSession({
            role: "fixer",
            toolName: FIXER_OUTPUT_TOOL_NAME,
            details: { ...FIXER_DONE, report: "original-volume" },
            toolCallId: "call_fixer_original",
          })(args, options);
        }
        if (turn === 2) {
          if (reask === "report-only") {
            // Soft reask: report ticket only — no substitute sealed submission.
            const runDirectory = dirname(argvFlagValue(args, "--session-dir")!);
            await mkdir(sessionDirectoryOf(runDirectory), { recursive: true });
            const context: HostContext = {
              cwd: options.cwd,
              mode: "rpc",
              model: undefined,
              runDirectory,
              sessionManager: {
                getLeafEntry: () => undefined,
                getLeafId: () => runId,
                getEntries: () => [],
                getSessionDir: () => sessionDirectoryOf(runDirectory),
                getSessionFile: () => sessionFileOf(runDirectory),
                setSessionFile() {},
                appendCustomEntry() {},
              },
              abort() {},
            };
            await reportTicketFromHostContext(context, TICKET);
            return { code: 0, stderr: "", timedOut: false };
          }
          if (reask === "substitute" || reask === "substitute-with-ticket") {
            return scriptedTerminatingToolSession({
              role: "fixer",
              toolName: FIXER_OUTPUT_TOOL_NAME,
              details: {
                ...FIXER_DONE,
                report: "substitute-volume",
                ...(reask === "substitute-with-ticket" ? { ticketNumber: TICKET } : {}),
              },
              sessionWriteMode: "append",
            })(args, options);
          }
          if (reask === "bad-status-with-ticket") {
            // Soft reask seals unreadable status + ticket; nested status reask is ordinary.
            return scriptedTerminatingToolSession({
              role: "fixer",
              toolName: FIXER_OUTPUT_TOOL_NAME,
              details: {
                status: "not-a-lawful-status",
                report: "bad-status-volume",
                ticketNumber: TICKET,
                classResults: FIXER_DONE.classResults,
              },
              sessionWriteMode: "append",
            })(args, options);
          }
          // silence: exit cleanly with neither report nor sealed substitute.
          // F2-R7: on the plain soft-reask silence line, another lawful court
          // on the same leg may seal meanwhile — ownership must not invent a
          // substitute from that foreign seal. Audit-continue silence paths
          // (R4a/R5) keep plain silence; their necessary inputs stay separate.
          // F2-R8: another public resume seals foreign-volume and passes台院 —
          // reuse the existing public-entry seam (no hand-crafted inspector pages).
          if (input.inspectorContinuesOnce !== true) {
            if (input.foreignCourtPassesAudit === true) {
              const foreignHost = roleTurnHostFromLegacyPiRunner({
                packageRoot,
                principalAuthority: piDurablePrincipalAuthority,
                piRunner: async (foreignArgs, foreignOptions) => {
                  const foreignRole = foreignArgs[foreignArgs.indexOf("--ak-role") + 1]!;
                  if (foreignRole === "fixer") {
                    return scriptedTerminatingToolSession({
                      role: "fixer",
                      toolName: FIXER_OUTPUT_TOOL_NAME,
                      details: {
                        ...FIXER_DONE,
                        report: "foreign-volume",
                        ticketNumber: TICKET,
                      },
                      toolCallId: "call_fixer_foreign_court",
                      sessionWriteMode: "append",
                    })(foreignArgs, foreignOptions);
                  }
                  return scriptedTerminatingToolSession({
                    role: foreignRole as "inspector",
                    toolName: INSPECTOR_OUTPUT_TOOL_NAME,
                    details: {
                      status: "converged",
                      findings: [],
                      reason: "ok",
                      ticketNumber: TICKET,
                    },
                    toolCallId: "call_inspector_foreign",
                  })(foreignArgs, foreignOptions);
                },
              });
              // Same-run public resume face (`message`) during an open soft-reask
              // court is adopted as that court's substitute. The proven interleave
              // seam is summons resume — real seal→audit→settle, distinct court.
              await runPublicInstructionSeatResume(
                { runId, summons: { instruction: "manual public continue" } },
                seatEnv(home, project, runId, "pi", foreignHost),
                captureIo().io,
              );
            } else {
              const runDirectory = dirname(argvFlagValue(args, "--session-dir")!);
              await sealAcceptedSubmission({
                cwd: project,
                home,
                runId,
                role: "fixer",
                runDirectory,
                courtAttemptId: "foreign-court-other-public-call",
                toolCallId: "call_fixer_foreign_court",
                details: {
                  ...FIXER_DONE,
                  report: "foreign-court-volume",
                },
              });
            }
          }
          return { code: 0, stderr: "", timedOut: false };
        }
        // Ordinary status reask / audit-continue turn: spent budget blocks a second soft reask.
        if (ordinaryContinue === "no-volume") {
          return { code: 0, stderr: "", timedOut: false };
        }
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: { ...FIXER_DONE, report: "after audit continue still unbound" },
          sessionWriteMode: "append",
        })(args, options);
      }
      if (role === "inspector") {
        inspectorTurns += 1;
        const status = input.inspectorContinuesOnce === true && inspectorTurns === 1
          ? "continue"
          : "converged";
        return scriptedTerminatingToolSession({
          role: "inspector",
          toolName: INSPECTOR_OUTPUT_TOOL_NAME,
          details: { status, findings: [], reason: "ok", ticketNumber: TICKET },
        })(args, options);
      }
      return scriptedTerminatingToolSession({
        role: role as "notary",
        toolName: "ak_notary_output",
        details: { status: "converged", findings: [], reason: "ok" },
      })(args, options);
    },
  });
  // Capture structured peer payload the parent-host inspector is summoned with (#1171 F2-R8).
  const capturingParent: typeof parent = {
    async executeTurn(request) {
      if (request.activation.role === "inspector") {
        const prompt = request.continuation.prompt;
        if (typeof prompt === "string" && prompt.length > 0) {
          try {
            const parsed: unknown = JSON.parse(prompt);
            if (isRecord(parsed) && typeof parsed.report === "string") {
              parentInspectorReports.push(parsed.report);
            }
          } catch {
            // Gate may deliver non-JSON; F2-R8 asserts structured report when present.
          }
        }
      }
      return parent.executeTurn(request);
    },
  };
  const result = await runPublicInstructionSeat(
    ["apply", "Repair without ticket on first seal."],
    seatEnv(home, project, runId, "pi", capturingParent),
    captureIo().io,
    "fixer",
    (args) => parsePublicSeatArgv("fixer", args),
  );
  const fixerTurns = roles.filter((r) => r === "fixer").length;
  if (reask === "bad-status-with-ticket" && ordinaryContinue === "no-volume") {
    // F2-R9: soft reask sealed bad-status+ticket; ordinary status reask no-volume.
    assert.equal(fixerTurns, 3, "soft reask seal then ordinary status reask");
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt", "ordinary status reask publishes no_receipt");
    const live = result.admitted?.runDirectory;
    assert.ok(live !== undefined && existsSync(live), "live admitted directory");
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    const attemptKinds = historyPayloads<{ outcome?: { kind?: string } }>(live!, "attempt-history")
      .map((row) => row.outcome?.kind);
    assert.deepEqual(
      attemptKinds,
      ["accepted", "accepted", "no_receipt"],
      "original, bad-status seal, ordinary status reask no_receipt",
    );
    const durable = readCurrentSection(live!, "terminal") as {
      face?: string;
      body?: { outcome?: { kind?: string } };
    } | undefined;
    assert.equal(durable?.face, "no_receipt", "durable face follows ordinary status reask");
    assert.equal(durable?.body?.outcome?.kind, "no_receipt", "durable outcome is no_receipt");
    return;
  }
  if (input.inspectorContinuesOnce === true && ordinaryContinue === "reseal") {
    // F2-R4a: silence soft reask, then reseal after continue — budget blocks second reask.
    assert.equal(fixerTurns, 3, `${reask}: one soft reask then one reseal turn`);
    assert.equal(inspectorTurns, 2, `${reask}: continue then converge on reseal`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted", `${reask}: reseal remains accepted`);
    const live = result.admitted?.runDirectory;
    assert.ok(live !== undefined && existsSync(live), `${reask}: live admitted directory`);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), false);
    assert.equal(
      objectPayloads(result.terminal!.roleOutcome).some((p) => p.report === "after audit continue still unbound"),
      true,
      `${reask}: presented volume is the reseal, not a washed prior draft`,
    );
    const attemptKinds = historyPayloads<{ outcome?: { kind?: string } }>(live!, "attempt-history")
      .map((row) => row.outcome?.kind);
    assert.deepEqual(
      attemptKinds,
      ["accepted", "no_receipt", "accepted"],
      `${reask}: seal, soft reask, reseal — no second soft reask`,
    );
    return;
  }
  if (input.inspectorContinuesOnce === true && ordinaryContinue === "no-volume") {
    assert.equal(fixerTurns, 3, `${reask}: one soft reask then one audit-continue turn`);
    // Continue once; ordinary no-volume does not seal again, so no second inspector.
    // After a sealed substitute, outer must not restore/re-audit the original volume (F2-R6).
    assert.equal(inspectorTurns, 1, `${reask}: inspector continue once; no outer restore audit`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt", `${reask}: ordinary continue no-volume publishes`);
    const live = result.admitted?.runDirectory;
    assert.ok(live !== undefined && existsSync(live), `${reask}: live admitted directory`);
    if (reask === "substitute-with-ticket") {
      assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
      assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    } else {
      assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
      assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), false);
    }
    const attemptRows = historyPayloads<{ outcome?: { kind?: string; payloads?: unknown[] } }>(
      live!,
      "attempt-history",
    );
    const attemptKinds = attemptRows.map((row) => row.outcome?.kind);
    const expectedAttempts = reask === "substitute" || reask === "substitute-with-ticket"
      ? ["accepted", "accepted", "no_receipt"]
      : ["accepted", "no_receipt", "no_receipt"];
    assert.deepEqual(
      attemptKinds,
      expectedAttempts,
      `${reask}: attempt history by real dispatch rounds`,
    );
    if (reask === "substitute" || reask === "substitute-with-ticket") {
      const sealedReports = attemptRows
        .filter((row) => row.outcome?.kind === "accepted" || row.outcome?.kind === "audit_escalation")
        .map((row) => {
          const payload = row.outcome?.payloads?.at(-1);
          return isRecord(payload) && typeof payload.report === "string" ? payload.report : undefined;
        });
      assert.deepEqual(
        sealedReports,
        ["original-volume", "substitute-volume"],
        `${reask}: substitute sealed after original; chain must not wash ownership`,
      );
      // inspectorTurns===1 already proves original was not re-audited after ordinary no-volume.
    }
    const durable = readCurrentSection(live!, "terminal") as {
      face?: string;
      body?: { outcome?: { kind?: string } };
    } | undefined;
    assert.equal(durable?.face, "no_receipt", `${reask}: durable face follows ordinary continue`);
    assert.equal(durable?.body?.outcome?.kind, "no_receipt", `${reask}: durable outcome is no_receipt`);
    return;
  }
  assert.equal(fixerTurns, 2, `${reask}: must soft-reask once`);
  assert.ok(roles.includes("inspector"), `${reask}: original sealed submission must still enter audit`);
  assert.equal(result.terminal?.roleOutcome.kind, "accepted", `${reask}: keep original accepted`);
  const live = result.admitted?.runDirectory;
  assert.ok(live !== undefined && existsSync(live), `${reask}: live admitted directory`);
  if (reask === "report-only") {
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
  }
  assert.equal(
    objectPayloads(result.terminal!.roleOutcome).some((p) => p.report === "original-volume"),
    true,
    `${reask}: original sealed payload must remain the presented volume`,
  );
  if (input.foreignCourtPassesAudit === true) {
    // F2-R8: parent台院 must review original-volume bound to original tool call —
    // not skip via foreign-volume's pass record.
    assert.deepEqual(
      parentInspectorReports,
      ["original-volume"],
      `${reask}: parent inspector structured report is original, not foreign`,
    );
    // #1195: parent no longer books officer-pointer copies; gate uses live summons.
    const inspectorPointers = historyPayloads<{ officer?: string }>(live!, "officer-pointer")
      .filter((row) => row.officer === "inspector");
    assert.equal(
      inspectorPointers.length,
      0,
      `${reask}: parent must not book officer-pointer rows`,
    );
  }
  // #419 / F2-R3: real soft-reask attempt appends no_receipt; terminal stays accepted.
  // F2-R7 ledger-only foreign seal does not append attempt-history.
  // F2-R8 real public resume seals foreign-volume → accepted before reask no_receipt.
  const attemptKinds = historyPayloads<{ outcome?: { kind?: string } }>(live!, "attempt-history")
    .map((row) => row.outcome?.kind);
  assert.deepEqual(
    attemptKinds,
    input.foreignCourtPassesAudit === true
      ? ["accepted", "accepted", "no_receipt"]
      : ["accepted", "no_receipt"],
    input.foreignCourtPassesAudit === true
      ? `${reask}: original, foreign public resume, soft-reask no_receipt`
      : `${reask}: attempt history must keep original accepted and append reask no_receipt`,
  );
  const durable = readCurrentSection(live!, "terminal") as {
    face?: string;
    body?: { outcome?: { kind?: string } };
  } | undefined;
  assert.equal(durable?.face, "report", `${reask}: durable face stays report`);
  assert.equal(durable?.body?.outcome?.kind, "accepted", `${reask}: durable outcome stays accepted`);
}

test("#1171 F2 reask report-only keeps original accepted and reaches audit", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000000f2keep",
      reask: "report-only",
    });
  });
});

test("#1171 F2 / F2-R7 reask silence keeps original; foreign-court seal does not steal", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000000f2siln",
      reask: "silence",
    });
  });
});

test("#1171 F2-R8 silence; foreign public seal+pass must not skip original audit", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000f2r8",
      reask: "silence",
      foreignCourtPassesAudit: true,
    });
  });
});

test("#1171 F2-R9 soft reask bad-status+ticket; ordinary status no-volume persists", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000f2r9",
      reask: "bad-status-with-ticket",
      ordinaryContinue: "no-volume",
    });
  });
});

test("#1171 F2-R4a silence then inspector continue reseals once without second soft reask", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000f2r4a",
      reask: "silence",
      inspectorContinuesOnce: true,
      ordinaryContinue: "reseal",
    });
  });
});

test("#1171 F2-R5 silence then inspector continue; ordinary no-volume persists", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000f2r5",
      reask: "silence",
      inspectorContinuesOnce: true,
      ordinaryContinue: "no-volume",
    });
  });
});

test("#1171 F2-R6 substitute then inspector continue; ordinary no-volume owns chain", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000f2r6a",
      reask: "substitute",
      inspectorContinuesOnce: true,
      ordinaryContinue: "no-volume",
    });
  });
});

test("#1171 F2-R6 substitute-with-ticket then continue; ordinary no-volume owns chain", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await assertSoftReaskKeepsAcceptedAndRecordsNoReceiptHistory({
      home,
      project,
      bookKey,
      runId: "01a011710-0000-7000-8000-0000f2r6b",
      reask: "substitute-with-ticket",
      inspectorContinuesOnce: true,
      ordinaryContinue: "no-volume",
    });
  });
});

test("#1171 F3 status-reask exhaustion still issues missing-ticket reask once", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000f3ask";
    const scripted = fixerTurnHost((turn) => {
      if (turn === 1 || turn === 2) {
        return {
          status: "not-a-lawful-status",
          report: `bad status turn ${turn}`,
          classResults: FIXER_DONE.classResults,
        };
      }
      return {
        status: "completed",
        report: "after ticket reask",
        ticketNumber: TICKET,
        classResults: FIXER_DONE.classResults,
      };
    });
    const result = await runPublicInstructionSeat(
      ["apply", "Bad status then ticket."],
      seatEnv(home, project, runId, "pi", scripted.host, { autoResumeLimit: 1 }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.ok(scripted.turns >= 3, `missing-ticket reask must run after status budget; turns=${scripted.turns}`);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});

test("#1171 F8 countersign unbound seal soft-reasks missing ticket once", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000f8ask";
    let countersignTurns = 0;
    let notaryTurns = 0;
    const countersignHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        countersignTurns += 1;
        return scriptedTerminatingToolSession({
          role: "countersign",
          toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
          details: countersignTurns === 1
            ? { status: "converged", note: "no ticket first" }
            : { status: "converged", note: "after reask", ticketNumber: TICKET },
          ...(countersignTurns === 1 ? {} : { sessionWriteMode: "append" as const }),
        })(args, options);
      },
    });
    const review = withPassingReviewHost(countersignHost);
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        if (request.activation.role === "notary") notaryTurns += 1;
        return review.executeTurn(request);
      },
    };
    const result = await runPublicInstructionSeat(
      ["裁：无号卷须补问一次。"],
      seatEnv(home, project, runId, "pi", host),
      captureIo().io,
      "countersign",
      (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(countersignTurns, 2, "exactly one soft reask turn");
    assert.ok(notaryTurns >= 1, "after reask the sealed volume still enters audit");
    assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "countersign")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
  });
});
