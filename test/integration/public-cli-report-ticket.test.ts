/**
 * Mid-turn ticket reports relocate immediately; #1268 never opens a ticket-only
 * turn after a receipt. Public entry + in-repo fake hosts.
 * - pi: native SessionManager.setSessionFile (not envelope MCP)
 * - codex / grok-build: prepareRoleEnvelope MCP mouth (their real seam)
 * Asserts durable placement and typed fields only — never free text / stdout.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { HostContext, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import {
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { roleRuntimeDependenciesWithoutNavigator as createRoleRuntimeDependencies } from "../helpers/role-turn-host-fixture.ts";
import {
  REPORT_TICKET_TOOL_NAME,
  reportTicketFromHostContext,
} from "../../src/report-ticket-tool.ts";
import {
  formatRunLeaf,
  isUnboundRunDirectory,
  runDirectoryFromSessionDirectory,
  sessionDirectoryOf,
  sessionFileOf,
} from "../../src/role-run-placement.ts";
import { resolveHostDossierLandingPath } from "../../src/host-session-record.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
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
import { withOutsideTempRoot } from "../helpers/environment-fixtures.ts";
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
    { name: "claude", create: () => ({ ok: true as const, host }) },
    { name: "grok-build", create: () => ({ ok: true as const, host }) },
    { name: "hermes", create: () => ({ ok: true as const, host }) },
  ];
}

/** Headless / ACP seam: report via envelope MCP, then optional submit. */
function envelopeHostThatReportsThen(input: {
  readonly hostName: "pi" | "codex" | "claude" | "grok-build" | "hermes";
  readonly ticketNumber: number;
  /** When set, each entry is one report call (overrides reportCount + ticketNumber). */
  readonly ticketNumbers?: readonly number[];
  readonly submit?: Record<string, unknown>;
  readonly reportCount?: number;
  readonly beforeReport?: (request: RoleTurnRequest) => void | Promise<void>;
  readonly onAfterReport?: () => void;
  readonly afterReportOnly?: boolean;
  readonly afterSubmitTicket?: unknown;
  readonly expectReportError?: boolean;
  readonly resubmit?: Record<string, unknown>;
  readonly outputToolName?: string;
}) {
  const observations = { turns: 0 };
  const tickets = input.ticketNumbers
    ?? Array.from({ length: input.reportCount ?? 1 }, () => input.ticketNumber);
  return {
    observations,
    async executeTurn(request: RoleTurnRequest) {
      observations.turns += 1;
      // Socket root owned here — dispose closes the sock; finally removes the root (#1199 R5).
      return withOutsideTempRoot("ak-1171-sock-", async (socketDir) => {
        const socketPath = join(socketDir, "mcp.sock");
        const prepared = await prepareRoleEnvelope({
          request: { ...request, host: input.hostName },
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath,
          listTerminatingToolOnMcp: input.hostName !== "codex" && input.hostName !== "claude",
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
            if (input.hostName !== "codex" && input.hostName !== "claude") {
              await callMcpTool({
                socketPath, token, name: input.outputToolName ?? FIXER_OUTPUT_TOOL_NAME, args: input.submit,
              });
            } else {
              await prepared.ingestStructuredOutput(input.submit);
            }
          }
          if (input.afterSubmitTicket !== undefined) {
            const reported = await callMcpTool({ socketPath, token, name: REPORT_TICKET_TOOL_NAME, args: { ticketNumber: input.afterSubmitTicket } });
            assert.equal(reported.isError === true, input.expectReportError === true);
          }
          if (input.resubmit !== undefined) {
            await callMcpTool({ socketPath, token, name: input.outputToolName ?? FIXER_OUTPUT_TOOL_NAME, args: input.resubmit });
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
      });
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
      const runDirectory = runDirectoryFromSessionDirectory(oldSessionDir);
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
              const targetRun = runDirectoryFromSessionDirectory(coordinates.sessionDirectory);
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
        if (args[i - 1] === "--session-dir") return [dirname(newSession)]; // session file parent = session dir
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
    assert.ok(observed.sessionFile?.startsWith(sessionDirectoryOf(ticket)));
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
        // #1199: envelope hosts publish ticket progress pointing at the host-original
        // landing path (ADR 0086: missing copy does not change the pointer contract).
        if (caseRow.submit !== undefined) {
          const ticketSubject = join(home, ".ak-roles", "books", bookKey, String(TICKET));
          const progress = readTicketProgressLines(ticketSubject)
            .filter((line) => line.seat === "fixer");
          const landing = resolveHostDossierLandingPath({
            host: caseRow.hostName,
            sessionDirectory: sessionDirectoryOf(placement),
          });
          assert.equal(
            join(ticketSubject, progress[progress.length - 1]!.session),
            landing,
            `${caseRow.name}: progress session is host original landing`,
          );
          assert.equal(existsSync(join(ticketSubject, progress[progress.length - 1]!.receipt)), true);
        }
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

test("#1268 unbound submission stays accepted without opening another turn", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await writeFile(join(home, ".ak-roles", "host-providers.json"), JSON.stringify({ hermes: { test: "test" } }));
    for (const hostName of ["pi", "grok-build", "hermes", "claude", "codex"] as const) {
      const nativeOutput = hostName === "claude" || hostName === "codex";
      for (const action of nativeOutput ? ["end"] as const : ["end", "report", "invalid", "resubmit", "bound", "inline"] as const) {
        const runId = `1268-${hostName}-${action}`;
        const scripted = envelopeHostThatReportsThen({
          hostName,
          ticketNumber: TICKET,
          ticketNumbers: action === "bound" ? [TICKET] : [],
          outputToolName: REVIEWER_OUTPUT_TOOL_NAME,
          submit: { status: "completed", amendments: { completeness: "No amendments." }, revision: 1, ...(action === "inline" ? { ticketNumber: TICKET } : {}) },
          ...(action === "report" || action === "invalid" ? {
            afterSubmitTicket: action === "report" ? TICKET : "mypy-15105",
            expectReportError: action === "invalid",
          } : {}),
          ...(action === "resubmit" ? { resubmit: { status: "refused", report: "no ticket", revision: 2 } } : {}),
        });
        const host = withPassingReviewHost(scripted);
        const captured = captureIo();
        const result = await runAkRole([
          "reviewer", "--base", "HEAD", "--lens", "completeness", "--authority-ref", "CLAUDE.md",
          "--host", hostName, "--model", "test/caller-seat:high", "Review without a ticket declared at entry.",
        ], { ...seatEnv(home, project, runId, hostName, host, { hostAdapters: nestAdaptersFor(host) }), io: captured.io });
        assert.equal(scripted.observations.turns, 1, `${hostName}/${action}: no ticket-only or delivery turn`);
        assert.equal(result.exitCode, 0);
        assert.equal(result.terminal?.roleOutcome.kind, "accepted");
        assert.equal(objectPayloads(result.terminal!.roleOutcome).at(-1)?.revision, action === "resubmit" ? 2 : 1);
        const bound = action === "report" || action === "bound" || action === "inline";
        const leaf = bound ? ticketLeaf(home, bookKey, TICKET, runId, "reviewer") : unboundLeaf(home, bookKey, runId, "reviewer");
        assert.equal(existsSync(leaf), true);
        assert.equal(readCurrentSection(leaf, "admitted")?.ticketNumber, bound ? TICKET : undefined);
        const progress = readTicketProgressLines(join(home, ".ak-roles", "books", bookKey, bound ? String(TICKET) : "unbound"));
        const rows = progress.filter((row) => row.receipt.startsWith(`runs/${formatRunLeaf(runId, "reviewer")}/`));
        assert.equal(rows.length, action === "resubmit" ? 2 : 1);
      }
    }
  });
});

test("#1171 submit with ticketNumber and no report tool: bind as today, no reask", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000direct";
    const instruction = "Repair #1171.";
    const attachPath = join(project, "caller-evidence.json");
    await writeFile(attachPath, `${JSON.stringify({ note: "attach" })}\n`, "utf8");
    const headAtSeal = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      encoding: "utf8",
    }).trim();
    // Unknown extra field must stay in the receipt JSON as sealed (票面原样回执).
    const submit = {
      status: "completed",
      report: "direct ticket",
      summary: "direct bind short summary text here ok",
      ticketNumber: TICKET,
      classResults: FIXER_DONE.classResults,
      unexpectedExtra: { kept: true, n: 3 },
    } as const;
    let transportPrompt = "";
    const scripted = fixerTurnHost(() => ({ ...submit }));
    const host = withPassingReviewHost({
      async executeTurn(request: RoleTurnRequest) {
        transportPrompt = request.continuation.prompt;
        return scripted.host.executeTurn(request);
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", instruction, "--attach", attachPath],
      seatEnv(home, project, runId, "pi", host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(scripted.turns, 1);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, TICKET);
    // #1199: progress + whole receipt JSON + head; no model/host/thinking columns.
    // Progress instruction is the bytes actually sent (file-flag wrap included).
    assert.equal(transportPrompt.includes("--attach"), true);
    assert.notEqual(transportPrompt, instruction);
    const ticketDir = join(home, ".ak-roles", "books", bookKey, String(TICKET));
    const unboundDir = join(home, ".ak-roles", "books", bookKey, "unbound");
    const fixerLines = readTicketProgressLines(ticketDir).filter((line) => line.seat === "fixer");
    assert.equal(fixerLines.length, 1);
    assert.equal(fixerLines[0]!.instruction, transportPrompt);
    assert.equal(fixerLines[0]!.head, headAtSeal);
    assert.equal(fixerLines[0]!.round, "1");
    assert.equal(fixerLines[0]!.status, "completed");
    assert.equal(fixerLines[0]!.summary, submit.summary);
    assert.equal(existsSync(join(ticketDir, fixerLines[0]!.receipt)), true);
    assert.equal(existsSync(join(ticketDir, fixerLines[0]!.session)), true);
    assert.deepEqual(
      JSON.parse(await readFile(join(ticketDir, fixerLines[0]!.receipt), "utf8")),
      submit,
    );
    assert.equal(
      readTicketProgressLines(unboundDir).some((line) => line.session.includes(runId)),
      false,
    );
    assert.equal(
      fixerLines[0]!.session,
      `runs/${formatRunLeaf(runId, "fixer")}/session/session.jsonl`,
    );
    assert.equal(
      fixerLines[0]!.receipt,
      `runs/${formatRunLeaf(runId, "fixer")}/receipts/1.json`,
    );

    // Same seat, new session: rounds accumulate; sessions differ.
    const runId2 = "01a011710-0000-7000-8000-0000000dire2";
    const secondInstruction = "Second session on same ticket.";
    const second = fixerTurnHost(() => ({
      status: "completed",
      report: "second session",
      summary: "second session summary text here ok",
      ticketNumber: TICKET,
      classResults: FIXER_DONE.classResults,
    }));
    const secondResult = await runPublicInstructionSeat(
      ["apply", secondInstruction],
      seatEnv(home, project, runId2, "pi", second.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(secondResult.exitCode, 0, `${secondResult.terminal?.roleOutcome.kind}`);
    const after = readTicketProgressLines(ticketDir).filter((line) => line.seat === "fixer");
    assert.equal(after.length, 2);
    assert.equal(after[1]!.round, "2");
    assert.equal(after[1]!.instruction, secondInstruction);
    assert.notEqual(after[0]!.session, after[1]!.session);
  });
});

test("#1199 public resume relocate: ticket current write fail keeps leg staging after rename", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-relfail01";
    const stayId = "01a011710-0000-7000-8000-relstay01";
    const otherId = "01a011710-0000-7000-8000-relother1";
    const moveSeedSubmit = {
      status: "completed",
      report: `seed-${runId}-1`,
      summary: `unbound sealed summary for ${runId} here`,
      classResults: FIXER_DONE.classResults,
    } as const;
    const staySeedSubmit = {
      status: "completed",
      report: `seed-${stayId}-1`,
      summary: `unbound sealed summary for ${stayId} here`,
      classResults: FIXER_DONE.classResults,
    } as const;
    // Sibling stays unbound; only moveId relocates (isolation).
    for (const [id, submit] of [[runId, moveSeedSubmit], [stayId, staySeedSubmit]] as const) {
      const seed = fixerTurnHost(() => ({ ...submit }));
      await runPublicInstructionSeat(
        ["apply", `Seed unbound ${id}`],
        seatEnv(home, project, id, "pi", seed.host),
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(existsSync(unboundLeaf(home, bookKey, id, "fixer")), true);
    }
    const unboundDir = join(home, ".ak-roles", "books", bookKey, "unbound");
    const beforeMove = readTicketProgressLines(unboundDir)
      .filter((line) => line.session.includes(runId));
    const beforeStay = readTicketProgressLines(unboundDir)
      .filter((line) => line.session.includes(stayId));
    assert.ok(beforeMove.length >= 1, "move leg must stage progress before bind");
    assert.ok(beforeStay.length >= 1, "stay leg must stage progress before bind");
    // #1199 R1: staged session + whole receipt JSON must stay reachable after fail.
    for (const row of beforeMove) {
      assert.equal(existsSync(join(unboundDir, row.receipt)), true, row.receipt);
      assert.equal(existsSync(join(unboundDir, row.session)), true, row.session);
      assert.deepEqual(
        JSON.parse(await readFile(join(unboundDir, row.receipt), "utf8")),
        moveSeedSubmit,
      );
    }

    const ticketSubject = join(home, ".ak-roles", "books", bookKey, String(TICKET));
    await mkdir(ticketSubject, { recursive: true });
    const currentPath = join(ticketSubject, "current.jsonl");
    await writeFile(currentPath, "", "utf8");
    chmodSync(currentPath, 0o444);

    const bind = fixerTurnHost(() => ({
      status: "completed",
      report: "bind after unbound",
      summary: "bind summary text here is long enough",
      ticketNumber: TICKET,
      classResults: FIXER_DONE.classResults,
    }));
    let firstExit = 0;
    try {
      const firstBind = await runPublicInstructionSeatResume(
        { runId, message: "declare ticket after unbound seal" },
        seatEnv(home, project, runId, "pi", bind.host),
        captureIo().io,
      );
      firstExit = firstBind.exitCode;
    } catch {
      firstExit = 1;
    }
    assert.notEqual(firstExit, 0, "target current append fail must not wash to exit 0");

    // Whole-leg rename commits before ticket append; staging stays on the ticket leg.
    const movedLeaf = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(movedLeaf), true, "rename must commit before ticket append");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    const stagedProgressPath = join(movedLeaf, "progress.jsonl");
    assert.equal(
      existsSync(stagedProgressPath),
      true,
      "private progress file must remain when target append fails",
    );
    const stagedLines = (await readFile(stagedProgressPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { receipt: string; session: string }];
        } catch {
          return [];
        }
      });
    assert.ok(stagedLines.length >= beforeMove.length, "staging rows survive failed append");
    const stagingReceipts: unknown[] = [];
    for (const row of stagedLines) {
      assert.equal(existsSync(join(ticketSubject, row.receipt)), true, `failed-leg receipt ${row.receipt}`);
      assert.equal(existsSync(join(ticketSubject, row.session)), true, `failed-leg session ${row.session}`);
      const receipt = JSON.parse(await readFile(join(ticketSubject, row.receipt), "utf8")) as unknown;
      stagingReceipts.push(receipt);
    }
    assert.ok(
      stagingReceipts.some((receipt) => JSON.stringify(receipt) === JSON.stringify(moveSeedSubmit)),
      "failed-leg must retain the seed sealed receipt JSON",
    );
    // Sibling isolation: stay leg untouched whether bind threw or not.
    const afterStay = readTicketProgressLines(unboundDir)
      .filter((line) => line.session.includes(stayId));
    assert.equal(afterStay.length, beforeStay.length);
    for (const row of afterStay) {
      assert.equal(existsSync(join(unboundDir, row.receipt)), true);
      assert.deepEqual(
        JSON.parse(await readFile(join(unboundDir, row.receipt), "utf8")),
        staySeedSubmit,
      );
    }

    // Peer session on the same ticket publishes normally while staging stays.
    chmodSync(currentPath, 0o644);
    const otherSubmit = {
      status: "completed",
      report: "other-session",
      summary: "other session summary text here is long enough",
      ticketNumber: TICKET,
      classResults: FIXER_DONE.classResults,
    } as const;
    const other = fixerTurnHost(() => ({ ...otherSubmit }));
    const otherResult = await runPublicInstructionSeat(
      ["apply", "peer session while relocate staging held"],
      seatEnv(home, project, otherId, "pi", other.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(otherResult.exitCode, 0, `${otherResult.terminal?.roleOutcome.kind}`);
    const peerRows = readTicketProgressLines(ticketSubject)
      .filter((line) => line.seat === "fixer" && line.session.includes(otherId));
    assert.equal(peerRows.length, 1);
    assert.equal(peerRows[0]!.round, "1");
    assert.deepEqual(
      JSON.parse(await readFile(join(ticketSubject, peerRows[0]!.receipt), "utf8")),
      otherSubmit,
    );
    // Staging for the failed bind leg must still be intact after the peer seal.
    assert.equal(existsSync(stagedProgressPath), true, "peer seal must not drop failed-leg staging");
    for (const row of stagedLines) {
      assert.equal(existsSync(join(ticketSubject, row.receipt)), true, row.receipt);
      assert.equal(existsSync(join(ticketSubject, row.session)), true, row.session);
    }
    for (const expected of stagingReceipts) {
      assert.ok(
        stagedLines.some((row) => {
          const path = join(ticketSubject, row.receipt);
          return existsSync(path)
            && JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === JSON.stringify(expected);
        }),
        "peer seal must not destroy failed-leg staging receipt JSON",
      );
    }

    // Retry bind — every pre-retry staging receipt must land on the ticket intact.
    const rebindSubmit = {
      status: "completed",
      report: "rebind after restore",
      summary: "rebind summary text here is long enough",
      ticketNumber: TICKET,
      classResults: FIXER_DONE.classResults,
    } as const;
    const rebind = fixerTurnHost(() => ({ ...rebindSubmit }));
    const rebound = await runPublicInstructionSeatResume(
      { runId, message: "retry declare ticket after restore" },
      seatEnv(home, project, runId, "pi", rebind.host),
      captureIo().io,
    );
    assert.equal(rebound.exitCode, 0, `${rebound.terminal?.roleOutcome.kind}`);
    assert.equal(existsSync(stagedProgressPath), false, "successful publish drops staging");
    const ticketRows = readTicketProgressLines(ticketSubject)
      .filter((line) => line.seat === "fixer");
    assert.ok(ticketRows.some((line) => line.session.includes(otherId)), "peer row remains");
    const relocated = ticketRows.filter((line) => line.session.includes(runId));
    assert.ok(relocated.length >= stagingReceipts.length, "relocated rows cover pre-retry staging");
    for (const row of relocated) {
      assert.equal(existsSync(join(ticketSubject, row.receipt)), true, row.receipt);
      assert.equal(existsSync(join(ticketSubject, row.session)), true, row.session);
      assert.equal(row.session.includes("/unbound/"), false, row.session);
    }
    const ticketReceipts = await Promise.all(
      relocated.map(async (row) =>
        JSON.parse(await readFile(join(ticketSubject, row.receipt), "utf8")) as unknown
      ),
    );
    for (const expected of stagingReceipts) {
      assert.ok(
        ticketReceipts.some((receipt) => JSON.stringify(receipt) === JSON.stringify(expected)),
        "each pre-retry staging receipt JSON must publish on the ticket",
      );
    }
    assert.ok(
      ticketReceipts.some((receipt) => JSON.stringify(receipt) === JSON.stringify(rebindSubmit)),
      "rebind seal receipt must publish",
    );
  });
});

