/**
 * #338 taishi on-demand retrieval — compute-if-missing (owner 2026-08-14).
 *
 * Public surface (reuse #336 PUBLIC_ROLE_ARGV taishi row) exposes three typed
 * reads: issue / cohort / model-groups. Unified semantics: in-scope issue with
 * a page → use it; missing page → sync-await sole compute kernel, write via the
 * existing page entry, then return the full result. No pending/async envelope.
 * Whole-compute failure is typed terminal for this pull (names issue + real cause);
 * never washed to absent. Single-run unreadable/damaged keeps PRD #298 exclusion
 * (page-local), and does not fail the whole retrieval.
 *
 * Fixture runId segment 6xxx (1-5xxx occupied by prior taishi family).
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
import { PUBLIC_ROLE_ARGV, runAkRole } from "../../src/public-cli/cli.ts";
import {
  buildTaishiLibraryIndexPage,
  taishiLibraryIndexPath,
  writeTaishiLibraryIndexPage,
} from "../../src/taishi-index.ts";
import {
  taishiIssuePageKey,
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";
import type { TaishiCohortModeResult } from "../../src/taishi-cohort.ts";
import type { TaishiModelGroupsPage } from "../../src/taishi-model-groups.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

/** #338 exclusive projectRoots (runId 6xxx books). */
const ISSUE_ROOT = "/taishi-fixture/c338-issue-a";
const COHORT_A_ROOT = "/taishi-fixture/c338-cohort-a";
const COHORT_B_ROOT = "/taishi-fixture/c338-cohort-b";
const MODELS_A_ROOT = "/taishi-fixture/c338-models-a";
const MODELS_B_ROOT = "/taishi-fixture/c338-models-b";
/** Healthy root used only for whole-compute write-failure negative (not damage). */
const NEG_ROOT = "/taishi-fixture/c338-neg-broken";

const ISSUE_RUN = "019ff000-6001-7000-8000-0000000006a1";
const COHORT_A_RUN = "019ff000-6002-7000-8000-0000000006b2";
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
 * cohort-a coder 6002 completed wall 30_000
 * cohort-b coder 6003 completed wall 20_000
 * models-a coder 6004 grok-4.5 completed wall 40_000
 * models-b coder 6005 sol-low completed wall 10_000
 * neg healthy coder 6006 completed wall 15_000 (write-failure subject only)
 */
const ISSUE_WALL_MS = 60_000;
const COHORT_A_WALL_MS = 30_000;
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
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-338-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "taishi-338-home-"));
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

/** Snapshot of issue page basenames under taishi/issues/. */
async function listIssuePageNames(ledgerHome: string): Promise<string[]> {
  const dir = join(ledgerHome, "taishi", "issues");
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

function indexRow(projectRoot: string, issueNumber: number) {
  return {
    projectRoot: physicalPathIdentity(projectRoot),
    issueNumber,
    totalElapsedMs: 0,
    changedLines: { status: "absent" as const },
    msPerKLines: { status: "absent" as const },
    lastActivityAt: { status: "absent" as const },
  };
}

test("PUBLIC_ROLE_ARGV still owns the sole taishi parse registration (#336 seam)", () => {
  assert.equal(typeof PUBLIC_ROLE_ARGV.taishi.parse, "function");
});

test("taishi #338 issue compute-if-missing: no page → public CLI computes, writes page, hand oracle", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Guarantee no pre-existing page for this root.
      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_ROOT);
      await rm(pagePath, { force: true });
      const beforePages = await listIssuePageNames(ledgerHome);
      assert.equal(
        beforePages.includes(`${taishiIssuePageKey(ISSUE_ROOT)}.json`),
        false,
        "precondition: issue page absent",
      );

      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["taishi", "--project-root", ISSUE_ROOT],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const body = JSON.parse(stdout.join("")) as {
        mode: string;
        page: TaishiIssueMetricsPage;
        pagePath: string;
      };
      assert.equal(body.mode, "issue");
      assert.equal(body.page.kind, "taishi-issue-metrics");
      assert.equal(body.page.projectRoot, physicalPathIdentity(ISSUE_ROOT));
      assert.equal(body.page.totalElapsedMs, ISSUE_WALL_MS);
      assert.deepEqual(
        body.page.legs.map((leg) => leg.runId),
        [ISSUE_RUN],
      );

      // Page directory reflects the newly written page.
      const afterPages = await listIssuePageNames(ledgerHome);
      assert.equal(
        afterPages.includes(`${taishiIssuePageKey(ISSUE_ROOT)}.json`),
        true,
        "compute-if-missing must write the issue page",
      );
      const disk = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.equal(disk.totalElapsedMs, ISSUE_WALL_MS);
      assert.equal(body.pagePath, pagePath);
    });
  });
});

