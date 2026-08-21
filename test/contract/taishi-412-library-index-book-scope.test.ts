/**
 * #412 — taishi library-index legacy bookKey + cohort book scope.
 *
 * 401-F1: legacy rows without bookKey must not crash sort/upsert (localeCompare).
 * 401-F3: present cohort projection always carries bookKey after normalize.
 * 401-F2/owner: bare issueNumber joins cwd book only; book:N for cross-book;
 *   dual-book same issueNumber never silently picks the other book.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import {
  buildTaishiLibraryIndexPage,
  findTaishiLibraryIndexRow,
  normalizeTaishiLibraryIndexRow,
  readTaishiLibraryIndexPage,
  upsertTaishiLibraryIndexRows,
  writeTaishiLibraryIndexPage,
  type TaishiLibraryIndexRow,
} from "../../src/taishi-index.ts";
import { runTaishiCohortMode, type TaishiCohortModeResult } from "../../src/taishi-cohort.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  parseTaishiArgv,
  parseTaishiCohortIssueToken,
} from "../../src/public-cli/invocation.ts";
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

test("401-F1: legacy rows without bookKey sort/upsert without localeCompare crash", () => {
  const legacyA = bareLegacyRow("/taishi-fixture/412-legacy-a", 1);
  const legacyB = bareLegacyRow("/taishi-fixture/412-legacy-b", 2);
  const modern = modernRow("book-new", "/taishi-fixture/412-modern", 3);

  // Direct build (sort path) — pre-fix threw TypeError on undefined.localeCompare.
  const page = buildTaishiLibraryIndexPage([legacyA, modern, legacyB]);
  assert.equal(page.rows.length, 3);
  for (const row of page.rows) {
    assert.equal(typeof row.bookKey, "string");
    assert.ok(row.bookKey.length > 0, "normalized bookKey non-empty");
  }

  // Upsert path mixes legacy existing + modern upsert.
  const merged = upsertTaishiLibraryIndexRows(
    { kind: "taishi-library-index", rows: [legacyA, legacyB] },
    [modern],
  );
  assert.equal(merged.rows.length, 3);
  const normalizedA = normalizeTaishiLibraryIndexRow(legacyA);
  assert.equal(
    normalizedA.bookKey,
    `root:${physicalPathIdentity("/taishi-fixture/412-legacy-a")}`,
  );
  assert.ok(
    findTaishiLibraryIndexRow(merged, 1, normalizedA.bookKey) !== undefined,
  );
  assert.ok(findTaishiLibraryIndexRow(merged, 3, "book-new") !== undefined);
});

test("401-F3: cohort present projection always includes bookKey for legacy rows", async () => {
  const home = await mkdtemp(join(tmpdir(), "taishi-412-f3-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerHome = join(home, ".ak-roles");
    const projectRoot = physicalPathIdentity("/taishi-fixture/412-present-legacy");
    const legacy = bareLegacyRow(projectRoot, 41);
    await writeTaishiLibraryIndexPage(
      ledgerHome,
      // Write raw legacy JSON (no bookKey field) to exercise read-boundary heal.
      {
        kind: "taishi-library-index",
        rows: [legacy],
      },
    );

    // Corrupt-style raw write: strip bookKey if normalize sneaked in via build.
    const rawPath = join(ledgerHome, "taishi", "library-index.json");
    await writeFile(
      rawPath,
      `${JSON.stringify(
        {
          kind: "taishi-library-index",
          rows: [
            {
              projectRoot,
              issueNumber: 41,
              totalElapsedMs: 0,
              changedLines: ABSENT_METRIC,
              msPerKLines: ABSENT_METRIC,
              lastActivityAt: ABSENT_METRIC,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const expectedBook = `root:${projectRoot}`;
    const stubPage = {
      kind: "taishi-issue-metrics",
      bookKey: expectedBook,
      projectRoot,
      issueNumber: 41,
      totalElapsedMs: 0,
      changedLines: ABSENT_METRIC,
      msPerKLines: ABSENT_METRIC,
      lastActivityAt: ABSENT_METRIC,
      legs: [],
    } as unknown as TaishiIssueMetricsPage;

    const result = await runTaishiCohortMode(
      ledgerHome,
      {
        mode: "cohort",
        groups: [
          { groupLabel: "a", issues: [{ bookKey: expectedBook, issueNumber: 41 }] },
          { groupLabel: "b", issues: [{ bookKey: expectedBook, issueNumber: 99 }] },
        ],
      },
      async () => stubPage,
    );

    const present = result.groups[0]!.issues[0]!;
    assert.equal(present.status, "present");
    if (present.status === "present") {
      assert.equal(present.bookKey, expectedBook);
      // JSON projection must retain the key (F3 mechanical shape).
      const serialized = JSON.stringify(present);
      assert.equal(
        serialized.includes("\"bookKey\""),
        true,
        `present JSON must carry bookKey: ${serialized}`,
      );
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("401-F2: dual-book same issueNumber — bare cwd book only; book:N selects the other", async () => {
  const home = await mkdtemp(join(tmpdir(), "taishi-412-f2-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerHome = join(home, ".ak-roles");
    const cwdBook = resolveBookKeyFromGit(process.cwd());
    const otherBook = "other-repo-book-412";
    const issueNumber = 181;
    const cwdRoot = physicalPathIdentity("/taishi-fixture/412-cwd-181");
    const otherRoot = physicalPathIdentity("/taishi-fixture/412-other-181");

    await writeTaishiLibraryIndexPage(
      ledgerHome,
      buildTaishiLibraryIndexPage([
        modernRow(cwdBook, cwdRoot, issueNumber),
        modernRow(otherBook, otherRoot, issueNumber),
      ]),
    );

    const index = await readTaishiLibraryIndexPage(ledgerHome);
    // Cross-book silent find is gone: issue-only lookup API requires bookKey.
    assert.equal(
      findTaishiLibraryIndexRow(index, issueNumber, cwdBook)?.projectRoot,
      cwdRoot,
    );
    assert.equal(
      findTaishiLibraryIndexRow(index, issueNumber, otherBook)?.projectRoot,
      otherRoot,
    );
    assert.equal(
      findTaishiLibraryIndexRow(index, issueNumber, "no-such-book"),
      undefined,
    );

    // Parse face: bare vs book-qualified tokens.
    assert.deepEqual(parseTaishiCohortIssueToken("181", "--group-a-issues"), {
      kind: "bare",
      issueNumber: 181,
    });
    assert.deepEqual(
      parseTaishiCohortIssueToken(`${otherBook}:181`, "--group-a-issues"),
      {
        kind: "book-qualified",
        bookKey: otherBook,
        issueNumber: 181,
      },
    );
    // Synthetic root: path (contains colons) still parses via last-colon split.
    const rootTok = parseTaishiCohortIssueToken(
      `root:${cwdRoot}:181`,
      "--group-a-issues",
    );
    assert.deepEqual(rootTok, {
      kind: "book-qualified",
      bookKey: `root:${cwdRoot}`,
      issueNumber: 181,
    });

    const parsedBare = parseTaishiArgv([
      "--cohort",
      "--group-a-label",
      "a",
      "--group-a-issues",
      "181",
      "--group-b-label",
      "b",
      "--group-b-issues",
      "999",
    ]);
    assert.equal(parsedBare.query, "cohort");
    if (parsedBare.query === "cohort") {
      assert.deepEqual(parsedBare.groups[0].issues[0], {
        kind: "bare",
        issueNumber: 181,
      });
    }

    const parsedQualified = parseTaishiArgv([
      "--cohort",
      "--group-a-label",
      "a",
      "--group-a-issues",
      `${otherBook}:181`,
      "--group-b-label",
      "b",
      "--group-b-issues",
      `${cwdBook}:181`,
    ]);
    assert.equal(parsedQualified.query, "cohort");
    if (parsedQualified.query === "cohort") {
      assert.deepEqual(parsedQualified.groups[0].issues[0], {
        kind: "book-qualified",
        bookKey: otherBook,
        issueNumber: 181,
      });
      assert.deepEqual(parsedQualified.groups[1].issues[0], {
        kind: "book-qualified",
        bookKey: cwdBook,
        issueNumber: 181,
      });
    }

    // Cohort fold: cwd-scoped 181 hits cwd row; other-book 181 hits other row.
    const stubFor = (root: string, book: string): TaishiIssueMetricsPage =>
      ({
        kind: "taishi-issue-metrics",
        bookKey: book,
        projectRoot: root,
        issueNumber,
        totalElapsedMs: 0,
        changedLines: ABSENT_METRIC,
        msPerKLines: ABSENT_METRIC,
        lastActivityAt: ABSENT_METRIC,
        legs: [],
      }) as unknown as TaishiIssueMetricsPage;

    const result = await runTaishiCohortMode(
      ledgerHome,
      {
        mode: "cohort",
        groups: [
          {
            groupLabel: "cwd-side",
            issues: [{ bookKey: cwdBook, issueNumber }],
          },
          {
            groupLabel: "other-side",
            issues: [{ bookKey: otherBook, issueNumber }],
          },
        ],
      },
      async ({ projectRoot, bookKey }) => stubFor(projectRoot, bookKey ?? "missing"),
    );

    assert.deepEqual(result.groups[0]!.issues, [
      {
        issueNumber,
        status: "present",
        bookKey: cwdBook,
        projectRoot: cwdRoot,
      },
    ]);
    assert.deepEqual(result.groups[1]!.issues, [
      {
        issueNumber,
        status: "present",
        bookKey: otherBook,
        projectRoot: otherRoot,
      },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
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
    // Bare N resolved to the cwd Git book and hit the healed legacy row.
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
