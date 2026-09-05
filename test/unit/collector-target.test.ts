/**
 * #676 D1: Collector target recognition — explicit PR, unique branch association, ambiguity.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCollectorTarget } from "../../src/collector-target.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import type { GhApiRunner } from "../../src/collector-github.ts";

const repository = {
  display: "acme/widgets",
  canonical: "acme/widgets",
  owner: "acme",
  repo: "widgets",
} as const;

function isUsage(error: unknown): boolean {
  return error instanceof CliUsageError;
}

test("#676 D1 explicit --pr is used without online lookup", async () => {
  let called = 0;
  const runner: GhApiRunner = async () => {
    called += 1;
    throw new Error("runner must not run for explicit PR");
  };
  const target = await resolveCollectorTarget({
    projectRoot: "/tmp",
    repository,
    explicitPrNumber: 42,
    runner,
  });
  assert.deepEqual(target, { kind: "explicit", prNumber: 42 });
  assert.equal(called, 0);
});

test("#676 D1 unique branch-head PR resolves without guessing", async () => {
  const calls: string[][] = [];
  const runner: GhApiRunner = async (args) => {
    calls.push(args);
    return {
      status: 200,
      headers: {},
      bodyText: JSON.stringify([{ number: 77, head: { ref: "feature/x" } }]),
    };
  };
  const target = await resolveCollectorTarget({
    projectRoot: "/tmp",
    repository,
    currentBranch: "feature/x",
    runner,
  });
  assert.deepEqual(target, {
    kind: "branch-head",
    prNumber: 77,
    branch: "feature/x",
  });
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0]!.some((arg) =>
      arg.startsWith("/repos/acme/widgets/pulls?") &&
      arg.includes("head=") &&
      arg.includes("acme%3Afeature%2Fx") &&
      arg.includes("state=all"),
    ),
  );
});

test("#676 D1 zero or many branch PRs require explicit --pr", async () => {
  const empty: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: "[]",
  });
  await assert.rejects(
    () =>
      resolveCollectorTarget({
        projectRoot: "/tmp",
        repository,
        currentBranch: "no-pr-branch",
        runner: empty,
      }),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      /ambiguous/.test(error.message) &&
      /explicit --pr/.test(error.message),
  );

  const many: GhApiRunner = async () => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify([{ number: 1 }, { number: 2 }]),
  });
  await assert.rejects(
    () =>
      resolveCollectorTarget({
        projectRoot: "/tmp",
        repository,
        currentBranch: "shared-branch",
        runner: many,
      }),
    (error: unknown) =>
      isUsage(error) &&
      error instanceof Error &&
      /multiple PRs/.test(error.message) &&
      /explicit --pr/.test(error.message),
  );
});

test("#676 D1 detached HEAD without --pr is ambiguous", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-collector-target-"));
  try {
    execFileSync("git", ["init"], { cwd: home, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
      cwd: home,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    // Detach HEAD
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: home,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "--detach", sha], {
      cwd: home,
      stdio: "ignore",
    });
    await assert.rejects(
      () =>
        resolveCollectorTarget({
          projectRoot: home,
          repository,
          runner: async () => {
            throw new Error("must not look up");
          },
        }),
      (error: unknown) =>
        isUsage(error) &&
        error instanceof Error &&
        /ambiguous/.test(error.message) &&
        /explicit --pr/.test(error.message),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
