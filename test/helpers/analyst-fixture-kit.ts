/**
 * Shared fixtures for the analyst test family (#420 整改拆分收拢).
 * Extracted verbatim from analyst-entry.test.ts / analyst-public-bundle-families.test.ts —
 * no behavior change.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, writeFile } from "node:fs/promises";
import { machineLedgerHome, seedGitRepository, withTempRoot } from "./environment-fixtures.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ANALYST_FIXTURE_BOOK = "fixture-book";
export const ANALYST_ISSUE_DEMO = "/analyst-fixture/issue-demo";
export const ANALYST_LEG_A1_RUN = "019ff000-0001-7000-8000-0000000000a1";
export const ANALYST_LEG_B2_RUN = "019ff000-0002-7000-8000-0000000000b2";
export const ANALYST_LEG_E5_RUN = "019ff000-0005-7000-8000-0000000000e5";
export const C1_ISSUE_ALPHA = "/analyst-fixture/c1-issue-alpha";
export const C1_ISSUE_BETA = "/analyst-fixture/c1-issue-beta";
export const C1_ALPHA_RUN = "019ff000-1001-7000-8000-0000000001a1";

export const fixtureHome = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "test/fixtures/analyst/home",
);

export function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

export async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  return withTempRoot("analyst-business-", async (businessRepo) => {
    seedGitRepository(businessRepo);
    await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: businessRepo },
    );
    const porcelainBefore = gitPorcelain(businessRepo);
    assert.equal(porcelainBefore, "", "business repo starts clean");
    const result = await fn(businessRepo);
    assert.equal(gitPorcelain(businessRepo), porcelainBefore, "business repo zero write");
    return result;
  });
}

/**
 * Analyst domain seed; allocation and teardown belong to environment-fixtures.
 * Callers pass the supplied `home` explicitly to analyst APIs or `env.home`.
 */
export async function withAnalystHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("analyst-home-", async (home) => {
    await cp(fixtureHome, machineLedgerHome(home), { recursive: true });
    return await fn(home);
  });
}

