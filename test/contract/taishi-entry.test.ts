/**
 * #324 taishi-A1 — sole entry seam tracer.
 * Fixture ledger (2 readable legs + 1 damaged session run + 1 other-issue run)
 * → issue-mode typed page with hand-computed legs/unreadable equality,
 * business-repo porcelain unchanged, atomic page replace idempotent.
 * Variants: null terminal artifact → unreadable; taishi symlink into consumer → refuse.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ActivationLedgerError,
  physicalPathIdentity,
} from "../../src/activation-ledger-topology.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import { medianNumber } from "../../src/taishi-median.ts";
import {
  loadTaishiIssueMetricFamilies,
  TAISHI_ISSUE_METRIC_FAMILIES,
  TAISHI_ISSUE_METRIC_FAMILIES_DIR,
} from "../../src/taishi-metric-families.ts";
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

const ISSUE_PROJECT_ROOT = "/taishi-fixture/issue-demo";
const BOOK = "fixture-book";
const LEG_A1_RUN = "019ff000-0001-7000-8000-0000000000a1";
const LEG_A1_DIR = `${LEG_A1_RUN}@coder`;

/** Hand-computed from fixture (scope = ISSUE_PROJECT_ROOT). */
const EXPECTED_LEGS = [
  {
    runId: LEG_A1_RUN,
    book: BOOK,
    role: "coder",
  },
  {
    runId: "019ff000-0002-7000-8000-0000000000b2",
    book: BOOK,
    role: "judge",
  },
] as const;

const EXPECTED_UNREADABLE = [
  {
    runId: "019ff000-0003-7000-8000-0000000000c3",
    book: BOOK,
    missingSources: ["session-timeline"] as const,
  },
] as const;

/**
 * A2 seam-probe hand values from fixture sessions (readable legs only).
 * Raw frame span / tool intervals / terminal face only — no derived metrics.
 */
const EXPECTED_A2_SEAM_PROBE = {
  kind: "taishi-a2-seam-probe",
  runs: [
    {
      runId: LEG_A1_RUN,
      book: BOOK,
      role: "coder",
      frameSpan: {
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T00:01:00.000Z",
      },
      toolIntervals: [
        {
          toolCallId: "call_bash_a",
          toolName: "bash",
          startedAt: "2026-08-01T00:00:10.000Z",
          endedAt: "2026-08-01T00:00:40.000Z",
        },
        {
          toolCallId: "call_out_a",
          toolName: "ak_coder_output",
          startedAt: "2026-08-01T00:00:55.000Z",
          endedAt: "2026-08-01T00:01:00.000Z",
        },
      ],
      terminal: { status: "present", file: "report.json", role: "coder" },
    },
    {
      runId: "019ff000-0002-7000-8000-0000000000b2",
      book: BOOK,
      role: "judge",
      frameSpan: {
        startedAt: "2026-08-01T00:01:00.000Z",
        endedAt: "2026-08-01T00:01:08.000Z",
      },
      toolIntervals: [
        {
          toolCallId: "call_judge_b",
          toolName: "ak_judge_output",
          startedAt: "2026-08-01T00:01:05.000Z",
          endedAt: "2026-08-01T00:01:08.000Z",
        },
      ],
      terminal: { status: "present", file: "report.json", role: "judge" },
    },
  ],
} as const;

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string, porcelainBefore: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-business-"));
  try {
    execFileSync("git", ["init"], { cwd: businessRepo });
    await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: businessRepo },
    );
    const porcelainBefore = gitPorcelain(businessRepo);
    assert.equal(porcelainBefore, "", "business repo starts clean");
    const result = await fn(businessRepo, porcelainBefore);
    assert.equal(gitPorcelain(businessRepo), porcelainBefore, "business repo zero write");
    return result;
  } finally {
    await rm(businessRepo, { recursive: true, force: true });
  }
}

/**
 * Fixture injection stays below the production contract: hermetic process HOME
 * (os.homedir) — never a production invocation `home` field (ADR 0048).
 */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "taishi-home-"));
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

test("taishi issue-mode entry: fixture legs+unreadable hand-equal, porcelain frozen, page replace idempotent", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_PROJECT_ROOT);

      // Pre-seed a stale page at the canonical path — replace must be atomic/idempotent.
      await mkdir(join(ledgerHome, "taishi", "issues"), { recursive: true });
      await writeFile(
        pagePath,
        `${JSON.stringify({
          kind: "taishi-issue-metrics",
          mode: "issue",
          projectRoot: ISSUE_PROJECT_ROOT,
          legs: [],
          unreadable: [],
          unreadableCount: 0,
          stale: true,
        }, null, 2)}\n`,
        "utf8",
      );

      const first = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });

      assert.equal(first.mode, "issue");
      assert.equal(first.pagePath, pagePath);
      assert.equal(first.page.kind, "taishi-issue-metrics");
      assert.equal(first.page.mode, "issue");
      assert.equal(first.page.projectRoot, physicalPathIdentity(ISSUE_PROJECT_ROOT));
      assert.equal(
        "version" in (first.page as unknown as Record<string, unknown>),
        false,
        "page admits no readerless version field",
      );

      // Hand-computed leg list (other-issue run excluded; damaged excluded from legs).
      assert.deepEqual(first.page.legs, [...EXPECTED_LEGS]);

      // A2: example family consumes typed per-run facts (span/tools/terminal) only.
      assert.deepEqual(first.page.a2SeamProbe, EXPECTED_A2_SEAM_PROBE);
      // 零新指标: no per-run derived duration or aggregate median on the page.
      const probe = first.page.a2SeamProbe!;
      assert.equal(
        "frameSpanMedianMs" in (probe as unknown as Record<string, unknown>),
        false,
      );
      for (const run of probe.runs) {
        assert.equal(
          "frameSpanMs" in (run as unknown as Record<string, unknown>),
          false,
        );
      }

      // Damaged run: loud unreadable exclusion + single count; duration not on page.
      assert.equal(first.page.unreadableCount, 1);
      assert.equal(first.page.unreadable.length, 1);
      const damaged = first.page.unreadable[0]!;
      assert.equal(damaged.runId, EXPECTED_UNREADABLE[0]!.runId);
      assert.equal(damaged.book, EXPECTED_UNREADABLE[0]!.book);
      assert.deepEqual(damaged.missingSources, [...EXPECTED_UNREADABLE[0]!.missingSources]);
      assert.match(damaged.reason, /malformed JSONL record/i);
      // No wall-clock / duration field admitted for unreadable runs on A1 page.
      assert.equal(
        "wallMs" in damaged || "durationMs" in damaged || "elapsedMs" in damaged,
        false,
      );

      const onDisk = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.deepEqual(onDisk, first.page);
      assert.equal("stale" in (onDisk as unknown as Record<string, unknown>), false);
      assert.equal("version" in (onDisk as unknown as Record<string, unknown>), false);

      // Atomic replace idempotent: second run yields equivalent page bytes/content.
      const firstBytes = await readFile(pagePath, "utf8");
      const second = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });
      assert.deepEqual(second.page, first.page);
      assert.equal(await readFile(pagePath, "utf8"), firstBytes);
      const onDiskAgain = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.deepEqual(onDiskAgain, first.page);
    });
  });
});