test("#1199 same-envelope 催交原文 is the progress instruction (not first mint)", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-progresume";
    const firstInstruction = "first summons for progress resume";
    const seenPrompts: string[] = [];
    // Same prepared envelope: first completed seals → commit reminder retry;
    // second completed accepts. Progress instruction must be the retry bytes.
    const host = withPassingReviewHost({
      async executeTurn(request: RoleTurnRequest) {
        return withOutsideTempRoot("ak-1199-retry-", async (socketDir) => {
          const socketPath = join(socketDir, "mcp.sock");
          const prepared = await prepareRoleEnvelope({
            request: { ...request, host: "codex" },
            dependencies: createRoleRuntimeDependencies(packageRoot),
            socketPath,
            sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
            principalAuthority: piDurablePrincipalAuthority,
          });
          try {
            process.env.AK_ROLE_RUN_DIR = request.runDirectory;
            let sealed = false;
            return await driveExternalRoleTurnRounds(prepared, request, {
              roundLimitName: "ReportTicketRoundLimit",
              currentSessionId: () => undefined,
              async runRound({ prompt }) {
                seenPrompts.push(prompt);
                await callMcpTool({
                  socketPath,
                  token: mcpTokenFromPrepared(prepared),
                  name: REPORT_TICKET_TOOL_NAME,
                  args: { ticketNumber: TICKET },
                });
                await prepared.ingestStructuredOutput({
                  status: "completed",
                  report: sealed ? "sealed after commit reminder" : "first completed without commit",
                  summary: "summary after envelope retry text ok",
                  classResults: FIXER_DONE.classResults,
                });
                sealed = true;
                return { status: "delivered" as const };
              },
            });
          } finally {
            delete process.env.AK_ROLE_RUN_DIR;
            await prepared.dispose?.();
          }
        });
      },
    });
    const first = await runPublicInstructionSeat(
      ["apply", firstInstruction],
      {
        ...seatEnv(home, project, runId, "codex", host),
        hostAdapters: nestAdaptersFor(host),
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(first.exitCode, 0, `${first.terminal?.roleOutcome.kind}`);
    assert.ok(seenPrompts.length >= 2, `same-envelope retry must run; seen=${seenPrompts.length}`);
    const ticketDir = join(home, ".ak-roles", "books", bookKey, String(TICKET));
    const lines = readTicketProgressLines(ticketDir).filter((line) => line.seat === "fixer");
    assert.equal(lines.length, 1);
    assert.notEqual(lines[0]!.instruction, firstInstruction);
    assert.equal(lines[0]!.instruction, seenPrompts[1]);
    assert.equal(existsSync(join(ticketDir, lines[0]!.receipt)), true);
  });
});

