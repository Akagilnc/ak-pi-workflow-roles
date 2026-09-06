import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #332 analyst-C4 — issue scope typed ticketNumber (#176).
 * #399: ticket face is strict — no silent projectRoot fallback for unbound runs;
 *       book × ticket is the query scope (projectRoot path-narrow is sweep/legacy only).
 *
 * Two fixture paths, hand-computed expected runId sets:
 * 1) ticketNumber path: typed ticket alone admits within scanned books.
 * 2) no-ticketNumber path: sweep/legacy projectRoot path-narrow filter (non-git pointer).
 * C4 fixture runs use exclusive runId segment 019ff000-4xxx.
 * Assert only through sole entry runAnalyst — no second parse kernel.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/analyst/home");

/** Issue primary root — legacy path-narrow / display face. */
const ISSUE_PRIMARY = "/analyst-fixture/c4-issue-primary";
/** Alien root used historically for dual-key conflict; ticket path no longer conflicts. */
const ISSUE_ALIEN = "/analyst-fixture/c4-issue-alien";
/** Dedicated root for no-ticketNumber path-narrow path. */
const ISSUE_FALLBACK = "/analyst-fixture/c4-issue-fallback";

/** Caller typed ticket face for the ticket path. */
const SCOPE_TICKET = 4401;
/** Decoy ticket bound on a primary-root run — must stay out when typed wins. */
const DECOY_TICKET = 9999;

const RUN_TICKET_MATCH_PRIMARY = "019ff000-4001-7000-8000-0000000004a1";
const RUN_TICKET_MATCH_ALIEN = "019ff000-4002-7000-8000-0000000004a2";
const RUN_NO_TICKET_PRIMARY = "019ff000-4003-7000-8000-0000000004a3";
const RUN_DECOY_TICKET_PRIMARY = "019ff000-4004-7000-8000-0000000004a4";
const RUN_NO_TICKET_ALIEN = "019ff000-4005-7000-8000-0000000004a5";
const RUN_FALLBACK_IN = "019ff000-4010-7000-8000-0000000004b0";
const RUN_FALLBACK_OUT = "019ff000-4011-7000-8000-0000000004b1";

/**
 * Hand oracle — ticketNumber path (bookKey fixture-book-c4, ticket=4401):
 *   4001 ticket 4401 + primary → IN
 *   4002 ticket 4401 + alien   → IN (same book; no projectRoot conflict on book×ticket)
 *   4003 no ticket + primary   → OUT (#399: no path fallback when ticket requested)
 *   4004 ticket 9999 + primary → OUT
 *   4005 no ticket + alien     → OUT
 */
const EXPECTED_TICKET_PATH_RUN_IDS = [
  RUN_TICKET_MATCH_PRIMARY,
  RUN_TICKET_MATCH_ALIEN,
].sort();

/**
 * Hand oracle — no-ticketNumber path (input projectRoot=fallback only, legacy narrow):
 *   4010 no ticket + fallback → IN
 *   4011 no ticket + alien    → OUT
 */
const EXPECTED_FALLBACK_RUN_IDS = [RUN_FALLBACK_IN];

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  return withTempRoot("analyst-c4-business-", async (businessRepo) => {
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
  return withTempRoot("analyst-c4-home-", async (home) => {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  });
}

test("analyst C4 ticket path: typed ticketNumber alone admits; no path fallback", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const result = await runAnalyst({
        mode: "issue",
        bookKey: "fixture-book-c4",
        projectRoot: ISSUE_PRIMARY,
        ticketNumber: SCOPE_TICKET,
        issueNumber: SCOPE_TICKET,
      }, { home });

      assert.equal(result.mode, "issue");
      assert.equal(result.page.bookKey, "fixture-book-c4");
      assert.equal(result.page.issueNumber, SCOPE_TICKET);

      // Exact runId set equality (hand oracle) — readable legs only.
      const actualRunIds = result.page.legs.map((leg) => leg.runId).sort();
      assert.deepEqual(actualRunIds, EXPECTED_TICKET_PATH_RUN_IDS);

      // Unbound primary-root run must not enter via path fallback when ticket is set.
      assert.equal(actualRunIds.includes(RUN_NO_TICKET_PRIMARY), false);
      // Decoy ticket on primary root and alien unbound must stay out.
      assert.equal(actualRunIds.includes(RUN_DECOY_TICKET_PRIMARY), false);
      assert.equal(actualRunIds.includes(RUN_NO_TICKET_ALIEN), false);
      // Book×ticket scope does not emit projectRoot dual-key conflicts.
      assert.deepEqual(result.page.scopeConflicts, []);
      void DECOY_TICKET;
      void ISSUE_ALIEN;
    });
  });
});

test("analyst C4 no-ticketNumber path: sweep/legacy projectRoot path-narrow", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const result = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_FALLBACK,
      }, { home });

      assert.equal(result.mode, "issue");

      const actualRunIds = result.page.legs.map((leg) => leg.runId).sort();
      assert.deepEqual(actualRunIds, EXPECTED_FALLBACK_RUN_IDS);

      // Alien-root unbound run must not enter via any other key.
      assert.equal(actualRunIds.includes(RUN_FALLBACK_OUT), false);
      // No ticketNumber on input → no typed/projectRoot conflict surface.
      assert.deepEqual(result.page.scopeConflicts, []);
      assert.equal(result.page.bookKey, `root:${physicalPathIdentity(ISSUE_FALLBACK)}`);
      assert.equal(result.page.scopeRootIdentity !== undefined, true);
    });
  });
});