test("taishi issue-mode entry: null terminal artifact is terminal-artifact unreadable and excluded from legs", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const reportPath = join(
        home,
        ".ak-roles",
        "books",
        BOOK,
        "runs",
        LEG_A1_DIR,
        "artifacts",
        "report.json",
      );
      await writeFile(reportPath, "null\n", "utf8");

      const result = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });

      assert.equal(
        result.page.legs.some((leg) => leg.runId === LEG_A1_RUN),
        false,
        "run with null terminal artifact must leave legs",
      );
      const entry = result.page.unreadable.find((u) => u.runId === LEG_A1_RUN);
      assert.ok(entry, "null terminal artifact must produce unreadable entry");
      assert.deepEqual(entry.missingSources, ["terminal-artifact"]);
      assert.match(entry.reason, /null/i);
      // Fixture session-damaged run remains; plus this terminal-artifact failure.
      assert.equal(result.page.unreadableCount, 2);
      assert.equal(result.page.unreadable.length, 2);
      assert.deepEqual(
        result.page.legs.map((leg) => leg.runId),
        ["019ff000-0002-7000-8000-0000000000b2"],
      );
    });
  });
});

test("taishi shared median primitive: even-sample mean of two middles (fixture wall spans)", () => {
  // Fixture readable walls: a1=60000, b2=8000 → (8000+60000)/2 = 34000.
  // Proved on the shared primitive only — not persisted on the issue page.
  assert.equal(medianNumber([60_000, 8_000]), 34_000);
  assert.equal(medianNumber([8_000, 60_000]), 34_000);
  assert.equal(medianNumber([3]), 3);
  assert.equal(medianNumber([1, 2, 3]), 2);
  assert.equal(medianNumber([]), undefined);
});

test("taishi metric-family production discovery: real family files register without shared-list edits", async () => {
  // Registration proof stays on the production path — real family modules under
  // taishi-metric-families/ are discovered by the real loader (no test-only dir hook).
  // Inclusion only: B-wave family files may land alongside the A2 probe without
  // forcing this shared tracer to re-pin the full registry inventory.
  const names = (await readdir(TAISHI_ISSUE_METRIC_FAMILIES_DIR))
    .filter((name) => {
      if (name.endsWith(".d.ts")) return false;
      if (name.includes(".test.")) return false;
      return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
    })
    .sort((a, b) => a.localeCompare(b));
  assert.ok(
    names.includes("a2-seam-probe.ts"),
    "A2 seam-probe family module must remain registered under production discovery",
  );

  const families = await loadTaishiIssueMetricFamilies();
  for (const family of families) {
    assert.equal(typeof family.id, "string");
    assert.ok(family.id.length > 0, "family id must be non-empty");
    assert.equal(typeof family.contribute, "function");
  }
  assert.ok(
    families.some((family) => family.id === "a2-seam-probe"),
    "loaded families must include a2-seam-probe",
  );
  // Production registry is the same discovery product (loaded once at import).
  for (const family of TAISHI_ISSUE_METRIC_FAMILIES) {
    assert.equal(typeof family.id, "string");
    assert.ok(family.id.length > 0, "family id must be non-empty");
    assert.equal(typeof family.contribute, "function");
  }
  assert.ok(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "a2-seam-probe"),
    "production registry must include a2-seam-probe",
  );
});

test("taishi issue-mode entry: taishi path symlink into consumer repo is refused without porcelain change", async () => {
  await withBusinessRepo(async (businessRepo) => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await symlink(businessRepo, join(ledgerHome, "taishi"));

      await assert.rejects(
        () =>
          runTaishi({
            mode: "issue",
            projectRoot: ISSUE_PROJECT_ROOT,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ActivationLedgerError);
          assert.match(error.message, /symbolic link/i);
          return true;
        },
      );

      // No issues page may land in the consumer tree via the symlink.
      const escaped = await readFile(
        join(businessRepo, "issues", `${"x"}.json`),
        "utf8",
      ).then(
        () => true,
        () => false,
      );
      assert.equal(escaped, false);
      // Directory listing of business repo stays commit-only.
      const listing = execFileSync("ls", ["-la"], {
        cwd: businessRepo,
        encoding: "utf8",
      });
      assert.equal(listing.includes("issues"), false);
    });
  });
});
