/**
 * #412 — taishi library-index legacy bookKey + cohort book scope.
 *
 * 401-F1: legacy rows without bookKey must not crash sort/upsert (localeCompare).
 * 401-F3: present cohort projection always carries bookKey after normalize.
 * 401-F2/owner: bare issueNumber joins cwd book only; book:N for cross-book;
 *   dual-book same issueNumber never silently picks the other book.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { runTaishiCohortMode } from "../../src/taishi-cohort.ts";
import {
  parseTaishiArgv,
  parseTaishiCohortIssueToken,
} from "../../src/public-cli/invocation.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { TaishiIssueMetricsPage } from "../../src/taishi-page.ts";

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
