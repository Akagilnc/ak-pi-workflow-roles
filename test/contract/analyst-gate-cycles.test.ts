/**
 * #446 analyst gate-cycle metric family — real-entry tracers only.
 *
 * Seams proved here:
 * - runAnalyst issue page → gateCycles (historical + current officer faces,
 *   zero-round siblings, rejected/missing terminal receipt, damaged JSONL)
 * - runAnalyst cohort → gateCyclesByOfficer fold from ensured pages
 * - #636 D: shared ticket-seat main volume → per-run frame span via run binding
 *
 * Oracles are hand values from fixture volumes (typed status / span / findings
 * length only) — never findings prose. No permanent internal-reader parallel.
 */
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import type { AnalystB2FrameBucketsActionsSection } from "../../src/analyst-metric-families/b2-frame-buckets-actions.ts";
import type { AnalystGateCyclesSection } from "../../src/analyst-metric-families/gate-cycles.ts";
import type { AnalystLegWallClockSection } from "../../src/analyst-metric-families/leg-wall-clock.ts";
import type { AnalystIssueMetricsPage } from "../../src/analyst-page.ts";
import {
  TICKET_SEAT_RUN_BINDING_ENTRY_TYPE,
  ticketSeatMemorySessionDirectory,
} from "../../src/ticket-seat-memory.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/analyst/home");

const ISSUE_PROJECT_ROOT = "/analyst-fixture/issue-demo";
const BOOK = "fixture-book";
/** Existing judge leg — inject auditor-roles here inside temp HOME. */
const GATE_JUDGE_RUN = "019ff000-0002-7000-8000-0000000000b2";
const GATE_JUDGE_DIR = `${GATE_JUDGE_RUN}@judge`;

/**
 * Hand oracle for the 7-round historical-name fixture (menxia/fubaolang):
 * bounce×5 + pass×2; soul-audit noise must not form a round.
 * Walls (ms): 10000,20000,30000,40000,50000,60000,70000 → mean 40000.
 * bounceRate = 5/7.
 */
const EXPECTED_SEVEN_ROUNDS = [
  { roundIndex: 1, officer: "notary" as const, status: "bounce", officerWallMs: 10000, findingsCount: 3, origin: { kind: "historical_dispatch" as const } },
  { roundIndex: 2, officer: "notary" as const, status: "bounce", officerWallMs: 20000, findingsCount: 1, origin: { kind: "historical_dispatch" as const } },
  { roundIndex: 3, officer: "notary" as const, status: "bounce", officerWallMs: 30000, findingsCount: 1, origin: { kind: "historical_dispatch" as const } },
  { roundIndex: 4, officer: "notary" as const, status: "bounce", officerWallMs: 40000, findingsCount: 1, origin: { kind: "historical_dispatch" as const } },
  { roundIndex: 5, officer: "notary" as const, status: "pass", officerWallMs: 50000, findingsCount: 0, origin: { kind: "historical_dispatch" as const } },
  { roundIndex: 6, officer: "notary" as const, status: "bounce", officerWallMs: 60000, findingsCount: 1, origin: { kind: "historical_dispatch" as const } },
  { roundIndex: 7, officer: "notary" as const, status: "pass", officerWallMs: 70000, findingsCount: 0, origin: { kind: "historical_dispatch" as const } },
];

function iso(msFromBase: number): string {
  // Base 2026-08-24T04:00:00.000Z
  return new Date(Date.parse("2026-08-24T04:00:00.000Z") + msFromBase).toISOString();
}

