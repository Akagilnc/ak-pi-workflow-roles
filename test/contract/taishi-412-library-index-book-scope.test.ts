/**
 * #412 — taishi library-index legacy bookKey + cohort book scope.
 *
 * 401-F1: raw-existing legacy rows (no bookKey) must upsert without crash.
 * 401-F2/owner external contract (bare N = cwd book; book:N cross-book;
 *   wrong book absent) is traced through the public runAkRole entry below —
 *   the single main tracer for that contract; parser edge cases live with
 *   the parser's own test face (taishi-public-cli.test.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import {
  findTaishiLibraryIndexRow,
  upsertTaishiLibraryIndexRows,
  type TaishiLibraryIndexRow,
} from "../../src/taishi-index.ts";
import type { TaishiCohortModeResult } from "../../src/taishi-cohort.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { taishiIssuePagePath, type TaishiIssueMetricsPage } from "../../src/taishi-page.ts";

const ABSENT_METRIC = { status: "absent" as const };

function bareLegacyRow(
  projectRoot: string,
  issueNumber: number,
): TaishiLibraryIndexRow {
  // Runtime legacy shape: bookKey field missing entirely.
  return {
    projectRoot: physicalPathIdentity(projectRoot),
    issueNumber,
    totalElapsedMs: 0,
    changedLines: ABSENT_METRIC,
    msPerKLines: ABSENT_METRIC,
    lastActivityAt: ABSENT_METRIC,
  } as unknown as TaishiLibraryIndexRow;
}

function modernRow(
  bookKey: string,
  projectRoot: string,
  issueNumber: number,
): TaishiLibraryIndexRow {
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

test("401-F1: raw-existing legacy rows upsert without localeCompare crash", () => {
  const legacyA = bareLegacyRow("/taishi-fixture/412-legacy-a", 1);
  const modern = modernRow("book-new", "/taishi-fixture/412-modern", 3);

  // Upsert seam: raw legacy existing rows + modern upsert — pre-fix threw
  // TypeError on undefined.localeCompare during the internal sort.
  const merged = upsertTaishiLibraryIndexRows(
    { kind: "taishi-library-index", rows: [legacyA] },
    [modern],
  );
  assert.equal(merged.rows.length, 2);
  // Legacy row healed onto the shared rule's non-Git half: root:<identity>.
  const healedBook = `root:${physicalPathIdentity("/taishi-fixture/412-legacy-a")}`;
  assert.equal(
    findTaishiLibraryIndexRow(merged, 1, healedBook)?.projectRoot,
    physicalPathIdentity("/taishi-fixture/412-legacy-a"),
  );
  assert.ok(findTaishiLibraryIndexRow(merged, 3, "book-new") !== undefined);
});

test("#412 public entry tracer: bare N hits cwd book (legacy row); book:N other book; wrong book absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "taishi-412-entry-"));
  const repo = await mkdtemp(join(tmpdir(), "taishi-412-repo-"));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  try {
    // Real Git repository cwd — book identity comes from the same true source
    // (git common-dir host directory) the issue/sweep path uses.
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    const cwdBook = resolveBookKeyFromGit(repo);
    const ledgerHome = join(home, ".ak-roles");
    const issueNumber = 412;
    const otherBook = "other-book-412";
    const repoRoot = physicalPathIdentity(repo);
    const otherRoot = physicalPathIdentity("/taishi-fixture/412-entry-other");

    // Raw legacy index: cwd row carries NO bookKey. Read-boundary heal must map
    // it onto the real Git book so the bare-number public path can hit it —
    // the judge's mechanical counterexample (normalize → root:path ≠ cwdBook).
    await mkdir(join(ledgerHome, "taishi"), { recursive: true });
    await writeFile(
      join(ledgerHome, "taishi", "library-index.json"),
      `${JSON.stringify(
        {
          kind: "taishi-library-index",
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
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Pre-write cached pages so cohort compute-if-missing never spawns a scan.
    await mkdir(join(ledgerHome, "taishi", "issues"), { recursive: true });
    const stubPage = (
      bookKey: string,
      projectRoot: string,
    ): TaishiIssueMetricsPage =>
      ({
        kind: "taishi-issue-metrics",
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
      }) as unknown as TaishiIssueMetricsPage;
    for (const [bookKey, projectRoot] of [
      [cwdBook, repoRoot],
      [otherBook, otherRoot],
    ] as const) {
      await writeFile(
        taishiIssuePagePath(ledgerHome, { bookKey, issueNumber }),
        `${JSON.stringify(stubPage(bookKey, projectRoot), null, 2)}\n`,
        "utf8",
      );
    }

    process.chdir(repo);
    const stdout: string[] = [];
    const result = await runAkRole(
      [
        "taishi",
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
    const payload = JSON.parse(stdout.join("")) as TaishiCohortModeResult;
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
      { issueNumber, status: "absent" },
    ]);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
