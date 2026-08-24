/**
 * #413 r2 finding contracts (U1 + U3 counter-evidence).
 *
 * U1: the sole library-index read boundary must reject syntactically valid but
 *   malformed shapes (null / non-object / rows not an array) loudly with the
 *   file path — pre-fix the cast let them pass through and consumers crashed
 *   with untyped identity-free TypeErrors downstream.
 * U3: synthetic book keys are exactly `root:` + an ABSOLUTE path identity; a
 *   real Git book whose basename is literally `root:foo` is not synthetic.
 *   Bidirectional preservation: the real book keeps its book scope through a
 *   cohort cache-miss recompute even after its checkout disappears (pre-fix
 *   the bare prefix test dropped it into a synthetic root:<path> identity —
 *   wrong-book scan, wrong-key page rewrite), while existing synthetic keys
 *   keep their path-scope meaning.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import {
  isSyntheticAnalystBookKey,
} from "../../src/analyst-book-key.ts";
import {
  readAnalystLibraryIndexPage,
  analystLibraryIndexPath,
} from "../../src/analyst-index.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import type { AnalystCohortModeResult } from "../../src/analyst-cohort.ts";
import { analystIssuePagePath } from "../../src/analyst-page.ts";

const ABSENT_METRIC = { status: "absent" as const };

function withTempLedgerHome(): string {
  const home = mkdtempSync(join(tmpdir(), "analyst-413r2-home-"));
  mkdirSync(join(home, ".ak-roles", "analyst"), { recursive: true });
  return home;
}

// ---- U1: malformed shapes rejected at the sole read boundary ----

test("U1: library-index read boundary rejects null/non-object/rows-not-array with the file path", async () => {
  const home = withTempLedgerHome();
  try {
    const indexPath = analystLibraryIndexPath(join(home, ".ak-roles"));
    const malformed: unknown[] = [
      null,
      42,
      "a string",
      {},
      { kind: "analyst-library-index" },
      { kind: "analyst-library-index", rows: {} },
    ];
    for (const shape of malformed) {
      await writeFile(indexPath, `${JSON.stringify(shape)}\n`, "utf8");
      await assert.rejects(
        () => readAnalystLibraryIndexPage(join(home, ".ak-roles")),
        (error: Error) => {
          assert.match(
            error.message,
            /library-index at .* is malformed/,
            `shape ${JSON.stringify(shape)} must be rejected at the boundary`,
          );
          assert.ok(
            error.message.includes(indexPath),
            "rejection must carry the file path",
          );
          return true;
        },
        `pre-fix passthrough returned ${JSON.stringify(shape)} to consumers`,
      );
    }
    // Valid page (empty rows) still reads — the boundary rejects shapes, not content.
    await writeFile(
      indexPath,
      `${JSON.stringify({ kind: "analyst-library-index", rows: [] })}\n`,
      "utf8",
    );
    const page = await readAnalystLibraryIndexPage(join(home, ".ak-roles"));
    assert.deepEqual(page?.rows, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- U3: non-ambiguous synthetic classification (unit face) ----

test("U3: isSyntheticAnalystBookKey — root:<absolute path> is synthetic; real basename root:foo is not", () => {
  // Real Git book whose host-directory basename is literally `root:foo`:
  // remainder is not an absolute path → NOT synthetic (pre-fix prefix test killed it).
  assert.equal(isSyntheticAnalystBookKey("root:foo"), false);
  assert.equal(isSyntheticAnalystBookKey("plain-book"), false);
  // Existing synthetic keys keep their meaning: root: + absolute path identity.
  assert.equal(isSyntheticAnalystBookKey(`root:${physicalPathIdentity("/analyst-fixture/u3")}`), true);
});

// ---- U3: real book root:foo survives a cache-miss recompute (end-to-end) ----

const RUN_ID = "019ff000-9001-7000-8000-0000000009a1";

test("U3: real book basename root:foo keeps its book scope through cohort cache-miss recompute", async () => {
  const home = await mkdtemp(join(tmpdir(), "analyst-413r2-e2e-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerHome = join(home, ".ak-roles");
    // Real Git repository whose book key (common-dir host basename) is literally root:foo.
    const repoParent = mkdtempSync(join(tmpdir(), "analyst-413r2-repos-"));
    const repo = join(repoParent, "root:foo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    const repoIdentity = physicalPathIdentity(repo);

    // One typed-ticketed run inside book root:foo.
    const runDir = join(ledgerHome, "books", "root:foo", "runs", `${RUN_ID}@coder`);
    mkdirSync(join(runDir, "session"), { recursive: true });
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(
      join(runDir, "invocation.json"),
      `${JSON.stringify({
        role: "coder",
        runId: RUN_ID,
        bookKey: "root:foo",
        projectRoot: repoIdentity,
        ticketNumber: 7,
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(runDir, "artifacts", "report.json"),
      `${JSON.stringify({
        role: "coder",
        runId: RUN_ID,
        phase: "apply",
        outcome: { kind: "accepted", role: "coder", status: "completed", decisiveFacts: {} },
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(runDir, "session", "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "s-u3", timestamp: "2026-08-04T03:00:00.000Z", cwd: repoIdentity }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-04T03:00:00.000Z", message: { role: "assistant", model: "sol-low", timestamp: "2026-08-04T03:00:00.000Z", content: [] } }),
      ].join("\n") + "\n",
      "utf8",
    );

    // Issue-mode entry produces the page + index row under the REAL book key.
    await runAnalyst({
      mode: "issue",
      bookKey: "root:foo",
      projectRoot: repo,
      issueNumber: 7,
    });

    const pagePath = analystIssuePagePath(ledgerHome, {
      bookKey: "root:foo",
      issueNumber: 7,
    });
    // Counterexample shape: checkout deleted before the cohort query — the
    // recompute can no longer re-derive the book from the filesystem, so the
    // explicit real book key is the only lawful carrier.
    await rm(pagePath, { force: true });
    rmSync(repo, { recursive: true, force: true });

    const result = (await runAnalyst({
      mode: "cohort",
      groups: [
        { groupLabel: "real", issues: [{ bookKey: "root:foo", issueNumber: 7 }] },
        { groupLabel: "vacancy", issues: [{ bookKey: "no-such-book", issueNumber: 8 }] },
      ],
    })) as AnalystCohortModeResult;

    // Present projection stays bound to the real book (index join face).
    assert.deepEqual(result.groups[0]!.issues, [
      { issueNumber: 7, status: "present", bookKey: "root:foo", projectRoot: repoIdentity },
    ]);
    assert.deepEqual(result.groups[1]!.issues, [
      { issueNumber: 8, status: "absent", bookKey: "no-such-book" },
    ]);

    // The restored page must land under the REAL book key — pre-fix the
    // prefix misclassification recomputed under a synthetic root:<path>
    // identity (wrong-book scan, wrong-key page rewrite).
    const restored = JSON.parse(
      await readFile(pagePath, "utf8"),
    ) as {
      bookKey: string;
      issueNumber?: number;
      legs: readonly { runId: string }[];
    };
    assert.equal(restored.bookKey, "root:foo");
    assert.equal(restored.issueNumber, 7);
    assert.deepEqual(restored.legs.map((leg) => leg.runId), [RUN_ID]);

    rmSync(repoParent, { recursive: true, force: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
