/**
 * #446 analyst gate-cycle metric family — real-entry tracers only.
 *
 * Seams proved here:
 * - runAnalyst issue page → gateCycles (historical + current officer faces,
 *   zero-round siblings, rejected/missing terminal receipt, damaged JSONL)
 * - runAnalyst cohort → gateCyclesByOfficer fold from ensured pages
 *
 * Oracles are hand values from fixture volumes (typed status / span / findings
 * length only) — never findings prose. No permanent internal-reader parallel.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import type { AnalystGateCyclesSection } from "../../src/analyst-metric-families/gate-cycles.ts";
import type { AnalystIssueMetricsPage } from "../../src/analyst-page.ts";

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
  { roundIndex: 1, officer: "notary" as const, status: "bounce", officerWallMs: 10_000, findingsCount: 3 },
  { roundIndex: 2, officer: "notary" as const, status: "bounce", officerWallMs: 20_000, findingsCount: 1 },
  { roundIndex: 3, officer: "notary" as const, status: "bounce", officerWallMs: 30_000, findingsCount: 1 },
  { roundIndex: 4, officer: "notary" as const, status: "bounce", officerWallMs: 40_000, findingsCount: 1 },
  { roundIndex: 5, officer: "notary" as const, status: "pass", officerWallMs: 50_000, findingsCount: 0 },
  { roundIndex: 6, officer: "notary" as const, status: "bounce", officerWallMs: 60_000, findingsCount: 1 },
  { roundIndex: 7, officer: "notary" as const, status: "pass", officerWallMs: 70_000, findingsCount: 0 },
];

function iso(msFromBase: number): string {
  // Base 2026-08-24T04:00:00.000Z
  return new Date(Date.parse("2026-08-24T04:00:00.000Z") + msFromBase).toISOString();
}

function sessionLines(input: {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Default accepted receipt. `true` = rejected; `omit` = no toolResult row. */
  readonly receipt?: "accepted" | "rejected" | "omit";
}): string {
  const receipt = input.receipt ?? "accepted";
  const header = {
    type: "session",
    version: 3,
    id: input.id,
    timestamp: input.startedAt,
    cwd: ISSUE_PROJECT_ROOT,
  };
  const call = {
    type: "message",
    id: `${input.id}-call`,
    parentId: null,
    timestamp: input.endedAt,
    message: {
      role: "assistant",
      timestamp: input.endedAt,
      content: [
        {
          type: "toolCall",
          id: `call_${input.id}`,
          name: input.toolName,
          arguments: input.args,
        },
      ],
    },
  };
  if (receipt === "omit") {
    // Tail keeps span endedAt without a toolResult — unpaired call is not a receipt.
    const tail = {
      type: "message",
      id: `${input.id}-tail`,
      parentId: `${input.id}-call`,
      timestamp: input.endedAt,
      message: {
        role: "user",
        timestamp: input.endedAt,
        content: [{ type: "text", text: "no-result" }],
      },
    };
    return [header, call, tail].map((row) => JSON.stringify(row)).join("\n") + "\n";
  }
  const tail = {
    type: "message",
    id: `${input.id}-tail`,
    parentId: `${input.id}-call`,
    timestamp: input.endedAt,
    message: {
      role: "toolResult",
      toolCallId: `call_${input.id}`,
      toolName: input.toolName,
      timestamp: input.endedAt,
      isError: receipt === "rejected",
      content: [{ type: "text", text: receipt === "rejected" ? "rejected" : "ok" }],
    },
  };
  return [header, call, tail].map((row) => JSON.stringify(row)).join("\n") + "\n";
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
      sessionLines({
        id: `disp-${index + 1}`,
        startedAt: iso(round.dStart),
        endedAt: iso(round.dEnd),
        toolName: "ak_menxia_output",
        args: { status: "dispatch", officer: "fubaolang" },
      }),
      "utf8",
    );
    fileSeq += 1;
    await writeFile(
      join(auditorDir, `o${String(fileSeq).padStart(2, "0")}_fubaolang.jsonl`),
      sessionLines({
        id: `off-${index + 1}`,
        startedAt: iso(round.oStart),
        endedAt: iso(round.oEnd),
        toolName: "ak_fubaolang_output",
        args: { status: round.status, findings: round.findings },
      }),
      "utf8",
    );
    if (index === 4) {
      // Insert soul-audit volume after pass r5
      fileSeq += 1;
      await writeFile(
        join(auditorDir, `s${String(fileSeq).padStart(2, "0")}_soul.jsonl`),
        sessionLines({
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
    join(auditorDir, "d01_gatekeeper.jsonl"),
    sessionLines({
      id: "disp-cur",
      startedAt: iso(0),
      endedAt: iso(1_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o02_inspector.jsonl"),
    sessionLines({
      id: "off-cur",
      startedAt: iso(1_000),
      endedAt: iso(11_000),
      toolName: "ak_inspector_output",
      args: { status: "bounce", findings: ["x", "y"] },
    }),
    "utf8",
  );
}

/** One lawful accepted round + rejected / no-result terminals that must not pair. */
async function writeRejectedTerminalFixture(auditorDir: string): Promise<void> {
  await mkdir(auditorDir, { recursive: true });
  // Lawful round 1 (current English faces)
  await writeFile(
    join(auditorDir, "d01_gatekeeper.jsonl"),
    sessionLines({
      id: "disp-ok",
      startedAt: iso(0),
      endedAt: iso(1_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o02_inspector.jsonl"),
    sessionLines({
      id: "off-ok",
      startedAt: iso(1_000),
      endedAt: iso(11_000),
      toolName: "ak_inspector_output",
      args: { status: "pass", findings: [] },
    }),
    "utf8",
  );
  // Rejected dispatch — must not open a round even with a later officer
  await writeFile(
    join(auditorDir, "d03_gatekeeper_rejected.jsonl"),
    sessionLines({
      id: "disp-rej",
      startedAt: iso(20_000),
      endedAt: iso(21_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
      receipt: "rejected",
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o04_inspector_after_rej.jsonl"),
    sessionLines({
      id: "off-after-rej",
      startedAt: iso(21_000),
      endedAt: iso(31_000),
      toolName: "ak_inspector_output",
      args: { status: "bounce", findings: ["z"] },
    }),
    "utf8",
  );
  // Accepted dispatch + officer toolCall with no toolResult — unpaired, not a round
  await writeFile(
    join(auditorDir, "d05_gatekeeper_orphan.jsonl"),
    sessionLines({
      id: "disp-orphan",
      startedAt: iso(40_000),
      endedAt: iso(41_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "notary" },
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o06_notary_no_result.jsonl"),
    sessionLines({
      id: "off-no-result",
      startedAt: iso(41_000),
      endedAt: iso(51_000),
      toolName: "ak_notary_output",
      args: { status: "pass", findings: [] },
      receipt: "omit",
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
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
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
    });
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
    // Current-name single accepted round first.
    await writeCurrentNameSingleRound(judgeAuditorDir(home));
    const current = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    });
    const currentLeg = gateSection(current.page).legs.find((leg) => leg.runId === GATE_JUDGE_RUN);
    assert.ok(currentLeg);
    assert.deepEqual(currentLeg.rounds, [
      {
        roundIndex: 1,
        officer: "inspector",
        status: "bounce",
        officerWallMs: 10_000,
        findingsCount: 2,
      },
    ]);

    // Overlay rejected/no-result terminals: only the one accepted pair remains.
    await rm(judgeAuditorDir(home), { recursive: true, force: true });
    await writeRejectedTerminalFixture(judgeAuditorDir(home));
    const rejected = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    });
    const rejectedLeg = gateSection(rejected.page).legs.find((leg) => leg.runId === GATE_JUDGE_RUN);
    assert.ok(rejectedLeg);
    assert.equal(rejectedLeg.roundCount, 1, "rejected/no-result terminals must not form rounds");
    assert.deepEqual(rejectedLeg.rounds, [
      {
        roundIndex: 1,
        officer: "inspector",
        status: "pass",
        officerWallMs: 10_000,
        findingsCount: 0,
      },
    ]);
    assert.deepEqual(gateSection(rejected.page).byOfficer, [
      {
        officer: "inspector",
        rounds: 1,
        bounceCount: 0,
        passCount: 1,
        bounceRate: 0,
        meanOfficerWallMs: 10_000,
      },
    ]);
  });
});

async function assertAuditorRolesUnreadable(
  reasonPattern: RegExp,
  label: string,
): Promise<void> {
  const result = await runAnalyst({
    mode: "issue",
    projectRoot: ISSUE_PROJECT_ROOT,
  });
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

/**
 * #458: lawful Gatekeeper typed incomplete is a recognizable terminal — omit from
 * pairing, never wash the parent leg unreadable. A later successful pair still
 * counts; officer-layer typed incomplete keeps pairing (status retained on the round).
 */
async function writeLawfulIncompleteThenSuccessFixture(auditorDir: string): Promise<void> {
  await mkdir(auditorDir, { recursive: true });
  // Older lawful Gatekeeper incomplete — must not poison the leg.
  await writeFile(
    join(auditorDir, "d01_gatekeeper_incomplete.jsonl"),
    sessionLines({
      id: "disp-incomplete",
      startedAt: iso(0),
      endedAt: iso(1_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "incomplete", reason: "subject not ready" },
    }),
    "utf8",
  );
  // Subsequent lawful inspector bounce pair → round 1.
  await writeFile(
    join(auditorDir, "d02_gatekeeper.jsonl"),
    sessionLines({
      id: "disp-ok",
      startedAt: iso(10_000),
      endedAt: iso(11_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "inspector" },
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o03_inspector.jsonl"),
    sessionLines({
      id: "off-bounce",
      startedAt: iso(11_000),
      endedAt: iso(21_000),
      toolName: "ak_inspector_output",
      args: { status: "bounce", findings: ["x"] },
    }),
    "utf8",
  );
  // Officer-layer typed incomplete still pairs (distinct from Gatekeeper incomplete).
  await writeFile(
    join(auditorDir, "d04_gatekeeper.jsonl"),
    sessionLines({
      id: "disp-off-incomplete",
      startedAt: iso(30_000),
      endedAt: iso(31_000),
      toolName: "ak_gatekeeper_output",
      args: { status: "dispatch", officer: "notary" },
    }),
    "utf8",
  );
  await writeFile(
    join(auditorDir, "o05_notary_incomplete.jsonl"),
    sessionLines({
      id: "off-incomplete",
      startedAt: iso(31_000),
      endedAt: iso(41_000),
      toolName: "ak_notary_output",
      args: { status: "incomplete", reason: "evidence gap", findings: [] },
    }),
    "utf8",
  );
}

test("analyst gate-cycles via runAnalyst: lawful Gatekeeper incomplete omits round; later pair readable", async () => {
  await withTempHome(async (home) => {
    await writeLawfulIncompleteThenSuccessFixture(judgeAuditorDir(home));

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    });
    const section = gateSection(result.page);

    assert.equal(
      result.page.unreadable.some((row) => row.runId === GATE_JUDGE_RUN),
      false,
      "lawful Gatekeeper incomplete must not mark the leg unreadable",
    );

    const gateLeg = section.legs.find((leg) => leg.runId === GATE_JUDGE_RUN);
    assert.ok(gateLeg, "leg with lawful incomplete + later pairs must stay readable");
    assert.equal(gateLeg.roundCount, 2, "only paired rounds count; Gatekeeper incomplete forms none");
    assert.deepEqual(gateLeg.rounds, [
      {
        roundIndex: 1,
        officer: "inspector",
        status: "bounce",
        officerWallMs: 10_000,
        findingsCount: 1,
      },
      {
        roundIndex: 2,
        officer: "notary",
        status: "incomplete",
        officerWallMs: 10_000,
        findingsCount: 0,
      },
    ]);
  });
});

test("analyst gate-cycles via runAnalyst: damaged auditor volume → unreadable leg", async () => {
  await withTempHome(async (home) => {
    const auditorDir = judgeAuditorDir(home);
    await mkdir(auditorDir, { recursive: true });
    // Completed-by-terminator malformed line — canonical reader must not under-count.
    await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
    await assertAuditorRolesUnreadable(/malformed JSONL record/, "malformed JSONL");

    // Plain file at auditor-roles path is damaged topology (ENOTDIR), not lawful zero.
    await rm(auditorDir, { recursive: true, force: true });
    await writeFile(auditorDir, "not-a-directory\n", "utf8");
    await assertAuditorRolesUnreadable(/ENOTDIR/, "ENOTDIR topology");

    // Accepted gate receipt with inverted span must not silently omit the volume.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "o01_inspector_inverted_span.jsonl"),
      sessionLines({
        id: "off-inverted",
        startedAt: iso(20_000),
        endedAt: iso(10_000),
        toolName: "ak_inspector_output",
        args: { status: "pass", findings: [] },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/unusable timestamp span/, "inverted span");

    // Accepted gate receipt with blank status — shape refusal wash is forbidden.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "o01_inspector_blank_status.jsonl"),
      sessionLines({
        id: "off-blank-status",
        startedAt: iso(0),
        endedAt: iso(10_000),
        toolName: "ak_inspector_output",
        args: { status: "   ", findings: [] },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/missing usable status/, "blank status");

    // Accepted dispatch with unknown officer arg.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "d01_gatekeeper_unknown_officer.jsonl"),
      sessionLines({
        id: "disp-unknown-officer",
        startedAt: iso(0),
        endedAt: iso(1_000),
        toolName: "ak_gatekeeper_output",
        args: { status: "dispatch", officer: "magistracy" },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/missing or unknown officer/, "unknown officer");

    // Accepted dispatch tool whose status is not the dispatch terminal.
    await rm(auditorDir, { recursive: true, force: true });
    await mkdir(auditorDir, { recursive: true });
    await writeFile(
      join(auditorDir, "d01_gatekeeper_non_dispatch_status.jsonl"),
      sessionLines({
        id: "disp-non-dispatch",
        startedAt: iso(0),
        endedAt: iso(1_000),
        toolName: "ak_gatekeeper_output",
        args: { status: "pass", officer: "inspector" },
      }),
      "utf8",
    );
    await assertAuditorRolesUnreadable(/non-dispatch status/, "non-dispatch status");
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
    });
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
    });

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
