import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot, runPiSubprocess } from "../helpers/pi-test-harness.ts";

const git = (cwd: string, args: string[], input?: string) => execFileSync("git", args, {
  cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"],
}).trim();

async function conflictedRepository(root: string) {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Merger Public Test"]);
  git(root, ["config", "user.email", "merger-public@test.local"]);
  await writeFile(join(root, "same.txt"), "base\n");
  git(root, ["add", "."]); git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "source"]);
  await writeFile(join(root, "same.txt"), "source\n");
  git(root, ["commit", "-am", "source"]); const source = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "main"]);
  await writeFile(join(root, "same.txt"), "target\n");
  git(root, ["commit", "-am", "target"]); const target = git(root, ["rev-parse", "HEAD"]);
  assert.throws(() => git(root, ["merge", "--no-edit", "source"]));
  const blob = git(root, ["hash-object", "-w", "--stdin"], "resolved\n");
  const index = join(root, "expected-index");
  const indexEnv = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", "AUTO_MERGE^{tree}"], { cwd: root, env: indexEnv });
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},same.txt`], { cwd: root, env: indexEnv });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, env: indexEnv, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-p", target, "-p", source, "-m", "resolve"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  }).trim();
  await mkdir(join(root, ".ak/work"), { recursive: true });
  await writeFile(join(root, ".ak/work/opening.jsonl"), "opening role evidence\n");
  await writeFile(join(root, ".git/info/exclude"), "expected-index\n");
  return commit;
}

async function tracePublicMerger(residual?: "sole" | "sibling" | "wrong-attempt") {
  const providerPath = resolve(packageRoot, "test/fixtures/merger-baseline-provider.ts");
  const home = await mkdtemp(join(tmpdir(), `ak-public-merger-${residual ?? "accepted"}-`));
  try {
    const project = join(home, "work"); await mkdir(project);
    const commit = await conflictedRepository(project);
    return await runAkRole([
      "merger", "--model", "ak-merger-baseline/faux-1", "--thinking", "off",
      "--project", project, "Resolve the ordinary conflict.",
    ], {
      packageRoot, home, agentDir: join(home, ".pi", "agent"), cwd: project,
      createRunId: () => "run-merger-baseline-public",
      mergerExtraPiArgs: ["-e", providerPath], mergerTimeoutMs: 90_000,
      io: { stdout() {}, stderr() {} },
      piRunner: async (args, options) => {
        const run = await runPiSubprocess([...args], { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 90_000,
          env: { ...options.env, PI_OFFLINE: "1", AK_MERGER_FIXTURE_COMMIT: commit,
            ...(residual === undefined ? {} : { AK_MERGER_FIXTURE_RESIDUAL: residual }) } });
        return { code: run.code, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut, args: [...args] };
      },
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("public Merger preserves residual failure precedence", { timeout: 240_000 }, async () => {
  for (const residual of ["sole", "sibling", "wrong-attempt"] as const) {
    const result = await tracePublicMerger(residual);
    const outcome = result.terminal?.roleOutcome;
    assert.equal(outcome?.role, "merger", residual);
    assert.notEqual(result.exitCode, 0, residual);
    assert.notEqual(outcome?.decisiveFacts.acceptedReceipt, true, residual);
    assert.equal(outcome?.kind, residual === "sole" ? "incomplete" : "failure", residual);
  }
});

test("public Merger preserves opening .ak dirt and rejects every residual mutation", { timeout: 240_000 }, async () => {
  const providerPath = resolve(packageRoot, "test/fixtures/merger-baseline-provider.ts");
  for (const mutation of ["unchanged", "new", "changed", "deleted"] as const) {
    const home = await mkdtemp(join(tmpdir(), `ak-public-merger-${mutation}-`));
    try {
      const project = join(home, "work"); await mkdir(project);
      const commit = await conflictedRepository(project);
      const result = await runAkRole([
        "merger", "--model", "ak-merger-baseline/faux-1", "--thinking", "off",
        "--project", project, "Resolve the ordinary conflict.",
      ], {
        packageRoot, home, agentDir: join(home, ".pi", "agent"), cwd: project,
        createRunId: () => "run-merger-baseline-public",
        mergerExtraPiArgs: ["-e", providerPath], mergerTimeoutMs: 90_000,
        io: { stdout() {}, stderr() {} },
        piRunner: async (args, options) => {
          const run = await runPiSubprocess([...args], { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 90_000,
            env: { ...options.env, PI_OFFLINE: "1", AK_MERGER_FIXTURE_COMMIT: commit, AK_MERGER_FIXTURE_MUTATION: mutation } });
          return { code: run.code, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut, args: [...args] };
        },
      });
      const outcome = result.terminal?.roleOutcome;
      assert.equal(outcome?.role, "merger", mutation);
      if (mutation === "unchanged") {
        assert.equal(result.exitCode, 0);
        assert.equal(outcome?.kind, "accepted");
        assert.equal(outcome?.status, "completed");
      } else {
        assert.notEqual(result.exitCode, 0, mutation);
        assert.equal(outcome?.kind, "failure", mutation);
        assert.equal(outcome?.cause, "activation", mutation);
        assert.notEqual(outcome?.decisiveFacts.acceptedReceipt, true, mutation);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});
