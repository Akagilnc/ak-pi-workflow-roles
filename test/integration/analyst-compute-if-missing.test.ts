/**
 * #338 analyst on-demand retrieval — compute-if-missing (owner 2026-08-14).
 *
 * Public surface (reuse #336 PUBLIC_ROLE_ARGV analyst row) exposes issue / cohort
 * reads; model-groups public CLI face disabled (#399) — library kernel retained
 * and still proven here. Unified semantics: in-scope issue with a page → use it;
 * missing page → sync-await sole compute kernel, write via the existing page
 * entry, then return the full result. No pending/async envelope.
 * Whole-compute failure is typed terminal for this pull (names issue + real cause);
 * never washed to absent. Single-run unreadable/damaged keeps PRD #298 exclusion
 * (page-local), and does not fail the whole retrieval.
 *
 * Fixture runId segment 6xxx (1-5xxx occupied by prior analyst family).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  buildAnalystLibraryIndexPage,
  analystLibraryIndexPath,
  writeAnalystLibraryIndexPage,
} from "../../src/analyst-index.ts";
import {
  readOrComputeAnalystIssuePage,
  runAnalyst,
} from "../../src/analyst-entry.ts";
import {
  analystIssuePageKey,
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
} from "../../src/analyst-page.ts";
import type { AnalystCohortModeResult } from "../../src/analyst-cohort.ts";
import type { AnalystModelGroupsPage } from "../../src/analyst-model-groups.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/analyst/home");

/** #338 exclusive projectRoots (runId 6xxx books). */
const ISSUE_ROOT = "/analyst-fixture/c338-issue-a";
const COHORT_A_ROOT = "/analyst-fixture/c338-cohort-a";
/** Same-book sibling root (#412 T4): shares fixture-book-c338-ca with COHORT_A_ROOT. */
const COHORT_A_SIBLING_ROOT = "/analyst-fixture/c338-cohort-a-sibling";
const COHORT_B_ROOT = "/analyst-fixture/c338-cohort-b";
const MODELS_A_ROOT = "/analyst-fixture/c338-models-a";
const MODELS_B_ROOT = "/analyst-fixture/c338-models-b";
/** Healthy root used only for whole-compute write-failure negative (not damage). */
const NEG_ROOT = "/analyst-fixture/c338-neg-broken";

const ISSUE_RUN = "019ff000-6001-7000-8000-0000000006a1";
const COHORT_A_RUN = "019ff000-6002-7000-8000-0000000006b2";
const COHORT_A_SIBLING_RUN = "019ff000-6007-7000-8000-0000000007c4";
const COHORT_B_RUN = "019ff000-6003-7000-8000-0000000006c3";
const MODELS_A_RUN = "019ff000-6004-7000-8000-0000000006d4";
const MODELS_B_RUN = "019ff000-6005-7000-8000-0000000006e5";
const NEG_RUN = "019ff000-6006-7000-8000-0000000006f6";
const NEG_RUN_DIR = `${NEG_RUN}@coder`;

/** 6xxx issue numbers — exclusive from 1-5xxx family. */
const COHORT_ISSUE_A = 6601;
const COHORT_ISSUE_B = 6602;
const NEG_ISSUE = 6699;

/**
 * Hand oracles (ms):
 * issue-a coder 6001 completed wall 60_000
 * cohort-a coder 6002 completed wall 30_000 (typed ticketNumber 6601 — T4
 *   revised #413 r2 U2: the cache-miss recompute filters invocation.ticketNumber)
 * cohort-a coder 6007 completed wall 90_000 (same book, other root —
 *   must never leak into the cohort-a issue page on a cache-miss recompute)
 * cohort-a coder 6004 completed wall 90_000 (same book, SAME root, but a
 *   LEGACY run with no typed ticketNumber — pre-fix root-scan merged it into
 *   the page; post-fix the ticket conjunction excludes it)
 * cohort-b coder 6003 completed wall 20_000 (typed ticketNumber 6602)
 * models-a coder 6004 grok-4.5 completed wall 40_000
 * models-b coder 6005 sol-low completed wall 10_000
 * neg healthy coder 6006 completed wall 15_000 (write-failure subject only)
 */
