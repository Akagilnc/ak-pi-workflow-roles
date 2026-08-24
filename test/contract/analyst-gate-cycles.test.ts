/**
 * #446 analyst gate-cycle metric family.
 *
 * Seams:
 * - readAnalystGateCyclesFromAuditorRoles (sole nested-volume reader)
 * - runAnalyst issue page → gateCycles section (A2 family composition)
 * - runAnalyst cohort → gateCyclesByOfficer fold from ensured pages
 * - damaged nested JSONL → loud reader failure / page-local unreadable
 *
 * Oracles are hand values from fixture volumes (typed status / span / findings
 * length only) — never findings prose.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { readAnalystGateCyclesFromAuditorRoles } from "../../src/analyst-gate-cycles-read.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import { LedgerSessionJsonlError } from "../../src/ledger-session-read.ts";
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
}): string {
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
  // Keep a trailing timestamp row at endedAt so span ends there even if call
  // timestamp equals endedAt (extract uses first/last row timestamps).
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
      isError: false,
      content: [{ type: "text", text: "ok" }],
    },
  };
  // Ensure startedAt is first row timestamp:
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

test("gate-cycle reader: missing auditor-roles directory → empty rounds", async () => {
  const missing = join(tmpdir(), "analyst-gate-missing-", `${Date.now()}`);
  const rounds = await readAnalystGateCyclesFromAuditorRoles(missing);
  assert.deepEqual(rounds, []);
});

test("gate-cycle reader: 7 historical menxia/fubaolang pairs + soul-audit noise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analyst-gate-seven-"));
  try {
    await writeSevenRoundHistoricalFixture(dir);
    const rounds = await readAnalystGateCyclesFromAuditorRoles(dir);
    assert.equal(rounds.length, 7);
    assert.deepEqual(
      rounds.map((r) => ({
        roundIndex: r.roundIndex,
        officer: r.officer,
        status: r.status,
        officerWallMs: r.officerWallMs,
        findingsCount: r.findingsCount,
      })),
      EXPECTED_SEVEN_ROUNDS,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gate-cycle reader: current gatekeeper/inspector English face", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analyst-gate-cur-"));
  try {
    await writeCurrentNameSingleRound(dir);
    const rounds = await readAnalystGateCyclesFromAuditorRoles(dir);
    assert.equal(rounds.length, 1);
    assert.deepEqual(rounds[0], {
      roundIndex: 1,
      officer: "inspector",
      status: "bounce",
      officerWallMs: 10_000,
      officerStartedAt: iso(1_000),
      officerEndedAt: iso(11_000),
      findingsCount: 2,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analyst gate-cycles via runAnalyst: 7-round leg + zero-round siblings", async () => {
  await withTempHome(async (home) => {
    const auditorDir = join(
      home,
      ".ak-roles",
      "books",
      BOOK,
      "runs",
      GATE_JUDGE_DIR,
      "session",
      "auditor-roles",
    );
    await writeSevenRoundHistoricalFixture(auditorDir);

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    });
    const section = gateSection(result.page);
    assert.equal(section.kind, "analyst-gate-cycles");

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

test("gate-cycle reader: completed malformed nested JSONL fails loudly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analyst-gate-bad-"));
  try {
    await writeFile(join(dir, "bad.jsonl"), "{bad}\n", "utf8");
    await assert.rejects(
      () => readAnalystGateCyclesFromAuditorRoles(dir),
      (error: unknown) => {
        assert.ok(error instanceof LedgerSessionJsonlError);
        assert.match(error.message, /malformed JSONL record/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analyst gate-cycles via runAnalyst: damaged auditor volume → unreadable leg", async () => {
  await withTempHome(async (home) => {
    const auditorDir = join(
      home,
      ".ak-roles",
      "books",
      BOOK,
      "runs",
      GATE_JUDGE_DIR,
      "session",
      "auditor-roles",
    );
    await mkdir(auditorDir, { recursive: true });
    // Completed-by-terminator malformed line — canonical reader must not under-count.
    await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    });

    const damaged = result.page.unreadable.find((entry) => entry.runId === GATE_JUDGE_RUN);
    assert.ok(damaged, "judge leg with damaged auditor-roles must be page-local unreadable");
    assert.deepEqual(damaged.missingSources, ["auditor-roles"]);
    assert.match(damaged.reason, /malformed JSONL record/);

    // Must not appear as a zero-round readable leg (wash → under-count).
    const section = gateSection(result.page);
    assert.equal(
      section.legs.some((leg) => leg.runId === GATE_JUDGE_RUN),
      false,
      "damaged gate leg must not contribute readable gateCycles rows",
    );
  });
});

test("analyst gate-cycles via runAnalyst cohort: merges byOfficer from ensured pages", async () => {
  await withTempHome(async (home) => {
    const auditorDir = join(
      home,
      ".ak-roles",
      "books",
      BOOK,
      "runs",
      GATE_JUDGE_DIR,
      "session",
      "auditor-roles",
    );
    await writeSevenRoundHistoricalFixture(auditorDir);

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