test("taishi #338 cohort compute-if-missing: uncomputed issues → pages written + hand contrast", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Index supplies issueNumber→projectRoot join; pages intentionally absent.
      await writeTaishiLibraryIndexPage(
        ledgerHome,
        buildTaishiLibraryIndexPage([
          indexRow(COHORT_A_ROOT, COHORT_ISSUE_A),
          indexRow(COHORT_B_ROOT, COHORT_ISSUE_B),
        ]),
      );
      await rm(taishiIssuePagePath(ledgerHome, COHORT_A_ROOT), { force: true });
      await rm(taishiIssuePagePath(ledgerHome, COHORT_B_ROOT), { force: true });
      const beforePages = await listIssuePageNames(ledgerHome);
      assert.equal(beforePages.includes(`${taishiIssuePageKey(COHORT_A_ROOT)}.json`), false);
      assert.equal(beforePages.includes(`${taishiIssuePageKey(COHORT_B_ROOT)}.json`), false);

      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        [
          "taishi",
          "--cohort",
          "--group-a-label",
          "before",
          "--group-a-issues",
          String(COHORT_ISSUE_A),
          "--group-b-label",
          "after",
          "--group-b-issues",
          String(COHORT_ISSUE_B),
        ],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const body = JSON.parse(stdout.join("")) as TaishiCohortModeResult;
      assert.equal(body.mode, "cohort");
      const before = body.groups[0]!;
      const after = body.groups[1]!;
      assert.equal(before.groupLabel, "before");
      assert.equal(after.groupLabel, "after");
      assert.deepEqual(before.issues, [
        {
          issueNumber: COHORT_ISSUE_A,
          status: "present",
          projectRoot: physicalPathIdentity(COHORT_A_ROOT),
        },
      ]);
      assert.deepEqual(after.issues, [
        {
          issueNumber: COHORT_ISSUE_B,
          status: "present",
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
      assert.equal(afterPages.includes(`${taishiIssuePageKey(COHORT_A_ROOT)}.json`), true);
      assert.equal(afterPages.includes(`${taishiIssuePageKey(COHORT_B_ROOT)}.json`), true);
      const pageA = JSON.parse(
        await readFile(taishiIssuePagePath(ledgerHome, COHORT_A_ROOT), "utf8"),
      ) as TaishiIssueMetricsPage;
      assert.deepEqual(pageA.legs.map((l) => l.runId), [COHORT_A_RUN]);
      assert.equal(pageA.totalElapsedMs, COHORT_A_WALL_MS);
      const pageB = JSON.parse(
        await readFile(taishiIssuePagePath(ledgerHome, COHORT_B_ROOT), "utf8"),
      ) as TaishiIssueMetricsPage;
      assert.deepEqual(pageB.legs.map((l) => l.runId), [COHORT_B_RUN]);
      assert.equal(pageB.totalElapsedMs, COHORT_B_WALL_MS);
    });
  });
});

test("taishi #338 model-groups compute-if-missing: uncomputed roots → pages written + hand groups", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await rm(taishiIssuePagePath(ledgerHome, MODELS_A_ROOT), { force: true });
      await rm(taishiIssuePagePath(ledgerHome, MODELS_B_ROOT), { force: true });
      const beforePages = await listIssuePageNames(ledgerHome);
      assert.equal(beforePages.includes(`${taishiIssuePageKey(MODELS_A_ROOT)}.json`), false);
      assert.equal(beforePages.includes(`${taishiIssuePageKey(MODELS_B_ROOT)}.json`), false);

      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        [
          "taishi",
          "--model-groups",
          "--project-root",
          MODELS_A_ROOT,
          "--project-root",
          MODELS_B_ROOT,
        ],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const body = JSON.parse(stdout.join("")) as {
        mode: string;
        page: TaishiModelGroupsPage;
      };
      assert.equal(body.mode, "model-groups");
      assert.equal(body.page.kind, "taishi-model-groups");
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
      assert.equal(afterPages.includes(`${taishiIssuePageKey(MODELS_A_ROOT)}.json`), true);
      assert.equal(afterPages.includes(`${taishiIssuePageKey(MODELS_B_ROOT)}.json`), true);
      const pageA = JSON.parse(
        await readFile(taishiIssuePagePath(ledgerHome, MODELS_A_ROOT), "utf8"),
      ) as TaishiIssueMetricsPage;
      assert.deepEqual(pageA.legs.map((l) => l.runId), [MODELS_A_RUN]);
      const pageB = JSON.parse(
        await readFile(taishiIssuePagePath(ledgerHome, MODELS_B_ROOT), "utf8"),
      ) as TaishiIssueMetricsPage;
      assert.deepEqual(pageB.legs.map((l) => l.runId), [MODELS_B_RUN]);
    });
  });
});

