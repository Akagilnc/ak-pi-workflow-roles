/**
 * Shared fixtures for the analyst test family (#420 整改拆分收拢).
 * Extracted verbatim from analyst-entry.test.ts / analyst-public-bundle-families.test.ts —
 * no behavior change.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { withTempRoot } from "./primary-aware-cleanup.ts";
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
    const result = await fn(businessRepo);
    assert.equal(gitPorcelain(businessRepo), porcelainBefore, "business repo zero write");
    return result;
  });
}

/**
 * Test isolation helper providing a temporary `.ak-roles` ledger tree.
 * Callers pass the supplied `home` explicitly to analyst APIs or `env.home`.
 */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("analyst-home-", async (home) => {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  });
}

/** Recursive analyst-dir snapshot for zero-write oracles (path → file bytes). */
export async function snapshotAnalystDir(ledgerHome: string): Promise<Map<string, string>> {
  const root = join(ledgerHome, "analyst");
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return;
      }
      throw error;
    }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childPath = join(dir, name);
      const info = await stat(childPath);
      if (info.isDirectory()) {
        await walk(childPath, childRel);
        continue;
      }
      out.set(childRel, await readFile(childPath, "utf8"));
    }
  }
  await walk(root, "");
  return out;
}
