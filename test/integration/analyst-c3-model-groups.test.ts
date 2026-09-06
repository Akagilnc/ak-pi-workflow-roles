import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #331 analyst-C3 — model-group mode tracer.
 *
 * Typed input = issue-set scope + optional combination mapping → per-leg raw
 * model groups (single | mixed:ordered-dedup) with acceptance/success/median/
 * no-receipt rates. Mapping is display-alias only (no merge, no den change).
 * C3 fixture runs use exclusive runId segment 019ff000-3xxx.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAnalyst } from "../../src/analyst-entry.ts";
import type {
  AnalystModelGroupRow,
  AnalystModelGroupsPage,
} from "../../src/analyst-model-groups.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/analyst/home");

/** C3-owned scope — model-bearing + model-absent legs under runId 019ff000-3xxx. */
const C3_SCOPE = "/analyst-fixture/c3-models";

/** Fixture leg with session timestamps but no model face (typed vacancy). */
const C3_NO_MODEL_RUN_ID = "019ff000-3008-7000-8000-000000000308";

/**
 * Hand values (whole-leg unit; walls in ms):
 *
 * 3001 coder grok-4.5 completed  60_000
 * 3002 coder grok-4.5 completed  40_000
 * 3003 coder sol-low  refused    20_000
 * 3004 coder mixed:grok-4.5+sol-low completed 30_000
 * 3005 coder grok-4.5 no-receipt 10_000
 * 3006 coder luna-high completed 50_000
 * 3007 coder grok-4.5 planned    70_000
 * 3008 coder (no model identity) completed 15_000 — not a group member
 *
 * grok-4.5 (3001,3002,3005,3007):
 *   n=4 accepted=3 (completed×2 + planned) rate=3/4
 *   successEligible=2 success=2 rate=1
 *   noReceipt=1 rate=1/4
 *   walls [10k,40k,60k,70k] median=(40k+60k)/2=50_000
 *
 * sol-low (3003):
 *   n=1 accepted=1 rate=1; successEligible=1 success=0 rate=0
 *   noReceipt=0 rate=0; median=20_000
 *
 * mixed:grok-4.5+sol-low (3004):
 *   n=1 accepted=1 rate=1; success=1 rate=1; noReceipt=0; median=30_000
 *
 * luna-high (3006):
 *   n=1 accepted=1 rate=1; success=1 rate=1; noReceipt=0; median=50_000
 *
 * no-model (3008): typed unreadable session-model vacancy; excluded from every
 *   group numerator/denominator; never rawGroupKey/displayName === "".
 */
const EXPECTED_RAW: readonly AnalystModelGroupRow[] = [
  {
    rawGroupKey: "grok-4.5",
    displayName: "grok-4.5",
    legCount: 4,
    acceptedCount: 3,
    acceptanceRate: 3 / 4,
    successCount: 2,
    successEligibleCount: 2,
    successRate: 1,
    noReceiptCount: 1,
    noReceiptRate: 1 / 4,
    wallClockMedianMs: 50_000,
  },
  {
    rawGroupKey: "luna-high",
    displayName: "luna-high",
    legCount: 1,
    acceptedCount: 1,
    acceptanceRate: 1,
    successCount: 1,
    successEligibleCount: 1,
    successRate: 1,
    noReceiptCount: 0,
    noReceiptRate: 0,
    wallClockMedianMs: 50_000,
  },
  {
    rawGroupKey: "mixed:grok-4.5+sol-low",
    displayName: "mixed:grok-4.5+sol-low",
    legCount: 1,
    acceptedCount: 1,
    acceptanceRate: 1,
    successCount: 1,
    successEligibleCount: 1,
    successRate: 1,
    noReceiptCount: 0,
    noReceiptRate: 0,
    wallClockMedianMs: 30_000,
  },
  {
    rawGroupKey: "sol-low",
    displayName: "sol-low",
    legCount: 1,
    acceptedCount: 1,
    acceptanceRate: 1,
    successCount: 0,
    successEligibleCount: 1,
    successRate: 0,
    noReceiptCount: 0,
    noReceiptRate: 0,
    wallClockMedianMs: 20_000,
  },
];

/** Alias map: two raw singles collide on display "Grok"; luna aliased; mixed unmapped. */
const COMBINATION_MAPPING = {
  "grok-4.5": "Grok",
  "sol-low": "Grok",
  "luna-high": "Luna",
} as const;

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  return withTempRoot("analyst-c3-business-", async (businessRepo) => {
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
  });
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("analyst-c3-home-", async (home) => {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  });
}