async function writeSevenRoundHistoricalFixture(auditorDir: string): Promise<void> {
  await mkdir(auditorDir, { recursive: true });
  const rounds: Array<{
    dStart: number;
    dEnd: number;
    oStart: number;
    oEnd: number;
    status: "bounce" | "pass";
    findings: unknown[];
  }> = [
    { dStart: 0, dEnd: 5_000, oStart: 5_000, oEnd: 15_000, status: "bounce", findings: ["a", "b", "c"] },
    { dStart: 20_000, dEnd: 25_000, oStart: 25_000, oEnd: 45_000, status: "bounce", findings: ["a"] },
    { dStart: 50_000, dEnd: 55_000, oStart: 55_000, oEnd: 85_000, status: "bounce", findings: ["a"] },
    { dStart: 90_000, dEnd: 95_000, oStart: 95_000, oEnd: 135_000, status: "bounce", findings: ["a"] },
    { dStart: 140_000, dEnd: 145_000, oStart: 145_000, oEnd: 195_000, status: "pass", findings: [] },
    // soul-audit noise between r5 and r6 — must not pair
    { dStart: 200_000, dEnd: 205_000, oStart: 205_000, oEnd: 265_000, status: "bounce", findings: ["a"] },
    { dStart: 270_000, dEnd: 275_000, oStart: 275_000, oEnd: 345_000, status: "pass", findings: [] },
  ];

  let fileSeq = 0;
  for (const [index, round] of rounds.entries()) {
    fileSeq += 1;
    await writeFile(
      join(auditorDir, `d${String(fileSeq).padStart(2, "0")}_menxia.jsonl`),
      gateToolSessionJsonl({
        id: `disp-${index + 1}`,
        startedAt: iso(round.dStart),
        endedAt: iso(round.dEnd),
        toolName: "ak_menxia_output",
        args: { status: "dispatch", officer: "fubaolang" },
        attemptEntryId: `attempt-${index + 1}`,
      }),
      "utf8",
    );
    fileSeq += 1;
    await writeFile(
      join(auditorDir, `o${String(fileSeq).padStart(2, "0")}_fubaolang.jsonl`),
      gateToolSessionJsonl({
        id: `off-${index + 1}`,
        startedAt: iso(round.oStart),
        endedAt: iso(round.oEnd),
        toolName: "ak_fubaolang_output",
        args: { status: round.status, findings: round.findings },
        attemptEntryId: `attempt-${index + 1}`,
      }),
      "utf8",
    );
    if (index === 4) {
      // Insert soul-audit volume after pass r5
      fileSeq += 1;
      await writeFile(
        join(auditorDir, `s${String(fileSeq).padStart(2, "0")}_soul.jsonl`),
        gateToolSessionJsonl({
          id: "soul-noise",
          startedAt: iso(196_000),
          endedAt: iso(199_000),
          toolName: "ak_soul_audit_decision",
          args: { status: "pass" },
        }),
        "utf8",
      );
    }
  }
}

async function writeCurrentNameSingleRound(auditorDir: string): Promise<void> {
  await mkdir(auditorDir, { recursive: true });
  await writeFile(
    join(auditorDir, "o01_inspector.jsonl"),
    gateToolSessionJsonl({
      id: "off-cur",
      startedAt: iso(1_000),
      endedAt: iso(11_000),
      toolName: "ak_inspector_output",
      args: { status: "bounce", findings: ["x", "y"] },
    }),
    "utf8",
  );
}

