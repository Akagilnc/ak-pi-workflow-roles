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
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function collectJsonlRows(root: string): Promise<any[]> {
  const rows: any[] = [];
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
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const text = await readFile(full, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // ignore non-JSON noise
        }
      }
    }
  }
  await walk(root);
  return rows;
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
          AK_ROLE_NESTED_EXTRA_PI_ARGS: JSON.stringify(["-e", extensionPath]),
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

async function assertDetourLaborOnCase(
  home: string,
  project: string,
  runId: string,
): Promise<void> {
  // #675: evidence-child public runs book under the leg worktree's book key
  // (resolveBookKeyFromGit of the prepared workspace), not the parent project key.
  // Scan the whole hermetic home books tree for detour toolResults.
  const runRoot = join(home, ".ak-roles", "books");
  const rows = await collectJsonlRows(runRoot);
  void project;
  void runId;
  const detourResults = rows.filter(
    (row) =>
      row.type === "message" &&
      row.message?.role === "toolResult" &&
      row.message?.toolName === ENGINE_DETOUR_TOOL_NAME &&
      row.message?.isError !== true,
  );
  // Both launched legs must each complete one successful engine detour (#378).
  assert.ok(
    detourResults.length >= 2,
    `expected standards+spec engine detour toolResults under ${runRoot}, got ${detourResults.length}`,
  );
  const detourByAxis = new Set<string>();
  for (const row of rows) {
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "toolCall" || part.name !== ENGINE_DETOUR_TOOL_NAME) continue;
      const id = typeof part.id === "string" ? part.id : "";
      if (id === "engine-detour-standards") detourByAxis.add("standards");
      if (id === "engine-detour-spec") detourByAxis.add("spec");
    }
  }
  assert.deepEqual(
    [...detourByAxis].sort(),
    ["spec", "standards"],
    `expected per-axis engine detour calls, got ${[...detourByAxis].join(",") || "none"}`,
  );
  const detourText = detourResults
    .map((row) => {
      const content = row.message?.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return String(content ?? "");
      return content
        .map((part: any) => (part.type === "text" ? part.text : ""))
        .join("");
    })
    .join("\n");
  assert.equal(
    detourText.includes(CANNED_LABOR),
    true,
    `detour stdout missing canned labor: ${detourText}`,
  );
  // Labor must rejoin the axis reports (detour-rejoins-main-road).
  // #675: evidence-child terminates via ak_evidence_child_output toolCall — report
  // bytes live in toolCall arguments / submission-closure details, not plain assistant text.
  const axisReportChunks: string[] = [];
  for (const row of rows) {
    if (row.type === "custom" && row.customType === "ak-role-submission-closure") {
      const report = row.data?.details?.report;
      if (typeof report === "string") axisReportChunks.push(report);
      continue;
    }
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "toolCall") continue;
      const report = part.arguments?.report;
      if (typeof report === "string") axisReportChunks.push(report);
    }
  }
  const axisReports = axisReportChunks.join("\n");
  assert.equal(
    axisReports.includes(CANNED_LABOR),
    true,
    `axis reports missing rejoined engine labor: ${axisReports}`,
  );

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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
    }
  },
);