function assertGroupEqual(actual: AnalystModelGroupRow, expected: AnalystModelGroupRow): void {
  assert.equal(actual.rawGroupKey, expected.rawGroupKey);
  assert.equal(actual.displayName, expected.displayName);
  assert.equal(actual.legCount, expected.legCount);
  assert.equal(actual.acceptedCount, expected.acceptedCount);
  assert.equal(actual.acceptanceRate, expected.acceptanceRate);
  assert.equal(actual.successCount, expected.successCount);
  assert.equal(actual.successEligibleCount, expected.successEligibleCount);
  assert.equal(actual.successRate, expected.successRate);
  assert.equal(actual.noReceiptCount, expected.noReceiptCount);
  assert.equal(actual.noReceiptRate, expected.noReceiptRate);
  assert.equal(actual.wallClockMedianMs, expected.wallClockMedianMs);
}

test("analyst C3 model-groups: fixture mixed+singles hand-equal; mapping alias-only no merge; no-model excluded", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const raw = await runAnalyst({
        mode: "model-groups",
        projectRoots: [C3_SCOPE],
      }, { home });
      assert.equal(raw.mode, "model-groups");
      const page: AnalystModelGroupsPage = raw.page;
      assert.equal(page.kind, "analyst-model-groups");
      // Only model-bearing legs enter group dens (3001–3007).
      assert.equal(page.legCount, 7);
      assert.equal(page.groups.length, EXPECTED_RAW.length);
      for (let i = 0; i < EXPECTED_RAW.length; i += 1) {
        assertGroupEqual(page.groups[i]!, EXPECTED_RAW[i]!);
      }

      // No invented empty-string group.
      assert.equal(
        page.groups.some((g) => g.rawGroupKey === "" || g.displayName === ""),
        false,
      );

      // Denominators must sum to model-bearing legs (no double-count / no drop).
      const denSum = page.groups.reduce((n, g) => n + g.legCount, 0);
      assert.equal(denSum, page.legCount);

      // 3008: usable session/terminal but no model identity → typed vacancy.
      assert.equal(page.unreadableCount, 1);
      assert.equal(page.unreadable.length, 1);
      const absent = page.unreadable[0]!;
      assert.equal(absent.runId, C3_NO_MODEL_RUN_ID);
      assert.deepEqual(absent.missingSources, ["session-model"]);
      assert.match(absent.reason, /model identity/i);
      // Vacancy must not inflate any group numerator/denominator.
      assert.equal(
        page.groups.reduce(
          (n, g) => n + g.acceptedCount + g.successCount + g.noReceiptCount,
          0,
        ),
        // accepted: grok3 + sol1 + mixed1 + luna1 = 6; success: 2+0+1+1=4; noReceipt: 1
        6 + 4 + 1,
      );

      const aliased = await runAnalyst({
        mode: "model-groups",
        projectRoots: [C3_SCOPE],
        combinationMapping: COMBINATION_MAPPING,
      }, { home });
      assert.equal(aliased.mode, "model-groups");
      const aliasedPage = aliased.page;
      // Same raw groups + dens — mapping must not merge or change stats.
      assert.equal(aliasedPage.groups.length, EXPECTED_RAW.length);
      assert.equal(
        aliasedPage.groups.reduce((n, g) => n + g.legCount, 0),
        7,
      );
      assert.equal(aliasedPage.unreadableCount, 1);
      assert.equal(aliasedPage.unreadable[0]!.runId, C3_NO_MODEL_RUN_ID);

      const byRaw = new Map(aliasedPage.groups.map((g) => [g.rawGroupKey, g]));
      const grok = byRaw.get("grok-4.5");
      const sol = byRaw.get("sol-low");
      const mixed = byRaw.get("mixed:grok-4.5+sol-low");
      const luna = byRaw.get("luna-high");
      assert.ok(grok && sol && mixed && luna);

      // Display aliases only.
      assert.equal(grok.displayName, "Grok");
      assert.equal(sol.displayName, "Grok"); // conflict: same display, separate rows
      assert.equal(luna.displayName, "Luna");
      assert.equal(mixed.displayName, "mixed:grok-4.5+sol-low"); // unmapped keeps raw

      // Stats identity unchanged vs raw run (collision does not merge dens).
      assertGroupEqual(
        { ...grok, displayName: "grok-4.5" },
        EXPECTED_RAW.find((g) => g.rawGroupKey === "grok-4.5")!,
      );
      assertGroupEqual(
        { ...sol, displayName: "sol-low" },
        EXPECTED_RAW.find((g) => g.rawGroupKey === "sol-low")!,
      );
      assert.equal(grok.legCount, 4);
      assert.equal(sol.legCount, 1);
      // Two rows share display "Grok" but remain distinct raw identities.
      const grokDisplayRows = aliasedPage.groups.filter((g) => g.displayName === "Grok");
      assert.equal(grokDisplayRows.length, 2);
      assert.deepEqual(
        grokDisplayRows.map((g) => g.rawGroupKey).sort(),
        ["grok-4.5", "sol-low"],
      );
    });
  });
});
