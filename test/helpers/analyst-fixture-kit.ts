import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureHome = join(fileURLToPath(new URL("../..", import.meta.url)), "test/fixtures/analyst/home");

export function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8" });
}

export async function withBusinessRepo<T>(fn: (repo: string, porcelainBefore: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "analyst-business-"));
  execFileSync("git", ["init"], { cwd: businessRepo });
  await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: businessRepo });
  const porcelainBefore = gitPorcelain(businessRepo);
  assert.equal(porcelainBefore, "", "business repo starts clean");
  const result = await fn(businessRepo, porcelainBefore);
  assert.equal(gitPorcelain(businessRepo), porcelainBefore, "business repo zero write");
  return result;
}

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "analyst-home-"));
  await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
  return await fn(home);
}
