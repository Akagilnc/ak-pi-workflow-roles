/**
 * #326 taishi-B2 — two-bucket full partition + action board tracer.
 *
 * Fixture hand values (PRD five-frame sample + minimal overlap scene) must
 * equal the B2 family section emitted through the sole runTaishi entry.
 * Family registers by drop-in module under taishi-metric-families/ only.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runTaishi } from "../../src/taishi-entry.ts";
import {
  loadTaishiIssueMetricFamilies,
  TAISHI_ISSUE_METRIC_FAMILIES,
  TAISHI_ISSUE_METRIC_FAMILIES_DIR,
} from "../../src/taishi-metric-families.ts";
import type {
  TaishiB2FrameBucketsActionsSection,
  TaishiB2RunMetrics,
} from "../../src/taishi-metric-families/b2-frame-buckets-actions.ts";
import type { TaishiIssueMetricsPage } from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

const ISSUE_PROJECT_ROOT = "/taishi-fixture/issue-demo";
const BOOK = "fixture-book";

/** PRD five-frame sample (existing a1 coder fixture). */
const PRD_RUN = "019ff000-0001-7000-8000-0000000000a1";
/** Minimal overlap scene (e5 coder fixture). */
const OVERLAP_RUN = "019ff000-0005-7000-8000-0000000000e5";

/**
 * PRD 逐帧演算例钉死值（秒→ms）：
 * 工具桶=35s、模型桶=25s、和=60s；
 * 动作降序=[30,15,10,5]s；动作中位数=12.5s；
 * bash 工具名 + 首行摘要 "echo hi"。
 */
const EXPECTED_PRD_RUN: TaishiB2RunMetrics = {
  runId: PRD_RUN,
  book: BOOK,
  role: "coder",
  wallMs: 60_000,
  toolBucketMs: 35_000,
  modelBucketMs: 25_000,
  actionDurationMedianMs: 12_500,
  actions: [
    {
      kind: "tool",
      toolCallId: "call_bash_a",
      toolName: "bash",
      durationMs: 30_000,
      startedAt: "2026-08-01T00:00:10.000Z",
      endedAt: "2026-08-01T00:00:40.000Z",
      commandSummary: "echo hi",
    },
    {
      kind: "model",
      durationMs: 15_000,
      startedAt: "2026-08-01T00:00:40.000Z",
      endedAt: "2026-08-01T00:00:55.000Z",
    },
    {
      kind: "model",
      durationMs: 10_000,
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:10.000Z",
    },
    {
      kind: "tool",
      toolCallId: "call_out_a",
      toolName: "ak_coder_output",
      durationMs: 5_000,
      startedAt: "2026-08-01T00:00:55.000Z",
      endedAt: "2026-08-01T00:01:00.000Z",
    },
  ],
};

/**
 * Overlap hand values (wall 100s):
 *   bash 10→40 (30s) multi-line command; read 25→50 (25s);
 *   tool union 10→50 = 40s (not 30+25); model = 60s;
 *   model maximal continuous: 0→10 (10s), 50→100 (50s) incl. post-last-tool tail;
 *   actions desc [50,30,25,10]; median (25+30)/2 = 27.5s;
 *   bash commandSummary = first line only.
 */
const EXPECTED_OVERLAP_RUN: TaishiB2RunMetrics = {
  runId: OVERLAP_RUN,
  book: BOOK,
  role: "coder",
  wallMs: 100_000,
  toolBucketMs: 40_000,
  modelBucketMs: 60_000,
  actionDurationMedianMs: 27_500,
  actions: [
    {
      kind: "model",
      durationMs: 50_000,
      startedAt: "2026-08-01T00:02:50.000Z",
      endedAt: "2026-08-01T00:03:40.000Z",
    },
    {
      kind: "tool",
      toolCallId: "call_bash_overlap",
      toolName: "bash",
      durationMs: 30_000,
      startedAt: "2026-08-01T00:02:10.000Z",
      endedAt: "2026-08-01T00:02:40.000Z",
      commandSummary: "pnpm test:fast",
    },
    {
      kind: "tool",
      toolCallId: "call_read_overlap",
      toolName: "read",
      durationMs: 25_000,
      startedAt: "2026-08-01T00:02:25.000Z",
      endedAt: "2026-08-01T00:02:50.000Z",
    },
    {
      kind: "model",
      durationMs: 10_000,
      startedAt: "2026-08-01T00:02:00.000Z",
      endedAt: "2026-08-01T00:02:10.000Z",
    },
  ],
};

