/**
 * Shared fixtures for the analyst test family (#420 整改拆分收拢).
 * Extracted verbatim from analyst-entry.test.ts / analyst-public-bundle-families.test.ts —
 * no behavior change.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { worktreeTempPrefix } from "./worktree-temp.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

export async function withBusinessRepo<T>(fn: (repo: string, porcelainBefore: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(worktreeTempPrefix("analyst-business-"));
  try {
    execFileSync("git", ["init"], { cwd: businessRepo });
    await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: businessRepo },
    );
    const porcelainBefore = gitPorcelain(businessRepo);
    assert.equal(porcelainBefore, "", "business repo starts clean");
    const result = await fn(businessRepo, porcelainBefore);
    assert.equal(gitPorcelain(businessRepo), porcelainBefore, "business repo zero write");
    return result;
  } finally {
    await rm(businessRepo, { recursive: true, force: true });
  }
}

/**
 * Test isolation helper providing a temporary `.ak-roles` ledger tree.
 * Callers pass the supplied `home` explicitly to analyst APIs or `env.home`.
 */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(worktreeTempPrefix("analyst-home-"));
  try {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