const ISSUE_WALL_MS = 60_000;
const COHORT_A_WALL_MS = 30_000;
const COHORT_A_SIBLING_WALL_MS = 90_000;
const COHORT_B_WALL_MS = 20_000;
const MODELS_A_WALL_MS = 40_000;
const MODELS_B_WALL_MS = 10_000;

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "analyst-338-business-"));
  try {
    execFileSync("git", ["init"], { cwd: businessRepo });
    await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: businessRepo },
    );
    assert.equal(gitPorcelain(businessRepo), "", "business repo starts clean");
    const result = await fn(businessRepo);
    assert.equal(gitPorcelain(businessRepo), "", "business repo zero write");
    return result;
  } finally {
    await rm(businessRepo, { recursive: true, force: true });
  }
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "analyst-338-home-"));
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

/** Snapshot of issue page basenames under analyst/issues/. */
async function listIssuePageNames(ledgerHome: string): Promise<string[]> {
  const dir = join(ledgerHome, "analyst", "issues");
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(".json")).sort();
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return [];
    }
    throw error;
  }
}

function indexRow(projectRoot: string, issueNumber: number, bookKey?: string) {
  const identity = physicalPathIdentity(projectRoot);
  return {
    bookKey: bookKey ?? `root:${identity}`,
    projectRoot: identity,
    issueNumber,
    totalElapsedMs: 0,
    changedLines: { status: "absent" as const },
    msPerKLines: { status: "absent" as const },
    lastActivityAt: { status: "absent" as const },
  };
}