function b2Section(page: TaishiIssueMetricsPage): TaishiB2FrameBucketsActionsSection {
  const bag = page as TaishiIssueMetricsPage & {
    readonly b2FrameBucketsActions?: TaishiB2FrameBucketsActionsSection;
  };
  assert.ok(
    bag.b2FrameBucketsActions,
    "B2 family must contribute b2FrameBucketsActions via A2 assembly",
  );
  return bag.b2FrameBucketsActions;
}

function assertRunMetrics(actual: TaishiB2RunMetrics, expected: TaishiB2RunMetrics): void {
  assert.equal(actual.runId, expected.runId);
  assert.equal(actual.book, expected.book);
  assert.equal(actual.role, expected.role);
  assert.equal(actual.wallMs, expected.wallMs);
  assert.equal(actual.toolBucketMs, expected.toolBucketMs);
  assert.equal(actual.modelBucketMs, expected.modelBucketMs);
  // 两桶之和恒等腿墙钟
  assert.equal(
    actual.toolBucketMs + actual.modelBucketMs,
    actual.wallMs,
    "tool+model buckets must equal wall clock",
  );
  assert.equal(actual.actionDurationMedianMs, expected.actionDurationMedianMs);
  assert.deepEqual(
    actual.actions.map((action) => action.durationMs),
    expected.actions.map((action) => action.durationMs),
    "action durations must be descending hand values",
  );
  assert.deepEqual(actual.actions, expected.actions);
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "taishi-b2-home-"));
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

test("taishi B2 family module is discovered by production registry without shared-list edits", async () => {
  const names = (await readdir(TAISHI_ISSUE_METRIC_FAMILIES_DIR))
    .filter((name) => {
      if (name.endsWith(".d.ts")) return false;
      if (name.includes(".test.")) return false;
      return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
    })
    .sort((a, b) => a.localeCompare(b));
  assert.ok(
    names.includes("b2-frame-buckets-actions.ts"),
    "B2 family module must register under taishi-metric-families/",
  );

  const families = await loadTaishiIssueMetricFamilies();
  assert.ok(
    families.some((family) => family.id === "b2-frame-buckets-actions"),
    "loaded families must include b2-frame-buckets-actions",
  );
  assert.ok(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "b2-frame-buckets-actions"),
    "production registry must include b2-frame-buckets-actions",
  );
});

test("taishi B2 via runTaishi: PRD five-frame + overlap fixture hand-equal (union/complement/median/bash first line)", async () => {
  await withTempHome(async () => {
    const result = await runTaishi({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    });

    const section = b2Section(result.page);
    assert.equal(section.kind, "taishi-b2-frame-buckets-actions");

    const prd = section.runs.find((run) => run.runId === PRD_RUN);
    assert.ok(prd, "PRD five-frame coder run must appear in B2 section");
    assertRunMetrics(prd, EXPECTED_PRD_RUN);

    const overlap = section.runs.find((run) => run.runId === OVERLAP_RUN);
    assert.ok(overlap, "overlap scene run must appear in B2 section");
    assertRunMetrics(overlap, EXPECTED_OVERLAP_RUN);

    // Overlap negative: individual tool action sum (30+25) must exceed union bucket (40).
    const toolActionSum = overlap.actions
      .filter((action) => action.kind === "tool")
      .reduce((sum, action) => sum + action.durationMs, 0);
    assert.equal(toolActionSum, 55_000);
    assert.equal(overlap.toolBucketMs, 40_000);
    assert.ok(
      toolActionSum > overlap.toolBucketMs,
      "union bucket must not double-count overlapping tool intervals",
    );

    // bash multi-line: first line only (not the whole command body).
    const bash = overlap.actions.find(
      (action) => action.kind === "tool" && action.toolCallId === "call_bash_overlap",
    );
    assert.ok(bash && bash.kind === "tool");
    assert.equal(bash.commandSummary, "pnpm test:fast");
    assert.notEqual(bash.commandSummary, "pnpm test:fast\nnode scripts/extra.js");
  });
});