test("taishi #338 whole-compute failure: write-page blocked → typed terminal issue+cause; no partial cohort", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Join face present; page missing so ensure must compute a *healthy* issue.
      // Whole-volume failure cause = write-page EISDIR (not single-run damage).
      await writeTaishiLibraryIndexPage(
        ledgerHome,
        buildTaishiLibraryIndexPage([
          indexRow(COHORT_A_ROOT, COHORT_ISSUE_A),
          indexRow(NEG_ROOT, NEG_ISSUE),
        ]),
      );
      await rm(taishiIssuePagePath(ledgerHome, COHORT_A_ROOT), { force: true });
      await rm(taishiIssuePagePath(ledgerHome, NEG_ROOT), { force: true });

      // Block the sole write entry: page path is a directory → EISDIR on atomic write.
      const blockedPath = taishiIssuePagePath(ledgerHome, NEG_ROOT);
      await mkdir(blockedPath, { recursive: true });
      await writeFile(join(blockedPath, "trap"), "blocked\n", "utf8");

      const beforeIndex = await readFile(taishiLibraryIndexPath(ledgerHome), "utf8");
      const beforePages = await listIssuePageNames(ledgerHome);

      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        [
          "taishi",
          "--cohort",
          "--group-a-label",
          "left",
          "--group-a-issues",
          // Fail first so no partial sibling compute mutates index before the loud stop.
          `${NEG_ISSUE},${COHORT_ISSUE_A}`,
          "--group-b-label",
          "right",
          "--group-b-issues",
          String(COHORT_ISSUE_A),
        ],
        { packageRoot, home, io },
      );

      // Whole-compute failure terminates this pull — not usage (2), not pending/success.
      assert.equal(result.exitCode, 1);
      // Typed terminal failure object (schema owner fields) — no stderr prose contract.
      const body = JSON.parse(stdout.join("")) as {
        code: string;
        projectRoot: string;
        issueNumber?: number;
        cause: { code?: string; name?: string };
        mode?: string;
      };
      assert.equal(body.code, "taishi-issue-compute-failed");
      assert.equal(body.issueNumber, NEG_ISSUE);
      assert.equal(body.projectRoot, physicalPathIdentity(NEG_ROOT));
      assert.equal(body.cause.code, "EISDIR");
      // Must not wash into cohort/issue success envelope.
      assert.equal(body.mode, undefined);
      assert.equal(stderr.join(""), "");

      // Index unchanged by the failed ensure of NEG; no silent partial cohort page set.
      const afterIndex = await readFile(taishiLibraryIndexPath(ledgerHome), "utf8");
      assert.equal(afterIndex, beforeIndex);

      // Blocked path remains a directory (write never landed a JSON page).
      const st = await stat(blockedPath);
      assert.equal(st.isDirectory(), true);

      // Page names that are real .json files must not include a forged NEG success page.
      const afterPages = await listIssuePageNames(ledgerHome);
      assert.equal(
        afterPages.includes(`${taishiIssuePageKey(NEG_ROOT)}.json`),
        beforePages.includes(`${taishiIssuePageKey(NEG_ROOT)}.json`),
      );
    });
  });
});

test("taishi #338 single-run damage: unreadable exclusion on page; retrieval still succeeds", async () => {
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
      await rm(taishiIssuePagePath(ledgerHome, NEG_ROOT), { force: true });

      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["taishi", "--project-root", NEG_ROOT],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const body = JSON.parse(stdout.join("")) as {
        mode: string;
        page: TaishiIssueMetricsPage;
        pagePath: string;
      };
      assert.equal(body.mode, "issue");
      assert.equal(body.page.kind, "taishi-issue-metrics");
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
      ) as TaishiIssueMetricsPage;
      assert.equal(disk.unreadableCount, 1);
      assert.equal(disk.unreadable[0]!.runId, NEG_RUN);
    });
  });
});