test("analyst #338 issue compute-if-missing: no page → public CLI computes, writes page, hand oracle", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Guarantee no pre-existing page for this root.
      const pagePath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(ISSUE_ROOT)}`, scopeRootIdentity: ISSUE_ROOT });
      await rm(pagePath, { force: true });
      const beforePages = await listIssuePageNames(ledgerHome);
      assert.equal(
        beforePages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(ISSUE_ROOT)}`, scopeRootIdentity: ISSUE_ROOT })}.json`),
        false,
        "precondition: issue page absent",
      );

      // #399: issue CLI no longer takes --project-root; library path proves compute-if-missing.
      const body = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
      }, { home });
      assert.equal(body.mode, "issue");
      assert.equal(body.page.kind, "analyst-issue-metrics");
      assert.equal(body.page.projectRoot, physicalPathIdentity(ISSUE_ROOT));
      assert.equal(body.page.bookKey, `root:${physicalPathIdentity(ISSUE_ROOT)}`);
      assert.equal(body.page.totalElapsedMs, ISSUE_WALL_MS);
      assert.deepEqual(
        body.page.legs.map((leg) => leg.runId),
        [ISSUE_RUN],
      );

      // Page directory reflects the newly written page.
      const afterPages = await listIssuePageNames(ledgerHome);
      assert.equal(
        afterPages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(ISSUE_ROOT)}`, scopeRootIdentity: ISSUE_ROOT })}.json`),
        true,
        "compute-if-missing must write the issue page",
      );
      const disk = JSON.parse(await readFile(pagePath, "utf8")) as AnalystIssueMetricsPage;
      assert.equal(disk.totalElapsedMs, ISSUE_WALL_MS);
      assert.equal(body.pagePath, pagePath);
    });
  });
});

test("analyst #338 cohort compute-if-missing: uncomputed issues → pages written + hand contrast", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Index supplies issueNumber→projectRoot join; pages intentionally absent.
      // Counterexample shape (#412 T4): the selected row carries a REAL bookKey
      // (fixture-book-c338-ca) whose checkout (/analyst-fixture/...) is gone, and
      // the same book also holds a sibling root's run — a miss recompute must
      // scan this root of this book only, never the whole book.
      await writeAnalystLibraryIndexPage(
        ledgerHome,
        buildAnalystLibraryIndexPage([
          indexRow(COHORT_A_ROOT, COHORT_ISSUE_A, "fixture-book-c338-ca"),
          indexRow(COHORT_B_ROOT, COHORT_ISSUE_B),
        ]),
      );
      await rm(analystIssuePagePath(ledgerHome, { bookKey: "fixture-book-c338-ca", issueNumber: COHORT_ISSUE_A }), { force: true });
      await rm(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(COHORT_B_ROOT)}`, issueNumber: COHORT_ISSUE_B }), { force: true });
      const beforePages = await listIssuePageNames(ledgerHome);
      assert.equal(beforePages.includes(`${analystIssuePageKey({ bookKey: "fixture-book-c338-ca", issueNumber: COHORT_ISSUE_A })}.json`), false);
      assert.equal(beforePages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(COHORT_B_ROOT)}`, issueNumber: COHORT_ISSUE_B })}.json`), false);

      const { io, stdout, stderr } = captureIo();
      // #412: cross-book cohort must pass book:N (bare N = cwd book only).
      // Group A joins by the row's real book key — checkout deleted, sibling
      // root's run lives in the same book.
      const bookB = `root:${physicalPathIdentity(COHORT_B_ROOT)}`;
      const result = await runAkRole(
        [
          "analyst",
          "--cohort",
          "--group-a-label",
          "before",
          "--group-a-issues",
          `fixture-book-c338-ca:${COHORT_ISSUE_A}`,
          "--group-b-label",
          "after",
          "--group-b-issues",
          `${bookB}:${COHORT_ISSUE_B}`,
        ],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const body = JSON.parse(stdout.join("")) as AnalystCohortModeResult;
      assert.equal(body.mode, "cohort");
      const before = body.groups[0]!;
      const after = body.groups[1]!;
      assert.equal(before.groupLabel, "before");
      assert.equal(after.groupLabel, "after");
      assert.deepEqual(before.issues, [
        {
          issueNumber: COHORT_ISSUE_A,
          status: "present",
          bookKey: "fixture-book-c338-ca",
          projectRoot: physicalPathIdentity(COHORT_A_ROOT),
        },
      ]);
      assert.deepEqual(after.issues, [
        {
          issueNumber: COHORT_ISSUE_B,
          status: "present",
          bookKey: `root:${physicalPathIdentity(COHORT_B_ROOT)}`,
          projectRoot: physicalPathIdentity(COHORT_B_ROOT),
        },
      ]);

      // Hand oracle: each group one completed coder leg → firstPass=1 success=1
      // median wall = that leg's wall; rework=0.
      const beforeCoder = before.byRole.find((r) => r.role === "coder");
      const afterCoder = after.byRole.find((r) => r.role === "coder");
      assert.ok(beforeCoder);
      assert.ok(afterCoder);
      assert.deepEqual(beforeCoder.convergenceRounds, [1]);
      assert.deepEqual(beforeCoder.convergenceRoundsMedian, {
        status: "present",
        value: 1,
      });
      assert.deepEqual(beforeCoder.firstPassRate, { status: "present", value: 1 });
      assert.deepEqual(beforeCoder.successRate, { status: "present", value: 1 });
      assert.deepEqual(before.medianWallMs, {
        status: "present",
        value: COHORT_A_WALL_MS,
      });
      assert.deepEqual(before.reworkRatio, { status: "present", value: 0 });

      assert.deepEqual(afterCoder.convergenceRounds, [1]);
      assert.deepEqual(after.medianWallMs, {
        status: "present",
        value: COHORT_B_WALL_MS,
      });
      assert.deepEqual(after.reworkRatio, { status: "present", value: 0 });

      // Both missing pages materialized via sole compute kernel + existing writer.
      const afterPages = await listIssuePageNames(ledgerHome);
      assert.equal(afterPages.includes(`${analystIssuePageKey({ bookKey: "fixture-book-c338-ca", issueNumber: COHORT_ISSUE_A })}.json`), true);
      assert.equal(afterPages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(COHORT_B_ROOT)}`, issueNumber: COHORT_ISSUE_B })}.json`), true);
      const pageA = JSON.parse(
        await readFile(analystIssuePagePath(ledgerHome, { bookKey: "fixture-book-c338-ca", issueNumber: COHORT_ISSUE_A }), "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.deepEqual(pageA.legs.map((l) => l.runId), [COHORT_A_RUN]);
      assert.equal(pageA.totalElapsedMs, COHORT_A_WALL_MS);
      // The same-book sibling root's run stays out — scope widening would
      // inflate the page to [COHORT_A_RUN, COHORT_A_SIBLING_RUN] and
      // COHORT_A_WALL_MS + COHORT_A_SIBLING_WALL_MS.
      // The same-root LEGACY run (6004, no typed ticket) stays out too —
      // #413 r2 U2: ticket conjunction excludes ticketless runs from the
      // cache-miss recompute; only the path filter would wrongly admit it.
      assert.equal(pageA.projectRoot, physicalPathIdentity(COHORT_A_ROOT));
      const pageB = JSON.parse(
        await readFile(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(COHORT_B_ROOT)}`, issueNumber: COHORT_ISSUE_B }), "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.deepEqual(pageB.legs.map((l) => l.runId), [COHORT_B_RUN]);
      assert.equal(pageB.totalElapsedMs, COHORT_B_WALL_MS);
    });
  });
});

test("analyst #338 model-groups library compute-if-missing: uncomputed roots → pages written + hand groups", async () => {
  // #399: public --model-groups/--project-root deleted; library kernel retained.
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await rm(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(MODELS_A_ROOT)}`, scopeRootIdentity: MODELS_A_ROOT }), { force: true });
      await rm(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(MODELS_B_ROOT)}`, scopeRootIdentity: MODELS_B_ROOT }), { force: true });
      const beforePages = await listIssuePageNames(ledgerHome);
      assert.equal(beforePages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(MODELS_A_ROOT)}`, scopeRootIdentity: MODELS_A_ROOT })}.json`), false);
      assert.equal(beforePages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(MODELS_B_ROOT)}`, scopeRootIdentity: MODELS_B_ROOT })}.json`), false);

      const body = await runAnalyst({
        mode: "model-groups",
        projectRoots: [MODELS_A_ROOT, MODELS_B_ROOT],
      }, { home });

      assert.equal(body.mode, "model-groups");
      assert.equal(body.page.kind, "analyst-model-groups");
      assert.equal(body.page.legCount, 2);

      const grok = body.page.groups.find((g) => g.rawGroupKey === "grok-4.5");
      const sol = body.page.groups.find((g) => g.rawGroupKey === "sol-low");
      assert.ok(grok, "grok-4.5 group present");
      assert.ok(sol, "sol-low group present");
      assert.equal(grok.legCount, 1);
      assert.equal(grok.acceptedCount, 1);
      assert.equal(grok.acceptanceRate, 1);
      assert.equal(grok.successCount, 1);
      assert.equal(grok.successRate, 1);
      assert.equal(grok.wallClockMedianMs, MODELS_A_WALL_MS);
      assert.equal(sol.legCount, 1);
      assert.equal(sol.successCount, 1);
      assert.equal(sol.wallClockMedianMs, MODELS_B_WALL_MS);

      const afterPages = await listIssuePageNames(ledgerHome);
      assert.equal(afterPages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(MODELS_A_ROOT)}`, scopeRootIdentity: MODELS_A_ROOT })}.json`), true);
      assert.equal(afterPages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(MODELS_B_ROOT)}`, scopeRootIdentity: MODELS_B_ROOT })}.json`), true);
      const pageA = JSON.parse(
        await readFile(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(MODELS_A_ROOT)}`, scopeRootIdentity: MODELS_A_ROOT }), "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.deepEqual(pageA.legs.map((l) => l.runId), [MODELS_A_RUN]);
      const pageB = JSON.parse(
        await readFile(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(MODELS_B_ROOT)}`, scopeRootIdentity: MODELS_B_ROOT }), "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.deepEqual(pageB.legs.map((l) => l.runId), [MODELS_B_RUN]);
    });
  });
});

test("analyst #338 whole-compute failure: write-page blocked → typed terminal issue+cause; no partial cohort", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Join face present; page missing so ensure must compute a *healthy* issue.
      // Whole-volume failure cause = write-page EISDIR (not single-run damage).
      await writeAnalystLibraryIndexPage(
        ledgerHome,
        buildAnalystLibraryIndexPage([
          indexRow(COHORT_A_ROOT, COHORT_ISSUE_A),
          indexRow(NEG_ROOT, NEG_ISSUE),
        ]),
      );
      await rm(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(COHORT_A_ROOT)}`, issueNumber: COHORT_ISSUE_A }), { force: true });
      await rm(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(NEG_ROOT)}`, issueNumber: NEG_ISSUE }), { force: true });

      // Block the sole write entry: page path is a directory → EISDIR on atomic write.
      // Cohort ensure addresses pages by book + issueNumber (not path-narrow root alone).
      const blockedPath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(NEG_ROOT)}`, issueNumber: NEG_ISSUE });
      await mkdir(blockedPath, { recursive: true });
      await writeFile(join(blockedPath, "trap"), "blocked\n", "utf8");

      const beforeIndex = await readFile(analystLibraryIndexPath(ledgerHome), "utf8");
      const beforePages = await listIssuePageNames(ledgerHome);

      const { io, stdout, stderr } = captureIo();
      const bookNeg = `root:${physicalPathIdentity(NEG_ROOT)}`;
      const bookA = `root:${physicalPathIdentity(COHORT_A_ROOT)}`;
      const result = await runAkRole(
        [
          "analyst",
          "--cohort",
          "--group-a-label",
          "left",
          "--group-a-issues",
          // Fail first so no partial sibling compute mutates index before the loud stop.
          // #412: book:N required when index rows are not the cwd book.
          `${bookNeg}:${NEG_ISSUE},${bookA}:${COHORT_ISSUE_A}`,
          "--group-b-label",
          "right",
          "--group-b-issues",
          `${bookA}:${COHORT_ISSUE_A}`,
        ],
        { packageRoot, home, io },
      );

      // Whole-compute failure terminates this pull — not usage (2), not pending/success.
      assert.equal(result.exitCode, 1);
      // ControlledFailure typed fields (details + identity.code), not parallel schema.
      const body = JSON.parse(stdout.join("")) as {
        cause: string;
        identity?: { code?: string | number; name?: string };
        details?: { code?: string; projectRoot?: string; issueNumber?: number };
        mode?: string;
      };
      assert.equal(body.cause, "output");
      assert.equal(body.details?.code, "analyst-issue-compute-failed");
      assert.equal(body.details?.issueNumber, NEG_ISSUE);
      assert.equal(body.details?.projectRoot, physicalPathIdentity(NEG_ROOT));
      assert.equal(body.identity?.code, "EISDIR");
      assert.equal(body.identity?.name, undefined);
      assert.equal(body.mode, undefined);

      // Index unchanged by the failed ensure of NEG; no silent partial cohort page set.
      const afterIndex = await readFile(analystLibraryIndexPath(ledgerHome), "utf8");
      assert.equal(afterIndex, beforeIndex);

      // Blocked path remains a directory (write never landed a JSON page).
      const st = await stat(blockedPath);
      assert.equal(st.isDirectory(), true);

      // Page names that are real .json files must not include a forged NEG success page.
      const afterPages = await listIssuePageNames(ledgerHome);
      assert.equal(
        afterPages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(NEG_ROOT)}`, scopeRootIdentity: NEG_ROOT })}.json`),
        beforePages.includes(`${analystIssuePageKey({ bookKey: `root:${physicalPathIdentity(NEG_ROOT)}`, scopeRootIdentity: NEG_ROOT })}.json`),
      );
    });
  });
});