/** One lawful accepted round + rejected / orphan terminals that must not steal later direct officers. */
async function writeRejectedTerminalFixture(auditorDir: string): Promise<void> {
  await mkdir(auditorDir, { recursive: true });
  // Lawful round 1 (current English faces) — shared durable attempt association.
  await writeFile(
    join(auditorDir, "d01_gatekeeper.jsonl"),
    gateToolSessionJsonl({
      id: "disp-ok",
      startedAt: iso(0),
      endedAt: iso(1_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
      attemptEntryId: "attempt-lawful",
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o02_inspector.jsonl"),
    gateToolSessionJsonl({
      id: "off-ok",
      startedAt: iso(1_000),
      endedAt: iso(11_000),
      toolName: "ak_inspector_output",
      args: { status: "pass", findings: [] },
      attemptEntryId: "attempt-lawful",
    }),
    "utf8",
  );
  // Accepted orphan same-seat dispatch — must not consume a later direct officer.
  await writeFile(
    join(auditorDir, "d03_gatekeeper_orphan.jsonl"),
    gateToolSessionJsonl({
      id: "disp-orphan",
      startedAt: iso(15_000),
      endedAt: iso(16_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
      attemptEntryId: "attempt-orphan",
    }),
    "utf8",
  );
  // Rejected dispatch — must not open a round even with a later officer
  await writeFile(
    join(auditorDir, "d04_gatekeeper_rejected.jsonl"),
    gateToolSessionJsonl({
      id: "disp-rej",
      startedAt: iso(20_000),
      endedAt: iso(21_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
      receipt: "rejected",
      attemptEntryId: "attempt-rejected",
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o05_inspector_after_rej.jsonl"),
    gateToolSessionJsonl({
      id: "off-after-rej",
      startedAt: iso(21_000),
      endedAt: iso(31_000),
      toolName: "ak_inspector_output",
      args: { status: "bounce", findings: ["z"] },
      attemptEntryId: "attempt-direct",
    }),
    "utf8",
  );
  // Accepted dispatch + officer toolCall with no toolResult — unpaired, not a round
  await writeFile(
    join(auditorDir, "d06_gatekeeper_orphan_notary.jsonl"),
    gateToolSessionJsonl({
      id: "disp-orphan-notary",
      startedAt: iso(40_000),
      endedAt: iso(41_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "notary" },
      attemptEntryId: "attempt-orphan-notary",
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o07_notary_no_result.jsonl"),
    gateToolSessionJsonl({
      id: "off-no-result",
      startedAt: iso(41_000),
      endedAt: iso(51_000),
      toolName: "ak_notary_output",
      args: { status: "pass", findings: [] },
      receipt: "omit",
      attemptEntryId: "attempt-orphan-notary",
    }),
    "utf8",
  );
}

function gateSection(page: AnalystIssueMetricsPage): AnalystGateCyclesSection {
  const bag = page as AnalystIssueMetricsPage & {
    readonly gateCycles?: AnalystGateCyclesSection;
  };
  assert.ok(bag.gateCycles, "gate-cycles family must contribute gateCycles via A2 assembly");
  return bag.gateCycles;
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "analyst-gate-home-"));
  try {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function judgeAuditorDir(home: string): string {
  return join(
    home,
    ".ak-roles",
    "books",
    BOOK,
    "runs",
    GATE_JUDGE_DIR,
    "session",
    "auditor-roles",
  );
}

test("analyst gate-cycles via runAnalyst: historical 7-round + zero-round siblings", async () => {
  await withTempHome(async (home) => {
    await writeSevenRoundHistoricalFixture(judgeAuditorDir(home));

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    const section = gateSection(result.page);

    const gateLeg = section.legs.find((leg) => leg.runId === GATE_JUDGE_RUN);
    assert.ok(gateLeg, "judge leg with auditor-roles must appear");
    assert.equal(gateLeg.roundCount, 7);
    assert.deepEqual(gateLeg.rounds, EXPECTED_SEVEN_ROUNDS);

    // Legs without auditor-roles show 0 rounds, never error.
    const zeroLegs = section.legs.filter((leg) => leg.runId !== GATE_JUDGE_RUN);
    assert.ok(zeroLegs.length > 0, "sibling legs must remain on the board");
    for (const leg of zeroLegs) {
      assert.equal(leg.roundCount, 0, `${leg.runId} must report 0 rounds`);
      assert.deepEqual(leg.rounds, []);
    }

    assert.deepEqual(section.byOfficer, [
      {
        officer: "notary",
        rounds: 7,
        bounceCount: 5,
        passCount: 2,
        bounceRate: 5 / 7,
        meanOfficerWallMs: 40_000,
      },
    ]);
  });
});

test("analyst gate-cycles via runAnalyst: current English faces + rejected/no-result terminals", async () => {
  await withTempHome(async (home) => {
    // Current direct-summons accepted officer round first.
    await writeCurrentNameSingleRound(judgeAuditorDir(home));
    const current = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    const currentLeg = gateSection(current.page).legs.find((leg) => leg.runId === GATE_JUDGE_RUN);
    assert.ok(currentLeg);
        assert.deepEqual(currentLeg.rounds, [
      {
        roundIndex: 1,
        officer: "inspector",
        status: "bounce",
        officerWallMs: 10_000,
        findingsCount: 2,
        origin: { kind: "direct" },
      },
    ]);


    // Rejected/no-result historical terminals do not form rounds.
    await rm(judgeAuditorDir(home), { recursive: true, force: true });
    await writeRejectedTerminalFixture(judgeAuditorDir(home));
    const rejected = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    const rejectedLeg = gateSection(rejected.page).legs.find((leg) => leg.runId === GATE_JUDGE_RUN);
    assert.ok(rejectedLeg);
    // Rejected dispatch is omitted; orphan accepted same-seat dispatch must not steal the later officer.
    // Accepted dispatch without an accepted officer receipt still forms no round.
    assert.equal(rejectedLeg.roundCount, 2, "rejected dispatch must not swallow a later direct officer round");
    // Orphan accepted same-seat dispatch must not mark the later officer as historical.
    assert.deepEqual(rejectedLeg.rounds, [
      {
        roundIndex: 1,
        officer: "inspector",
        status: "pass",
        officerWallMs: 10_000,
        findingsCount: 0,
        origin: { kind: "historical_dispatch" },
      },
      {
        roundIndex: 2,
        officer: "inspector",
        status: "bounce",
        officerWallMs: 10_000,
        findingsCount: 1,
        origin: { kind: "direct" },
      },
    ]);

    assert.deepEqual(gateSection(rejected.page).byOfficer, [
      {
        officer: "inspector",
        rounds: 2,
        bounceCount: 1,
        passCount: 1,
        bounceRate: 0.5,
        meanOfficerWallMs: 10_000,
      },
    ]);
  });
});

test("analyst gate-cycles via runAnalyst: accepted-then-rejected same volume keeps accepted", async () => {
  await withTempHome(async (home) => {
    const auditorDir = judgeAuditorDir(home);
    await mkdir(auditorDir, { recursive: true });
    // One nested volume: earlier accepted officer receipt, later rejected retry.
    // extractLastGateToolCall must prefer the accepted call — not let rejected overwrite.
    const startedAt = iso(1_000);
    const endedAt = iso(11_000);
    const rows = [
      {
        type: "session",
        version: 3,
        id: "off-acc-then-rej",
        timestamp: startedAt,
        cwd: "/tmp/gate-tool-session",
      },
      {
        type: "message",
        id: "off-acc-then-rej-call-ok",
        parentId: null,
        timestamp: startedAt,
        message: {
          role: "assistant",
          timestamp: startedAt,
          content: [
            {
              type: "toolCall",
              id: "call_off-acc-ok",
              name: "ak_inspector_output",
              arguments: { status: "pass", findings: ["kept"] },
            },
          ],
        },
      },
      {
        type: "message",
        id: "off-acc-then-rej-tail-ok",
        parentId: "off-acc-then-rej-call-ok",
        timestamp: startedAt,
        message: {
          role: "toolResult",
          toolCallId: "call_off-acc-ok",
          toolName: "ak_inspector_output",
          timestamp: startedAt,
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        type: "message",
        id: "off-acc-then-rej-call-rej",
        parentId: null,
        timestamp: endedAt,
        message: {
          role: "assistant",
          timestamp: endedAt,
          content: [
            {
              type: "toolCall",
              id: "call_off-acc-rej",
              name: "ak_inspector_output",
              arguments: { status: "bounce", findings: ["noise"] },
            },
          ],
        },
      },
      {
        type: "message",
        id: "off-acc-then-rej-tail-rej",
        parentId: "off-acc-then-rej-call-rej",
        timestamp: endedAt,
        message: {
          role: "toolResult",
          toolCallId: "call_off-acc-rej",
          toolName: "ak_inspector_output",
          timestamp: endedAt,
          isError: true,
          content: [{ type: "text", text: "rejected" }],
        },
      },
    ];
    await writeFile(
      join(auditorDir, "o01_inspector_accepted_then_rejected.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    const leg = gateSection(result.page).legs.find((row) => row.runId === GATE_JUDGE_RUN);
    assert.ok(leg, "accepted-then-rejected volume must remain a readable gate leg");
    assert.equal(leg.roundCount, 1);
    assert.deepEqual(leg.rounds, [
      {
        roundIndex: 1,
        officer: "inspector",
        status: "pass",
        officerWallMs: 10_000,
        findingsCount: 1,
        origin: { kind: "direct" },
      },
    ]);
  });
});

test("analyst gate-cycles via runAnalyst: continuous volume multi-binding keeps per-summons wall", async () => {
  await withTempHome(async (home) => {
    const auditorDir = judgeAuditorDir(home);
    await mkdir(auditorDir, { recursive: true });
    // One continuous ticket-seat volume: summons A (1s wall) then B (2s wall).
    // Whole-volume span would report ~62s for both (judge r1 probe); interval read must not.
    const partA = gateToolSessionJsonl({
      id: "summons-a",
      startedAt: "2026-09-03T00:00:00.000Z",
      endedAt: "2026-09-03T00:00:01.000Z",
      toolName: "ak_inspector_output",
      args: { status: "bounce", findings: ["a-only"] },
      attemptEntryId: "attempt-a",
    });
    const partB = gateToolSessionJsonl({
      id: "summons-b",
      startedAt: "2026-09-03T00:01:00.000Z",
      endedAt: "2026-09-03T00:01:02.000Z",
      toolName: "ak_inspector_output",
      args: { status: "pass", findings: [] },
      attemptEntryId: "attempt-b",
      includeHeader: false,
    });
    await writeFile(
      join(auditorDir, "continuous-inspector.jsonl"),
      `${partA}${partB}`,
      "utf8",
    );

    const result = await runAnalyst(
      {
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      },
      { home },
    );
    const leg = gateSection(result.page).legs.find((row) => row.runId === GATE_JUDGE_RUN);
    assert.ok(leg, "continuous multi-binding volume must remain readable");
    assert.equal(leg.roundCount, 2);
    assert.deepEqual(
      leg.rounds.map((round) => ({
        status: round.status,
        officerWallMs: round.officerWallMs,
        findingsCount: round.findingsCount,
      })),
      [
        { status: "bounce", officerWallMs: 1_000, findingsCount: 1 },
        { status: "pass", officerWallMs: 2_000, findingsCount: 0 },
      ],
    );
  });
});

test("analyst via runAnalyst: shared ticket-seat main volume keeps per-run frame span after continuations", async () => {
  await withTempHome(async (home) => {
    // #636 D: two inspector runs share one main sessionFile under the real
    // ticket-seat nest (git projectRoot + admitted ticket). Whole-volume read
    // would give both the cumulative wall; binding intervals must keep each
    // run stable across later appends and later-run damage. Fake dirs without
    // admitted-request bypass nest discovery and cannot prove the seam.
    const projectRoot = packageRoot;
    const book = resolveBookKeyFromGit(projectRoot);
    const ticketNumber = 636;
    const runA = "019ff636-0001-7000-8000-0000000000a1";
    const runB = "019ff636-0002-7000-8000-0000000000b2";
    const bookRuns = join(home, ".ak-roles", "books", book, "runs");
    const sharedDir = ticketSeatMemorySessionDirectory({
      ticketNumber,
      seat: "inspector",
      cwd: projectRoot,
      home,
    });
    const sharedSession = join(sharedDir, "session.jsonl");
    await mkdir(sharedDir, { recursive: true });

    const binding = (runId: string, id: string, at: string) =>
      JSON.stringify({
        type: "custom",
        customType: TICKET_SEAT_RUN_BINDING_ENTRY_TYPE,
        id,
        parentId: null,
        timestamp: at,
        data: { version: 1, runId },
      });
    // Non-zero tool span so B2 retains the tool action (zero-width clips drop).
    const activity = (
      id: string,
      startedAt: string,
      endedAt: string,
      model: string,
      toolId: string,
    ) =>
      [
        JSON.stringify({
          type: "message",
          id: `${id}-asst`,
          parentId: null,
          timestamp: startedAt,
          message: {
            role: "assistant",
            model,
            timestamp: startedAt,
            content: [{ type: "toolCall", id: toolId, name: "read", arguments: {} }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: `${id}-res`,
          parentId: `${id}-asst`,
          timestamp: endedAt,
          message: {
            role: "toolResult",
            toolCallId: toolId,
            toolName: "read",
            timestamp: endedAt,
            isError: false,
            content: [{ type: "text", text: "ok" }],
          },
        }),
      ].join("\n");

    // Run A: 1s wall (00:00 → 00:01). Run B: 2s wall (01:00 → 01:02).
    // Cumulative whole-volume wall would be ~62s for both.
    await writeFile(
      sharedSession,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "shared-inspector",
          timestamp: "2026-09-03T00:00:00.000Z",
          cwd: projectRoot,
        }),
        binding(runA, "bind-a", "2026-09-03T00:00:00.000Z"),
        activity("a", "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:01.000Z", "model-a", "call_a"),
        binding(runB, "bind-b", "2026-09-03T00:01:00.000Z"),
        activity("b", "2026-09-03T00:01:00.000Z", "2026-09-03T00:01:02.000Z", "model-b", "call_b"),
      ].join("\n") + "\n",
      "utf8",
    );

    async function seedRun(runId: string, role: string): Promise<void> {
      const runDir = join(bookRuns, `${runId}@${role}`);
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      await mkdir(join(runDir, "session"), { recursive: true });
      await writeFile(
        join(runDir, "invocation.json"),
        `${JSON.stringify({
          role,
          runId,
          bookKey: book,
          projectRoot,
          ticketNumber,
          sessionDirectory: sharedDir,
          sessionFile: sharedSession,
        }, null, 2)}\n`,
        "utf8",
      );
      // Real ticket-key discovery requires admitted-request{ticketNumber,projectRoot}.
      await writeFile(
        join(runDir, "admitted-request.json"),
        `${JSON.stringify({
          role,
          runId,
          ticketNumber,
          projectRoot,
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(runDir, "artifacts", "report.json"),
        `${JSON.stringify({
          role,
          runId,
          outcome: { kind: "accepted", role, status: "completed", decisiveFacts: {} },
        }, null, 2)}\n`,
        "utf8",
      );
    }

    await seedRun(runA, "inspector");
    await seedRun(runB, "inspector");

    function issueSurfaces(page: AnalystIssueMetricsPage): {
      wall: AnalystLegWallClockSection;
      b2: AnalystB2FrameBucketsActionsSection;
    } {
      const bag = page as AnalystIssueMetricsPage & {
        readonly legWallClock?: AnalystLegWallClockSection;
        readonly b2FrameBucketsActions?: AnalystB2FrameBucketsActionsSection;
      };
      assert.ok(bag.legWallClock, "leg wall-clock section must be present");
      assert.ok(bag.b2FrameBucketsActions, "B2 section must be present");
      return { wall: bag.legWallClock, b2: bag.b2FrameBucketsActions };
    }

    function assertRunFacts(
      page: AnalystIssueMetricsPage,
      label: string,
    ): void {
      const { wall, b2 } = issueSurfaces(page);
      const wallA = wall.ranking.find((row) => row.runId === runA);
      const wallB = wall.ranking.find((row) => row.runId === runB);
      assert.ok(wallA, `${label}: run A must remain readable with binding interval`);
      assert.ok(wallB, `${label}: run B must remain readable with binding interval`);
      assert.equal(wallA.wallMs, 1_000, `${label}: run A owns only its 1s interval`);
      assert.equal(wallB.wallMs, 2_000, `${label}: run B owns only its 2s interval`);
      assert.equal(
        page.unreadable.some((row) => row.runId === runA || row.runId === runB),
        false,
        `${label}: closed A/B intervals must not be unreadable`,
      );
      const b2A = b2.runs.find((row) => row.runId === runA);
      const b2B = b2.runs.find((row) => row.runId === runB);
      assert.ok(b2A, `${label}: run A B2 metrics retained`);
      assert.ok(b2B, `${label}: run B B2 metrics retained`);
      assert.equal(b2A.wallMs, 1_000, `${label}: run A B2 wall`);
      assert.equal(b2B.wallMs, 2_000, `${label}: run B B2 wall`);
      const toolA = b2A.actions.find(
        (action) => action.kind === "tool" && action.toolCallId === "call_a",
      );
      const toolB = b2B.actions.find(
        (action) => action.kind === "tool" && action.toolCallId === "call_b",
      );
      assert.ok(toolA && toolA.kind === "tool", `${label}: run A tool interval retained`);
      assert.ok(toolB && toolB.kind === "tool", `${label}: run B tool interval retained`);
      assert.equal(toolA.toolName, "read");
      assert.equal(toolB.toolName, "read");
    }

    const first = await runAnalyst(
      { mode: "issue", projectRoot },
      { home },
    );
    assertRunFacts(first.page, "initial");

    // Two later continuations append onto the shared volume — prior run facts must not move.
    await appendFile(
      sharedSession,
      [
        binding("019ff636-0003-7000-8000-0000000000c3", "bind-c", "2026-09-03T00:02:00.000Z"),
        activity("c", "2026-09-03T00:02:00.000Z", "2026-09-03T00:02:05.000Z", "model-c", "call_c"),
        binding("019ff636-0004-7000-8000-0000000000d4", "bind-d", "2026-09-03T00:03:00.000Z"),
        activity("d", "2026-09-03T00:03:00.000Z", "2026-09-03T00:03:09.000Z", "model-d", "call_d"),
      ].join("\n") + "\n",
      "utf8",
    );

    const second = await runAnalyst(
      { mode: "issue", projectRoot },
      { home },
    );
    assertRunFacts(second.page, "after continuations");

    // Later-run damage on the shared volume must not erase closed A/B intervals.
    await appendFile(sharedSession, "{broken\n", "utf8");

    const third = await runAnalyst(
      { mode: "issue", projectRoot },
      { home },
    );
    assertRunFacts(third.page, "after later-run damage");

    // Typed model face: closed intervals keep their session models after damage.
    const models = await runAnalyst(
      { mode: "model-groups", projectRoots: [projectRoot] },
      { home },
    );
    const groupKeys = new Set(models.page.groups.map((group) => group.rawGroupKey));
    assert.equal(groupKeys.has("model-a"), true, "run A model retained after later-run damage");
    assert.equal(groupKeys.has("model-b"), true, "run B model retained after later-run damage");
    assert.equal(
      models.page.unreadable.some((row) => row.runId === runA || row.runId === runB),
      false,
      "model-groups must not list closed A/B as unreadable after later-run damage",
    );
  });
});

test("analyst gate-cycles via runAnalyst: rejected volume missing timestamps is omitted", async () => {
  await withTempHome(async (home) => {
    const auditorDir = judgeAuditorDir(home);
    await mkdir(auditorDir, { recursive: true });
    // Rejected gate call with no usable session timestamps — must omit, not throw
    // (requireAcceptedGateSpan runs only after accepted is established).
    const rows = [
      {
        type: "session",
        version: 3,
        id: "off-rej-no-span",
        cwd: "/tmp/gate-tool-session",
      },
      {
        type: "message",
        id: "off-rej-no-span-call",
        parentId: null,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_off-rej-no-span",
              name: "ak_inspector_output",
              arguments: { status: "bounce", findings: ["x"] },
            },
          ],
        },
      },
      {
        type: "message",
        id: "off-rej-no-span-tail",
        parentId: "off-rej-no-span-call",
        message: {
          role: "toolResult",
          toolCallId: "call_off-rej-no-span",
          toolName: "ak_inspector_output",
          isError: true,
          content: [{ type: "text", text: "rejected" }],
        },
      },
    ];
    await writeFile(
      join(auditorDir, "o01_inspector_rejected_no_span.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    assert.equal(
      result.page.unreadable.some((row) => row.runId === GATE_JUDGE_RUN),
      false,
      "rejected volume missing timestamps must not mark the leg unreadable",
    );
    const leg = gateSection(result.page).legs.find((row) => row.runId === GATE_JUDGE_RUN);
    assert.ok(leg, "rejected no-span volume must leave a readable zero-round leg");
    assert.equal(leg.roundCount, 0);
    assert.deepEqual(leg.rounds, []);
  });
});

async function assertAuditorRolesUnreadable(
  reasonPattern: RegExp,
  label: string,
  home: string,
): Promise<void> {
  const result = await runAnalyst({
    mode: "issue",
    projectRoot: ISSUE_PROJECT_ROOT,
  }, { home });
  const entry = result.page.unreadable.find((row) => row.runId === GATE_JUDGE_RUN);
  assert.ok(entry, `${label}: judge leg must be page-local unreadable`);
  assert.deepEqual(entry.missingSources, ["auditor-roles"]);
  assert.match(entry.reason, reasonPattern);
  assert.equal(
    gateSection(result.page).legs.some((leg) => leg.runId === GATE_JUDGE_RUN),
    false,
    `${label}: must not wash into a readable gateCycles leg`,
  );
}

test("analyst gate-cycles via runAnalyst: accepted non-dispatch Gatekeeper status is loud unreadable", async () => {
  await withTempHome(async (home) => {
    const auditorDir = judgeAuditorDir(home);
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "d01_gatekeeper_non_dispatch.jsonl"),
      gateToolSessionJsonl({
        id: "disp-bad",
        startedAt: iso(0),
        endedAt: iso(1_000),
        toolName: "ak_gatekeeper_output",
        args: { status: "incomplete", reason: "abolished status" },
      }),
      "utf8",
    );

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });

    assert.ok(
      result.page.unreadable.some((row) => row.runId === GATE_JUDGE_RUN),
      "accepted non-dispatch Gatekeeper status must mark the leg unreadable",
    );
  });
});

test("analyst gate-cycles via runAnalyst: damaged auditor volume → unreadable leg", async () => {
  await withTempHome(async (home) => {
    const auditorDir = judgeAuditorDir(home);
    await mkdir(auditorDir, { recursive: true });
    // Completed-by-terminator malformed line — canonical reader must not under-count.
    await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
    await assertAuditorRolesUnreadable(/malformed JSONL record/, "malformed JSONL", home);

    // Plain file at auditor-roles path is damaged topology (ENOTDIR), not lawful zero.
    await rm(auditorDir, { recursive: true, force: true });
    await writeFile(auditorDir, "not-a-directory\n", "utf8");
    await assertAuditorRolesUnreadable(/ENOTDIR/, "ENOTDIR topology", home);

    // Accepted gate receipt with inverted span must not silently omit the volume.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "o01_inspector_inverted_span.jsonl"),
      gateToolSessionJsonl({
        id: "off-inverted",
        startedAt: iso(20_000),
        endedAt: iso(10_000),
        toolName: "ak_inspector_output",
        args: { status: "pass", findings: [] },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/unusable timestamp span/, "inverted span", home);

    // Accepted gate receipt with blank status — shape refusal wash is forbidden.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "o01_inspector_blank_status.jsonl"),
      gateToolSessionJsonl({
        id: "off-blank-status",
        startedAt: iso(0),
        endedAt: iso(10_000),
        toolName: "ak_inspector_output",
        args: { status: "   ", findings: [] },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/missing usable status/, "blank status", home);

    // Accepted dispatch with unknown officer arg.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "d01_gatekeeper_unknown_officer.jsonl"),
      gateToolSessionJsonl({
        id: "disp-unknown-officer",
        startedAt: iso(0),
        endedAt: iso(1_000),
        toolName: "ak_gatekeeper_output",
        args: { status: "dispatch", officer: "magistracy" },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/missing or unknown officer/, "unknown officer", home);

    // Lawful province non-dispatch release (pass) must be readable — zero rounds,
    // never unreadable (#597). Unknown non-contract statuses stay loud above.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "d01_gatekeeper_province_pass.jsonl"),
      gateToolSessionJsonl({
        id: "disp-province-pass",
        startedAt: iso(0),
        endedAt: iso(1_000),
        toolName: "ak_gatekeeper_output",
        args: { status: "pass", reason: "no officer needed" },
      }),
      "utf8",
    );
    const provincePass = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    assert.equal(
      provincePass.page.unreadable.some((row) => row.runId === GATE_JUDGE_RUN),
      false,
      "lawful province pass must not mark the leg unreadable",
    );
    const provincePassLeg = gateSection(provincePass.page).legs.find(
      (leg) => leg.runId === GATE_JUDGE_RUN,
    );
    assert.ok(provincePassLeg, "lawful province pass leg must remain readable");
    assert.equal(provincePassLeg.roundCount, 0);
    assert.deepEqual(provincePassLeg.rounds, []);
  });
});

test("analyst gate-cycles via runAnalyst cohort: merges byOfficer from ensured pages", async () => {
  await withTempHome(async (home) => {
    await writeSevenRoundHistoricalFixture(judgeAuditorDir(home));

    // Issue mode materializes page + library index row (cohort join key).
    const issue = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
      issueNumber: 446,
    }, { home });
    assert.equal(issue.page.issueNumber, 446);
    const bookKey = issue.page.bookKey;
    assert.equal(typeof bookKey, "string");
    assert.ok(bookKey.length > 0);

    const result = await runAnalyst({
      mode: "cohort",
      groups: [
        {
          groupLabel: "with-gates",
          issues: [{ bookKey, issueNumber: 446 }],
        },
        {
          groupLabel: "vacant",
          issues: [
            {
              bookKey: `root:${physicalPathIdentity("/analyst-fixture/cohort-gate-absent")}`,
              issueNumber: 999,
            },
          ],
        },
      ],
    }, { home });

    assert.equal(result.mode, "cohort");
    const withGates = result.groups[0]!;
    const vacant = result.groups[1]!;

    assert.equal(withGates.groupLabel, "with-gates");
    assert.equal(withGates.issues[0]?.status, "present");
    // External cohort result must project gate-cycle fold (not only hidden page section).
    assert.deepEqual(withGates.gateCyclesByOfficer, [
      {
        officer: "notary",
        rounds: 7,
        bounceCount: 5,
        passCount: 2,
        bounceRate: { status: "present", value: 5 / 7 },
        meanOfficerWallMs: { status: "present", value: 40_000 },
      },
    ]);

    assert.equal(vacant.groupLabel, "vacant");
    assert.equal(vacant.issues[0]?.status, "absent");
    assert.deepEqual(vacant.gateCyclesByOfficer, []);
  });
});
