import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
/**
 * #412 — analyst library-index legacy bookKey + cohort book scope.
 *
 * 401-F1: raw-existing legacy rows (no bookKey) must upsert without crash.
 * 401-F2/owner external contract (bare N = cwd book; book:N cross-book;
 *   wrong book absent) is traced through the public runAkRole entry below —
 *   the single main tracer for that contract; parser edge cases live with
 *   the parser's own test face (analyst-public-cli.test.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import {
  findAnalystLibraryIndexRow,
  upsertAnalystLibraryIndexRows,
  type AnalystLibraryIndexRow,
} from "../../src/analyst-index.ts";
import type { AnalystCohortModeResult } from "../../src/analyst-cohort.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { analystIssuePagePath, type AnalystIssueMetricsPage } from "../../src/analyst-page.ts";

const ABSENT_METRIC = { status: "absent" as const };

function bareLegacyRow(
  projectRoot: string,
  issueNumber: number,
): AnalystLibraryIndexRow {
  // Runtime legacy shape: bookKey field missing entirely.
  return {
    projectRoot: physicalPathIdentity(projectRoot),
    issueNumber,
    totalElapsedMs: 0,
    changedLines: ABSENT_METRIC,
    msPerKLines: ABSENT_METRIC,
    lastActivityAt: ABSENT_METRIC,
  } as unknown as AnalystLibraryIndexRow;
}

function modernRow(
  bookKey: string,
  projectRoot: string,
  issueNumber: number,
): AnalystLibraryIndexRow {
  return {
    bookKey,
    projectRoot: physicalPathIdentity(projectRoot),
    issueNumber,
    totalElapsedMs: 10,
    changedLines: ABSENT_METRIC,
    msPerKLines: ABSENT_METRIC,
    lastActivityAt: ABSENT_METRIC,
  };
}

test("401-F1: raw-existing legacy rows upsert without localeCompare crash", async () => {
  const legacyA = bareLegacyRow("/analyst-fixture/412-legacy-a", 1);
  const modern = modernRow("book-new", "/analyst-fixture/412-modern", 3);

  // Upsert seam: raw legacy existing rows + modern upsert — pre-fix threw
  // TypeError on undefined.localeCompare during the internal sort.
  const merged = upsertAnalystLibraryIndexRows(
    { kind: "analyst-library-index", rows: [legacyA] },
    [modern],
  );
  assert.equal(merged.rows.length, 2);
  // Legacy row healed onto the shared rule's non-Git half: root:<identity>.
  const healedBook = `root:${physicalPathIdentity("/analyst-fixture/412-legacy-a")}`;
  assert.equal(
    findAnalystLibraryIndexRow(merged, 1, healedBook)?.projectRoot,
    physicalPathIdentity("/analyst-fixture/412-legacy-a"),
  );
  assert.ok(findAnalystLibraryIndexRow(merged, 3, "book-new") !== undefined);
});

test("#412 public entry tracer: bare N hits cwd book (legacy row); book:N other book; wrong book absent", async () => {
  await withTempRoot("analyst-412-entry-", async (home) => {
  const repo = await mkdtemp(worktreeTempPrefix("analyst-412-repo-"));
  const previousCwd = process.cwd();
    return withPrimaryAwareCleanup(
      async () => {

    // Real Git repository cwd — book identity comes from the same true source
    // (git common-dir host directory) the issue/sweep path uses.
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    const cwdBook = resolveBookKeyFromGit(repo);
    const ledgerHome = join(home, ".ak-roles");
    const issueNumber = 412;
    const otherBook = "other-book-412";
    // ADR 0048: book keys are directory basenames — commas are legal (#412 T2).
    const commaBook = "other,book-412";
    const repoRoot = physicalPathIdentity(repo);
    const otherRoot = physicalPathIdentity("/analyst-fixture/412-entry-other");
    const commaRoot = physicalPathIdentity("/analyst-fixture/412-entry-comma");

    // Raw legacy index: cwd row carries NO bookKey. Read-boundary heal must map
    // it onto the real Git book so the bare-number public path can hit it —
    // the judge's mechanical counterexample (normalize → root:path ≠ cwdBook).
    await mkdir(join(ledgerHome, "analyst"), { recursive: true });
    await writeFile(
      join(ledgerHome, "analyst", "library-index.json"),
      `${JSON.stringify(
        {
          kind: "analyst-library-index",
          rows: [
            {
              projectRoot: repoRoot,
              issueNumber,
              totalElapsedMs: 0,
              changedLines: ABSENT_METRIC,
              msPerKLines: ABSENT_METRIC,
              lastActivityAt: ABSENT_METRIC,
            },
            modernRow(otherBook, otherRoot, issueNumber),
            modernRow(commaBook, commaRoot, issueNumber),
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Pre-write cached pages so cohort compute-if-missing never spawns a scan.
    await mkdir(join(ledgerHome, "analyst", "issues"), { recursive: true });
    const stubPage = (
      bookKey: string,
      projectRoot: string,
    ): AnalystIssueMetricsPage =>
      ({
        kind: "analyst-issue-metrics",
        mode: "issue",
        bookKey,
        projectRoot,
        issueNumber,
        totalElapsedMs: 0,
        changedLines: ABSENT_METRIC,
        msPerKLines: ABSENT_METRIC,
        lastActivityAt: ABSENT_METRIC,
        legs: [],
        unreadable: [],
        unreadableCount: 0,
        scopeConflicts: [],
      }) as unknown as AnalystIssueMetricsPage;
    for (const [bookKey, projectRoot] of [
      [cwdBook, repoRoot],
      [otherBook, otherRoot],
      [commaBook, commaRoot],
    ] as const) {
      await writeFile(
        analystIssuePagePath(ledgerHome, { bookKey, issueNumber }),
        `${JSON.stringify(stubPage(bookKey, projectRoot), null, 2)}\n`,
        "utf8",
      );
    }

    process.chdir(repo);
    const stdout: string[] = [];
    const result = await runAkRole(
      [
        "analyst",
        "--cohort",
        "--group-a-label",
        "cwd-side",
        "--group-a-issues",
        String(issueNumber),
        "--group-b-label",
        "cross-side",
        "--group-b-issues",
        `${otherBook}:${issueNumber},no-such-book:${issueNumber}`,
      ],
      {
        packageRoot,
        home,
        io: {
          stdout: (text) => stdout.push(text),
          stderr: () => {},
        },
      },
    );

    assert.equal(result.exitCode, 0);
    // External result from stdout only — no internal call-state peeking.
    const payload = JSON.parse(stdout.join("")) as AnalystCohortModeResult;
    // Bare N resolved to the cwd Git book and hit the healed legacy row
    // (present projection carries bookKey — 401-F3 shape).
    assert.deepEqual(payload.groups[0]!.issues, [
      {
        issueNumber,
        status: "present",
        bookKey: cwdBook,
        projectRoot: repoRoot,
      },
    ]);
    // book:N selects the other book; unknown book stays typed absent — no
    // cross-book silent scan picked either present row.
    assert.deepEqual(payload.groups[1]!.issues, [
      {
        issueNumber,
        status: "present",
        bookKey: otherBook,
        projectRoot: otherRoot,
      },
      { issueNumber, status: "absent", bookKey: "no-such-book" },
    ]);

    // Same tracer, second leg (#412 T1 + T2): an all-book:N cohort from a
    // NON-git cwd must not touch cwd Git at all (lazy cwd book resolution —
    // pre-fix eager resolution rejected this pure cross-book query with usage
    // exit 2), and a comma book key round-trips through the sole list
    // parser's escaping (`other\,book-412` → book key `other,book-412`).
    process.chdir(home);
    const stdoutExplicit: string[] = [];
    const resultExplicit = await runAkRole(
      [
        "analyst",
        "--cohort",
        "--group-a-label",
        "explicit-side",
        "--group-a-issues",
        `${otherBook}:${issueNumber},no-such-book:${issueNumber}`,
        "--group-b-label",
        "comma-side",
        "--group-b-issues",
        `other\\,book-412:${issueNumber}`,
      ],
      {
        packageRoot,
        home,
        io: {
          stdout: (text) => stdoutExplicit.push(text),
          stderr: () => {},
        },
      },
    );

    assert.equal(resultExplicit.exitCode, 0);
    const payloadExplicit = JSON.parse(
      stdoutExplicit.join(""),
    ) as AnalystCohortModeResult;
    assert.deepEqual(payloadExplicit.groups[0]!.issues, [
      {
        issueNumber,
        status: "present",
        bookKey: otherBook,
        projectRoot: otherRoot,
      },
      { issueNumber, status: "absent", bookKey: "no-such-book" },
    ]);
    // Escaped comma round-trips to the single comma-bearing book key.
    assert.deepEqual(payloadExplicit.groups[1]!.issues, [
      {
        issueNumber,
        status: "present",
        bookKey: commaBook,
        projectRoot: commaRoot,
      },
    ]);
        },
      async () => { process.chdir(previousCwd); },
      async () => { await rm(repo, { recursive: true, force: true }); }
    );
  });
});
