/**
 * #332 taishi-C4 — issue scope prefers typed ticketNumber (#176) over projectRoot.
 *
 * Two fixture paths, hand-computed expected runId sets:
 * 1) ticketNumber path: typed ticket vs projectRoot mechanical-key conflict —
 *    typed wins; metrics page records runId, ticketNumber, projectRoot, conflict fact.
 * 2) no-ticketNumber path: projectRoot mechanical-key fallback.
 * C4 fixture runs use exclusive runId segment 019ff000-4xxx.
 * Assert only through sole entry runTaishi — no second parse kernel.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import type { TaishiScopeConflict } from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

/** Issue primary root — ticket path scope projectRoot. */
const ISSUE_PRIMARY = "/taishi-fixture/c4-issue-primary";
/** Alien root used to force typed-vs-projectRoot conflict. */
const ISSUE_ALIEN = "/taishi-fixture/c4-issue-alien";
/** Dedicated root for no-ticketNumber fallback path. */
const ISSUE_FALLBACK = "/taishi-fixture/c4-issue-fallback";

/** Caller typed ticket face for the conflict path. */
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
 * Hand oracle — ticketNumber path (input ticket=4401, projectRoot=primary):
 *   4001 ticket 4401 + primary → IN (no conflict)
 *   4002 ticket 4401 + alien   → IN by typed; CONFLICT recorded
 *   4003 no ticket + primary   → IN by projectRoot fallback
 *   4004 ticket 9999 + primary → OUT (typed ticket prefers over projectRoot match)
 *   4005 no ticket + alien     → OUT
 */
const EXPECTED_TICKET_PATH_RUN_IDS = [
  RUN_TICKET_MATCH_PRIMARY,
  RUN_TICKET_MATCH_ALIEN,
  RUN_NO_TICKET_PRIMARY,
].sort();

const EXPECTED_CONFLICT: TaishiScopeConflict = {
  runId: RUN_TICKET_MATCH_ALIEN,
  ticketNumber: SCOPE_TICKET,
  projectRoot: physicalPathIdentity(ISSUE_ALIEN),
  fact: "typed-ticketNumber-over-projectRoot",
};

/**
 * Hand oracle — no-ticketNumber path (input projectRoot=fallback only):
 *   4010 no ticket + fallback → IN
 *   4011 no ticket + alien    → OUT
 *   (ticket-path runs never share this projectRoot)
 */
const EXPECTED_FALLBACK_RUN_IDS = [RUN_FALLBACK_IN];

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-c4-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "taishi-c4-home-"));
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

test("taishi C4 ticket path: typed ticketNumber wins conflict; page records four conflict facts", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      const result = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PRIMARY,
        ticketNumber: SCOPE_TICKET,
      });

      assert.equal(result.mode, "issue");

      // Exact runId set equality (hand oracle) — readable legs only.
      const actualRunIds = result.page.legs.map((leg) => leg.runId).sort();
      assert.deepEqual(actualRunIds, EXPECTED_TICKET_PATH_RUN_IDS);

      // Decoy ticket on primary root and alien unbound must stay out.
      assert.equal(actualRunIds.includes(RUN_DECOY_TICKET_PRIMARY), false);
      assert.equal(actualRunIds.includes(RUN_NO_TICKET_ALIEN), false);

      // Conflict: typed ticket matched while projectRoot mechanical key differed.
      assert.deepEqual(result.page.scopeConflicts, [EXPECTED_CONFLICT]);
      const conflict = result.page.scopeConflicts[0]!;
      assert.equal(conflict.runId, RUN_TICKET_MATCH_ALIEN);
      assert.equal(conflict.ticketNumber, SCOPE_TICKET);
      assert.equal(conflict.projectRoot, physicalPathIdentity(ISSUE_ALIEN));
      assert.equal(conflict.fact, "typed-ticketNumber-over-projectRoot");
    });
  });
});

test("taishi C4 no-ticketNumber path: projectRoot mechanical-key fallback", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      const result = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_FALLBACK,
      });

      assert.equal(result.mode, "issue");

      const actualRunIds = result.page.legs.map((leg) => leg.runId).sort();
      assert.deepEqual(actualRunIds, EXPECTED_FALLBACK_RUN_IDS);

      // Alien-root unbound run must not enter via any other key.
      assert.equal(actualRunIds.includes(RUN_FALLBACK_OUT), false);
      // No ticketNumber on input → no typed/projectRoot conflict surface.
      assert.deepEqual(result.page.scopeConflicts, []);
    });
  });
});
