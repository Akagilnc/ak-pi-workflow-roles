/**
 * #337 analyst public CLI sweep — caller-invoked attach path (ADR 0052 / ADR 0068).
 *
 * Positive: one typed JSON attach → pages+index match library runAnalyst oracle.
 * Negative (3 classes, one zero-write fixture): cardinality / UTF-8|JSON / field contract.
 * Fixture identity: 7xxx segment reservation (reuse C1 boards; no new ledger runs).
 */
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import {
  analystLibraryIndexPath,
  type AnalystLibraryIndexPage,
} from "../../src/analyst-index.ts";
import type { AnalystIssueMetricsPage } from "../../src/analyst-page.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { ANALYST_ISSUE_DEMO as ISSUE_DEMO, C1_ISSUE_ALPHA as ISSUE_ALPHA, C1_ISSUE_BETA as ISSUE_BETA, snapshotAnalystDir, withTempHome } from "../helpers/analyst-fixture-kit.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

const VALID_SWEEP_INPUT = {
  mode: "sweep" as const,
  mergedPullRequests: [
    { projectRoot: ISSUE_DEMO, changedLines: 0 },
    { projectRoot: ISSUE_ALPHA, changedLines: 500 },
    { projectRoot: ISSUE_BETA },
  ],
};

/** Fixture home and isolated attachment directory. */
async function withSweepFixture<T>(
  fn: (ctx: {
    home: string;
    ledgerHome: string;
    attachDir: string;
  }) => Promise<T>,
): Promise<T> {
  return withTempHome((home) =>
    withTempRoot("analyst-337-attach-", (attachDir) => fn({
      home,
      ledgerHome: join(home, ".ak-roles"),
      attachDir,
    })),
  );
}

test("analyst public CLI sweep: one typed attach → pages+index match runAnalyst oracle", async () => {
  await withSweepFixture(async ({ home, ledgerHome, attachDir }) => {
    const attachPath = join(attachDir, "sweep-input.json");
    await writeFile(attachPath, `${JSON.stringify(VALID_SWEEP_INPUT)}\n`);

    const oracle = await runAnalyst(VALID_SWEEP_INPUT, { home });

    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["analyst", "--attach", attachPath],
      { packageRoot, home, io },
    );

    assert.equal(result.exitCode, 0, stderr.join(""));
    assert.equal(stderr.join(""), "");

    const receipt = JSON.parse(stdout.join("")) as {
      mode: string;
      issuePages: readonly { page: AnalystIssueMetricsPage }[];
      index: AnalystLibraryIndexPage;
      indexPath: string;
    };
    assert.equal(receipt.mode, "sweep");
    assert.deepEqual(
      receipt.issuePages.map((p) => p.page),
      oracle.issuePages.map((p) => p.page),
    );
    assert.deepEqual(receipt.index, oracle.index);
    assert.equal(receipt.indexPath, analystLibraryIndexPath(ledgerHome));
    assert.deepEqual(
      JSON.parse(await readFile(analystLibraryIndexPath(ledgerHome), "utf8")),
      oracle.index,
    );
  });
});

test("analyst public CLI sweep reject classes: typed envelope + zero writes", async () => {
  await withSweepFixture(async ({ home, ledgerHome, attachDir }) => {
    await mkdir(join(ledgerHome, "analyst"), { recursive: true });
    const before = await snapshotAnalystDir(ledgerHome);

    const validPath = join(attachDir, "valid.json");
    await writeFile(validPath, `${JSON.stringify(VALID_SWEEP_INPUT)}\n`);
    const validPathB = join(attachDir, "valid-b.json");
    await writeFile(validPathB, `${JSON.stringify(VALID_SWEEP_INPUT)}\n`);
    const badUtf8Path = join(attachDir, "bad-utf8.json");
    await writeFile(badUtf8Path, Buffer.from([0x7b, 0x80, 0x7d]));
    const badJsonPath = join(attachDir, "bad-json.json");
    await writeFile(badJsonPath, "{ not json\n");

    const fieldBodies: readonly { name: string; body: unknown }[] = [
      { name: "missing-mode.json", body: { mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }] } },
      {
        name: "wrong-mode.json",
        body: { mode: "issue", mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }] },
      },
      {
        name: "changedLines-type.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: "500" }],
        },
      },
      {
        name: "changedLines-negative.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: -1 }],
        },
      },
      {
        name: "changedLines-infinity.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: null }],
        },
      },
      // Type mismatch (not unauthorized nonempty): projectRoot must be string.
      {
        name: "projectRoot-type.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: 1 }],
        },
      },
    ];
    const fieldPaths: { path: string; name: string }[] = [];
    for (const entry of fieldBodies) {
      const path = join(attachDir, entry.name);
      await writeFile(path, `${JSON.stringify(entry.body)}\n`);
      fieldPaths.push({ path, name: entry.name });
    }

    const cases: readonly {
      name: string;
      argv: readonly string[];
    }[] = [
      // ① cardinality (0 / >1 / mixed with issue faces)
      { name: "no-attach", argv: ["analyst", "sweep"] },
      {
        name: "multi-attach",
        argv: ["analyst", "--attach", validPath, "--attach", validPathB],
      },
      // --project-root's unconditional refusal is carried by the real CLI case
      // in analyst-public-cli.test.ts; the sweep case keeps the distinct
      // attach-cardinality and field-grammar contracts below.
      // ② non-UTF-8 / JSON parse failure
      { name: "bad-utf8", argv: ["analyst", "--attach", badUtf8Path] },
      { name: "bad-json", argv: ["analyst", "--attach", badJsonPath] },
      // ③ field missing / wrong type
      ...fieldPaths.map((f) => ({
        name: f.name,
        argv: ["analyst", "--attach", f.path] as const,
      })),
    ];

    for (const entry of cases) {
      const { io } = captureIo();
      const result = await runAkRole([...entry.argv], { packageRoot, home, io });
      assert.equal(result.exitCode, 2, entry.name);
      assert.deepEqual(
        [...(await snapshotAnalystDir(ledgerHome)).entries()].sort(),
        [...before.entries()].sort(),
        entry.name,
      );
    }

    const acceptedExtras: readonly { name: string; body: unknown }[] = [
      {
        name: "extra-top.json",
        body: { mode: "sweep", mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }], extra: true },
      },
      {
        name: "entry-extra.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, issueNumber: 7 }],
        },
      },
    ];
    for (const entry of acceptedExtras) {
      const path = join(attachDir, entry.name);
      await writeFile(path, `${JSON.stringify(entry.body)}\n`);
      const { io, stdout } = captureIo();
      const result = await runAkRole(["analyst", "--attach", path], { packageRoot, home, io });
      assert.equal(result.exitCode, 0, entry.name);
      const receipt = JSON.parse(stdout.join("")) as { mode: string };
      assert.equal(receipt.mode, "sweep", entry.name);
    }
  });
});
