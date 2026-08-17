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
  execFileSync("bash", ["-lc", "printf 'reviewed\n' > consumer.txt"], { cwd: root });
  execFileSync("git", ["add", "consumer.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "reviewed change"], { cwd: root });
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
}): Promise<{
  exitCode: number;
  terminal: Awaited<ReturnType<typeof runAkRole>>["terminal"];
  stdout: string[];
  stderr: string[];
}> {
  const agentDir = join(input.home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "navigator-model.json"),
    `${JSON.stringify({ model: "ak-reviewer-engine-detour/faux-1" })}\n`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv = [
    "reviewer",
    "--engine",
    input.engine,
    "--model",
    "ak-reviewer-engine-detour/faux-1",
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
    reviewerExtraPiArgs: ["-e", providerPath],
    reviewerTimeoutMs: 120_000,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
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
          // Standards-only keeps the fixture deterministic under one-axis labor.
          AK_REVIEW_EXPECT_AXES: "standards",
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
  const bookKey = resolveBookKeyFromGit(project);
  const runRoot = join(
    home,
    ".ak-roles",
    "books",
    bookKey,
    "runs",
    `${runId}@reviewer`,
  );
  const rows = await collectJsonlRows(runRoot);
  const detourResults = rows.filter(
    (row) =>
      row.type === "message" &&
      row.message?.role === "toolResult" &&
      row.message?.toolName === ENGINE_DETOUR_TOOL_NAME,
  );
  assert.ok(
    detourResults.length >= 1,
    `expected at least one engine detour toolResult under ${runRoot}`,
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

  const invocation = JSON.parse(
    await readFile(join(runRoot, "invocation.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(typeof invocation.engine, "string");
  assert.notEqual(String(invocation.engine).trim(), "");
}

test(
  "AC name-only: free engine name → leg detour → typed reviewer receipt",
  { timeout: 180_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-reviewer-engine-name-"));
    try {
      const project = join(home, "work");
      const binDir = join(home, "bin");
      await mkdir(project, { recursive: true });
      await mkdir(binDir, { recursive: true });
      const base = seedGitProject(project);
      await writeExecutable(
        join(binDir, "kimi"),
        `#!/bin/sh\nprintf '%s' '${CANNED_LABOR}\\n'\n`,
      );

      const result = await runReviewerWithEngine({
        home,
        project,
        binDir,
        runId: "run-reviewer-engine-name-001",
        base,
        engine: "nope-engine",
      });

      assert.equal(result.exitCode, 0, result.stderr.join(""));
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      await assertDetourLaborOnCase(
        home,
        project,
        "run-reviewer-engine-name-001",
      );
      const bookKey = resolveBookKeyFromGit(project);
      const invocation = JSON.parse(
        await readFile(
          join(
            home,
            ".ak-roles",
            "books",
            bookKey,
            "runs",
            "run-reviewer-engine-name-001@reviewer",
            "invocation.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(invocation.engine, "nope-engine");
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
      await assertDetourLaborOnCase(
        home,
        project,
        "run-reviewer-engine-notes-001",
      );
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
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