test("#1199 public resume/auto-resume: instruction/head; same session; distinct worktree heads", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-proghead";
    const firstInstruction = "first summons for head resume";
    let fixerTurns = 0;
    let autoSummons: string | undefined;
    const base = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        fixerTurns += 1;
        if (fixerTurns === 1) {
          // Host failure → in-call auto-resume on the same session original.
          const sessionFile = args.includes("--session")
            ? args[args.indexOf("--session") + 1]
            : undefined;
          if (typeof sessionFile === "string") {
            await mkdir(dirname(sessionFile), { recursive: true });
            await writeFile(
              sessionFile,
              `${JSON.stringify({ type: "message", role: "user", content: "pre-fail" })}\n`,
              "utf8",
            );
          }
          return { code: 1, timedOut: false, stderr: "quota", args: [...args] };
        }
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            status: "completed",
            report: `done-${fixerTurns}`,
            summary: `summary for round ${fixerTurns} text here ok`,
            ticketNumber: TICKET,
            classResults: FIXER_DONE.classResults,
          },
          toolCallId: `call_head_${fixerTurns}`,
          sessionWriteMode: "append",
        })(args, options);
      },
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        if (request.continuation.kind === "resume") {
          // #1199: progress instruction is this-turn prompt (not first mint).
          autoSummons = request.continuation.prompt;
        }
        return withPassingReviewHost(base).executeTurn(request);
      },
    };
    const first = await runPublicInstructionSeat(
      ["apply", firstInstruction],
      {
        ...seatEnv(home, project, runId, "pi", host, { autoResumeLimit: 1 }),
        boundTicketNumber: TICKET,
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(first.exitCode, 0, `${first.terminal?.roleOutcome.kind}`);
    assert.ok(fixerTurns >= 2, `auto-resume must run; turns=${fixerTurns}`);
    const ticketDir = join(home, ".ak-roles", "books", bookKey, String(TICKET));
    const lines = readTicketProgressLines(ticketDir).filter((line) => line.seat === "fixer");
    assert.equal(lines.length, 1);
    // #1208 resends current dialogue; #1199 records those same actual bytes.
    assert.equal(lines[0]!.instruction, firstInstruction);
    assert.equal(autoSummons, firstInstruction);
    const sessionRel = lines[0]!.session;
    const head1 = lines[0]!.head;

    await writeFile(join(project, "advance-1199.txt"), "round-2\n", "utf8");
    execFileSync("git", ["add", "advance-1199.txt"], { cwd: project });
    execFileSync("git", ["commit", "-m", "advance head for progress"], { cwd: project });
    const head2 = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      encoding: "utf8",
    }).trim();
    assert.notEqual(head1, head2);

    const resumeInstruction = "resume summons after head advance";
    const resumeHost = withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => scriptedTerminatingToolSession({
        role: "fixer",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        details: {
          status: "completed",
          report: "resume sealed",
          summary: "resume round summary text here ok",
          ticketNumber: TICKET,
          classResults: FIXER_DONE.classResults,
        },
        sessionWriteMode: "append",
      })(args, options),
    }));
    const resumed = await runPublicInstructionSeatResume(
      { runId, message: resumeInstruction },
      seatEnv(home, project, runId, "pi", resumeHost),
      captureIo().io,
    );
    assert.equal(resumed.exitCode, 0, `${resumed.terminal?.roleOutcome.kind}`);
    const after = readTicketProgressLines(ticketDir).filter((line) => line.seat === "fixer");
    assert.equal(after.length, 2);
    assert.equal(after[0]!.head, head1);
    assert.equal(after[1]!.instruction, resumeInstruction);
    assert.equal(after[1]!.head, head2);
    assert.equal(after[0]!.session, after[1]!.session);
    assert.equal(after[0]!.session, sessionRel);
    assert.equal(existsSync(join(ticketDir, after[0]!.session)), true);
    assert.equal(existsSync(join(ticketDir, after[1]!.receipt)), true);

    // Distinct linked worktree: second seat cwd HEAD differs from project.
    const projectB = join(home, "project-b");
    execFileSync("git", ["branch", "work-b"], { cwd: project });
    execFileSync("git", ["worktree", "add", projectB, "work-b"], { cwd: project });
    await writeFile(join(projectB, "other-1199.txt"), "b-side\n", "utf8");
    execFileSync("git", ["add", "other-1199.txt"], { cwd: projectB });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "project-b head"], {
      cwd: projectB,
    });
    const headB = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectB,
      encoding: "utf8",
    }).trim();
    assert.notEqual(head2, headB);
    const runB = "01a011710-0000-7000-8000-progheadb";
    const hostB = withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => scriptedTerminatingToolSession({
        role: "fixer",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        details: {
          status: "completed",
          report: "worktree-b",
          summary: "worktree B summary text here ok",
          ticketNumber: TICKET,
          classResults: FIXER_DONE.classResults,
        },
      })(args, options),
    }));
    const second = await runPublicInstructionSeat(
      ["apply", "summons from linked worktree B"],
      {
        ...seatEnv(home, projectB, runB, "pi", hostB),
        boundTicketNumber: TICKET,
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(second.exitCode, 0, `${second.terminal?.roleOutcome.kind}`);
    const withB = readTicketProgressLines(ticketDir).filter((line) => line.seat === "fixer");
    const rowB = withB.find((line) => line.session.includes(runB));
    assert.equal(rowB!.head, headB);
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
    assert.ok(resumeSession?.startsWith(sessionDirectoryOf(live)));
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), false);
    assert.equal(resumed.admitted?.runDirectory, live);
    // #1183: public resume keeps current.json location paths on the ticket leaf.
    assertCurrentLocationPaths(live, "public resume after relocate");
  });
});

