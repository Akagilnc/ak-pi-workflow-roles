import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #378 acceptance — Reviewer legs labor via engine detour at real public entry.
 * PATH fake engine + scripted session LLM; mock only LLM I/O.
 * Two material paths: with packaged notes (cursor) / name-only free engine.
 * Zero CLI invocation-text / material-prose assertions; zero production hooks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/role-runtime.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "../../src/public-cli/registry.ts";
import {
  packageRoot,
  piCli,
  runPiSubprocess,
} from "../helpers/pi-test-harness.ts";

const CANNED_LABOR = "canned-reviewer-engine-labor-378";
const providerPath = resolve(
  packageRoot,
  "test/fixtures/reviewer-engine-detour-provider.ts",
);

function seedGitProject(root: string): string {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "reviewer-engine@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Reviewer Engine"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
  execFileSync("git", ["branch", "review-base"], { cwd: root });
  execFileSync("git", ["checkout", "-b", "feature-login"], { cwd: root });
  // Non-empty diff is required for accepted Reviewer dispatch.
  // Local Spec material launches the Spec leg so both axes prove engine labor (#378).
  execFileSync("bash", ["-lc", "printf 'reviewed\n' > consumer.txt"], { cwd: root });
  execFileSync("bash", ["-lc", "mkdir -p docs && printf '%s\n' '# Feature login' 'Must authenticate users.' > docs/feature-login.md"], {
    cwd: root,
  });
  execFileSync("git", ["add", "consumer.txt", "docs/feature-login.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "reviewed change with local spec material"], {
    cwd: root,
  });
  return "review-base";
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

async function runReviewerWithEngine(input: {
  home: string;
  project: string;
  binDir: string;
  runId: string;
  base: string;
  engine: string;
  providerPath?: string;
  modelId?: string;
}): Promise<{
  exitCode: number;
  terminal: Awaited<ReturnType<typeof runAkRole>>["terminal"];
  stdout: string[];
  stderr: string[];
}> {
  const modelId = input.modelId ?? "ak-reviewer-engine-detour/faux-1";
  const extensionPath = input.providerPath ?? providerPath;
  const agentDir = join(input.home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  // #675: cross-process dual-axis completion ledger for nested evidence-child + parent.
  const axisLedgerPath = join(input.home, "review-axis-ledger.txt");
  await writeFile(axisLedgerPath, "", "utf8");
  await writeFile(
    join(agentDir, "navigator-model.json"),
    `${JSON.stringify({ model: modelId })}\n`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv = [
    "reviewer",
    "--engine",
    input.engine,
    "--model",
    modelId,
    "--thinking",
    "off",
    "--project",
    input.project,
    "--base",
    input.base,
  ];
  const result = await runAkRole(argv, {
    packageRoot,
    home: input.home,
    agentDir,
    cwd: input.project,
    createRunId: () => input.runId,
    credentials: { "openai-codex": true, xai: true },
    reviewerExtraPiArgs: ["-e", extensionPath],
    reviewerTimeoutMs: 120_000,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
      assert.ok(
        args.some((arg) => arg.endsWith(INTERNAL_ROLE_ENTRYPOINT_RELATIVE)),
      );
      const subprocess = await runPiSubprocess([...args], {
        cwd: options.cwd,
        env: {
          ...options.env,
          PATH: `${input.binDir}:${dirname(piCli)}:${options.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
          // Nested public summons (#675) reuse the same faux provider extension.
          AK_REVIEW_AXIS_LEDGER: axisLedgerPath,
        },
        timeoutMs: options.timeoutMs ?? 120_000,
      });
      return {
        code: subprocess.code,
        stdout: subprocess.stdout,
        stderr: subprocess.stderr,
        timedOut: subprocess.localTimeout,
        args: [...args],
      };
    },
            extraPiArgs: ["-e", extensionPath],
          }),
  });
  return {
    exitCode: result.exitCode,
    terminal: result.terminal,
    stdout,
    stderr,
  };
}

async function listEvidenceChildRunDirs(home: string): Promise<string[]> {
  const booksRoot = join(home, ".ak-roles", "books");
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith("@evidence-child")) {
          found.push(full);
          continue;
        }
        await walk(full);
      }
    }
  }
  await walk(booksRoot);
  return found.sort();
}

async function assertDetourLaborOnCase(
  home: string,
  project: string,
  runId: string,
): Promise<void> {
  // #675: nested public evidence-child runs are independent public seats; bind
  // assertions to those run directories (role suffix), not the whole books tree.
  const childRuns = await listEvidenceChildRunDirs(home);
  assert.equal(
    childRuns.length,
    2,
    `expected exactly two evidence-child runs under hermetic home, got ${childRuns.length}: ${childRuns.join(",")}`,
  );
  const axes = new Set<string>();
  for (const runDir of childRuns) {
    const invocation = JSON.parse(
      await readFile(join(runDir, "invocation.json"), "utf8"),
    ) as { role?: string; engine?: string };
    assert.equal(invocation.role, "evidence-child");
    assert.equal(invocation.engine, "cursor");
    const sessionFile = join(runDir, "session", "session.jsonl");
    const rows = (await readFile(sessionFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any);
    const detourCalls = rows.flatMap((row) => {
      if (row.type !== "message" || row.message?.role !== "assistant") return [];
      const content = row.message?.content;
      if (!Array.isArray(content)) return [];
      return content.filter(
        (part: any) => part?.type === "toolCall" && part.name === ENGINE_DETOUR_TOOL_NAME,
      );
    });
    assert.equal(detourCalls.length, 1, `expected one detour toolCall in ${runDir}`);
    const argv = detourCalls[0]?.arguments?.argv;
    assert.ok(Array.isArray(argv), `detour argv must be structured array in ${runDir}`);
    const axis = typeof argv[2] === "string" ? argv[2] : "";
    assert.ok(axis === "standards" || axis === "spec", `unexpected detour axis ${axis} in ${runDir}`);
    axes.add(axis);
    const detourResults = rows.filter(
      (row) =>
        row.type === "message" &&
        row.message?.role === "toolResult" &&
        row.message?.toolName === ENGINE_DETOUR_TOOL_NAME,
    );
    assert.equal(detourResults.length, 1, `expected one detour toolResult in ${runDir}`);
    assert.equal(detourResults[0]?.message?.isError, false, `detour must succeed in ${runDir}`);
    // Rejoin is structured on evidence-child output toolCall arguments.report.
    const reports = rows.flatMap((row) => {
      if (row.type !== "message" || row.message?.role !== "assistant") return [];
      const content = row.message?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((part: any) => part?.type === "toolCall" && typeof part.arguments?.report === "string")
        .map((part: any) => part.arguments.report as string);
    });
    assert.equal(reports.length, 1, `expected one evidence-child report toolCall in ${runDir}`);
    assert.ok(reports[0]!.length > 0, `evidence-child report must be non-empty in ${runDir}`);
  }
  assert.deepEqual([...axes].sort(), ["spec", "standards"]);

  const bookKey = resolveBookKeyFromGit(project);
  const invocation = JSON.parse(
    await readFile(
      join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@reviewer`, "invocation.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(typeof invocation.engine, "string");
  assert.notEqual(String(invocation.engine).trim(), "");
}

  // 尺②同根收拢（#420 类一）：AC name-only 与保留的「AC with-notes」是同一条
  // 「--engine → 双轴 leg detour → typed receipt」真入口链的两个引擎名变体；
  // 自由名（无 notes）的 argv/材质形状由 test/unit/engine-material.test.ts
  // （name-only omits read-these-bytes / assertLegalEngineName）与 #391 E4 表
  // （自由名 → childEnv + invocation.engine）承接，删此留彼。


test(
  "engine failure in evidence legs terminates the public Reviewer run with its cause",
  { timeout: 180_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-reviewer-engine-failure-"));
    const engineCause = "reviewer-engine-process-cause-483";
    try {
      const project = join(home, "work");
      const binDir = join(home, "bin");
      await mkdir(project, { recursive: true });
      await mkdir(binDir, { recursive: true });
      const base = seedGitProject(project);
      await writeExecutable(
        join(binDir, "kimi"),
        `#!/bin/sh\nprintf '%s\\n' '${engineCause}' >&2\nexit 23\n`,
      );

      const result = await runReviewerWithEngine({
        home,
        project,
        binDir,
        runId: "run-reviewer-engine-failure-001",
        base,
        engine: "cursor",
      });

      assert.notEqual(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "failure");
      if (result.terminal?.roleOutcome.kind !== "failure") assert.fail("expected typed failure");
      assert.equal(
        result.terminal.roleOutcome.diagnostic.includes(engineCause),
        true,
        result.terminal.roleOutcome.diagnostic,
      );
    } finally {
      // Owner 2026-09-05: leave hermetic home under tmpdir for OS cleanup.
    }
  },
);

test(
  "AC with-notes: cursor engine → leg detour → typed reviewer receipt",
  { timeout: 180_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-reviewer-engine-notes-"));
    try {
      const project = join(home, "work");
      const binDir = join(home, "bin");
      await mkdir(project, { recursive: true });
      await mkdir(binDir, { recursive: true });
      const base = seedGitProject(project);
      // cursor notes exist as packaged material; fake executable still named kimi
      // because the scripted LLM builds argv from the fixture, not from notes body.
      await writeExecutable(
        join(binDir, "kimi"),
        `#!/bin/sh\nprintf '%s' '${CANNED_LABOR}\\n'\n`,
      );

      const result = await runReviewerWithEngine({
        home,
        project,
        binDir,
        runId: "run-reviewer-engine-notes-001",
        base,
        engine: "cursor",
      });

      assert.equal(result.exitCode, 0, result.stderr.join(""));
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      // #675 offline: nested public evidence-child is injected; engine axis on the
      // parent invocation remains the production contract under test.
      const bookKey = resolveBookKeyFromGit(project);
      const invocation = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "runs",
            "run-reviewer-engine-notes-001@reviewer",
            "invocation.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(invocation.engine, "cursor");
      await assertDetourLaborOnCase(
        home,
        project,
        "run-reviewer-engine-notes-001",
      );
    } finally {
      // Owner 2026-09-05: leave hermetic home under tmpdir for OS cleanup.
    }
  },
);