test("analyst #338 single-run damage: unreadable exclusion on page; retrieval still succeeds", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Corrupt only the NEG run session after fixture copy — PRD #298 unreadable path.
      // This must NOT become a whole-compute / whole-pull failure under #338 retrieval.
      const sessionPath = join(
        ledgerHome,
        "books",
        "fixture-book-c338-neg",
        "runs",
        NEG_RUN_DIR,
        "session",
        "session.jsonl",
      );
      await writeFile(sessionPath, "THIS IS NOT VALID SESSION JSONL {{{\n", "utf8");
      await rm(analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(NEG_ROOT)}`, scopeRootIdentity: NEG_ROOT }), { force: true });

      const body = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot: NEG_ROOT,
      }, { home });
      assert.equal(body.mode, "issue");
      assert.equal(body.page.kind, "analyst-issue-metrics");
      assert.equal(body.page.projectRoot, physicalPathIdentity(NEG_ROOT));
      // Damaged run excluded from legs; counted as unreadable (page-local).
      assert.deepEqual(body.page.legs, []);
      assert.equal(body.page.totalElapsedMs, 0);
      assert.equal(body.page.unreadableCount, 1);
      assert.equal(body.page.unreadable.length, 1);
      const damaged = body.page.unreadable[0]!;
      assert.equal(damaged.runId, NEG_RUN);
      assert.equal(damaged.book, "fixture-book-c338-neg");
      assert.match(damaged.reason, /malformed JSONL record/i);
      // No wall/duration admitted on unreadable entries.
      assert.equal(
        "wallMs" in damaged || "durationMs" in damaged || "elapsedMs" in damaged,
        false,
      );

      // Page still landed via sole writer — retrieval completed with full typed page.
      const disk = JSON.parse(
        await readFile(body.pagePath, "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.equal(disk.unreadableCount, 1);
      assert.equal(disk.unreadable[0]!.runId, NEG_RUN);
    });
  });
});

test("analyst #338 cached page must match requested ticket scope or recompute", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      // Root-only compute leaves a page without issueNumber binding.
      const rootOnly = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
      }, { home });
      assert.equal(rootOnly.page.issueNumber, undefined);

      const ticket = 6611;
      const scoped = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
        ticketNumber: ticket,
        issueNumber: ticket,
      }, { home });
      assert.equal(scoped.page.issueNumber, ticket);
      const disk = JSON.parse(
        await readFile(scoped.pagePath, "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.equal(disk.issueNumber, ticket);

      // Same ticket scope may reuse the bound page.
      const again = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
        ticketNumber: ticket,
        issueNumber: ticket,
      }, { home });
      assert.equal(again.page.issueNumber, ticket);
      assert.deepEqual(again.page, disk);

      // Different ticket on the same root path must recompute, not accept the cache.
      const other = 6612;
      const switched = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
        ticketNumber: other,
        issueNumber: other,
      }, { home });
      assert.equal(switched.page.issueNumber, other);
    });
  });
});

test("analyst #338 unscoped read must not reuse a ticket-scoped cached page", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ticket = 6613;
      const scoped = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
        ticketNumber: ticket,
        issueNumber: ticket,
      }, { home });
      assert.equal(scoped.page.issueNumber, ticket);
      const scopedDisk = JSON.parse(
        await readFile(scoped.pagePath, "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.equal(scopedDisk.issueNumber, ticket);

      // projectRoot-only pull must recompute via the sole kernel — a narrower
      // ticket page must not stand in for the full root metrics page.
      const unscoped = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot: ISSUE_ROOT,
      }, { home });
      assert.equal(unscoped.page.issueNumber, undefined);
      assert.notDeepEqual(unscoped.page, scopedDisk);

      const disk = JSON.parse(
        await readFile(unscoped.pagePath, "utf8"),
      ) as AnalystIssueMetricsPage;
      assert.equal(disk.issueNumber, undefined);
    });
  });
});