test("#1268 public resume accepts an unbound receipt without another turn", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000resreask";
    // Seed an unbound receipt, then submit a new receipt on explicit resume.
    const seed = fixerTurnHost(() => ({
      status: "completed",
      report: "seed unbound receipt",
      classResults: FIXER_DONE.classResults,
    }));
    await runPublicInstructionSeat(
      ["apply", "Seed unbound sealed receipt."],
      seatEnv(home, project, runId, "pi", seed.host),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(seed.turns, 1);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);

    const resumed = fixerTurnHost(() => ({
      status: "completed",
      report: "resume no ticket",
      classResults: FIXER_DONE.classResults,
    }));
    const result = await runPublicInstructionSeatResume(
      { runId, message: "resume without ticket" },
      seatEnv(home, project, runId, "pi", resumed.host),
      captureIo().io,
    );
    assert.equal(resumed.turns, 1, "resume must not open a ticket-only turn");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(objectPayloads(result.terminal!.roleOutcome).at(-1)?.status, "completed");
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

test("#1268 status-reask exhaustion does not open a ticket-only turn", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011710-0000-7000-8000-0000000f3ask";
    const scripted = fixerTurnHost(() => ({
      status: "not-a-lawful-status",
      report: "unreadable status",
      classResults: FIXER_DONE.classResults,
    }));
    const result = await runPublicInstructionSeat(
      ["apply", "Unreadable status without ticket."],
      seatEnv(home, project, runId, "pi", scripted.host, { autoResumeLimit: 1 }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(scripted.turns, 2);
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "fixer")), true);
    assert.equal(result.admitted?.ticketNumber, undefined);
  });
});

test("#1268 countersign unbound receipt still reaches audit without a ticket-only turn", async () => {
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
          details: { status: "converged", note: "no ticket" },
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
      ["裁：无号卷照常送审。"],
      seatEnv(home, project, runId, "pi", host),
      captureIo().io,
      "countersign",
      (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(countersignTurns, 1);
    assert.ok(notaryTurns >= 1, "sealed volume still enters audit");
    assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(existsSync(unboundLeaf(home, bookKey, runId, "countersign")), true);
    assert.equal(result.admitted?.ticketNumber, undefined);
  });
});
