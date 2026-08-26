/**
 * #357 T2 acceptance — four tracers at real public Judge entry.
 * PATH fake engine + scripted session LLM; mock only LLM I/O.
 * Zero CLI invocation-text / material-prose assertions; zero production hooks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "engine-detour@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Engine Detour"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

const providerPath = resolve(
  packageRoot,
  "test/fixtures/engine-detour-provider.ts",
);

const CANNED_VERDICT_TEXT = "canned-engine-labor-content-357\n";

async function runJudgeWithEngine(input: {
  home: string;
  project: string;
  binDir: string;
  runId: string;
  engine?: string;
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
    `${JSON.stringify({ model: "ak-engine-detour/faux-1" })}\n`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv = [
    "judge",
    "--model",
    "ak-engine-detour/faux-1",
    "--thinking",
    "off",
    "--project",
    input.project,
    "Engine detour acceptance tracer.",
  ];
  if (input.engine !== undefined) {
    argv.splice(1, 0, "--engine", input.engine);
  }
  const result = await runAkRole(argv, {
    packageRoot,
    home: input.home,
    agentDir,
    cwd: input.project,
    createRunId: () => input.runId,
    credentials: { "openai-codex": true, xai: true },
    judgeExtraPiArgs: ["-e", providerPath],
    judgeTimeoutMs: 90_000,
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
        },
        timeoutMs: options.timeoutMs ?? 90_000,
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

test(
  "AC1 success: PATH fake engine → detour → typed judge receipt",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-engine-detour-ok-"));
    try {
      const project = join(home, "work");
      const binDir = join(home, "bin");
      await mkdir(project, { recursive: true });
      await mkdir(binDir, { recursive: true });
      seedGitProject(project);
      await writeExecutable(
        join(binDir, "kimi"),
        `#!/bin/sh\nprintf '%s' '${CANNED_VERDICT_TEXT}'\n`,
      );

      const result = await runJudgeWithEngine({
        home,
        project,
        binDir,
        runId: "run-engine-detour-ok-001",
        engine: "kimi",
      });

      assert.equal(result.exitCode, 0, result.stderr.join(""));
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      const reportRef = result.terminal?.artifacts.find((a) => a.kind === "report");
      assert.ok(reportRef, "accepted Terminal must expose report artifact");
      const report = await readFile(reportRef!.path, "utf8");
      assert.ok(report.length > 0);

      // Session principal: detour ran once and typed output accepted.
      const bookKey = resolveBookKeyFromGit(project);
      const sessionFile = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-engine-detour-ok-001@judge",
        "session",
        "session.jsonl",
      );
      const rows = (await readFile(sessionFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any);
      const detourResults = rows.filter(
        (row) =>
          row.type === "message" &&
          row.message?.role === "toolResult" &&
          row.message?.toolName === ENGINE_DETOUR_TOOL_NAME,
      );
      assert.equal(detourResults.length, 1, "exactly one detour toolResult");
      assert.notEqual(detourResults[0].message.isError, true);
      const detourText = Array.isArray(detourResults[0].message.content)
        ? detourResults[0].message.content
            .map((p: any) => (p.type === "text" ? p.text : ""))
            .join("")
        : String(detourResults[0].message.content ?? "");
      assert.equal(detourText.includes("canned-engine-labor-content-357"), true);
      const judgeAccepted = rows.some(
        (row) =>
          row.type === "message" &&
          row.message?.role === "toolResult" &&
          row.message?.toolName === "ak_judge_output" &&
          row.message?.isError !== true &&
          row.message?.details?.judgeStatus === "converged",
      );
      assert.equal(judgeAccepted, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "engine process failures stop at the public entry without a Receipt",
  { timeout: 120_000 },
  async () => {
    for (const row of [
      { label: "empty-output", body: "#!/bin/sh\nprintf '  \\n\\t  '\nexit 0\n" },
      { label: "nonzero-exit", body: "#!/bin/sh\nprintf 'partial output'\nprintf 'engine cause' >&2\nexit 23\n" },
    ]) {
      const home = await mkdtemp(join(tmpdir(), `ak-engine-detour-${row.label}-`));
      try {
        const project = join(home, "work");
        const binDir = join(home, "bin");
        await mkdir(project, { recursive: true });
        await mkdir(binDir, { recursive: true });
        seedGitProject(project);
        await writeExecutable(join(binDir, "kimi"), row.body);

        const result = await runJudgeWithEngine({
          home,
          project,
          binDir,
          runId: `run-engine-detour-${row.label}-001`,
          engine: "kimi",
        });

        assert.equal(result.exitCode, 1, row.label);
        assert.equal(result.terminal?.roleOutcome.kind, "failure", row.label);
        if (result.terminal?.roleOutcome.kind !== "failure") assert.fail(row.label);
        assert.equal(result.terminal.roleOutcome.cause, "output", row.label);
        assert.equal(result.terminal.roleOutcome.diagnostic.trim().length > 0, true, row.label);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  },
);


test(
  "AC4 governance: no engine → no detour tool; default typed path still accepts",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-engine-detour-gov-"));
    try {
      const project = join(home, "work");
      const binDir = join(home, "bin");
      await mkdir(project, { recursive: true });
      await mkdir(binDir, { recursive: true });
      seedGitProject(project);
      // Fake engine on PATH must not matter when engine axis is off.
      await writeExecutable(
        join(binDir, "kimi"),
        "#!/bin/sh\necho should-not-run >&2\nexit 99\n",
      );

      const result = await runJudgeWithEngine({
        home,
        project,
        binDir,
        runId: "run-engine-detour-gov-001",
        // no engine
      });

      assert.equal(result.exitCode, 0, result.stderr.join(""));
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");

      const bookKey = resolveBookKeyFromGit(project);
      const sessionFile = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-engine-detour-gov-001@judge",
        "session",
        "session.jsonl",
      );
      const rows = (await readFile(sessionFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any);
      const detourTouch = rows.some(
        (row) =>
          (row.type === "message" &&
            row.message?.toolName === ENGINE_DETOUR_TOOL_NAME) ||
          (row.type === "message" &&
            Array.isArray(row.message?.content) &&
            row.message.content.some(
              (p: any) =>
                p.type === "toolCall" && p.name === ENGINE_DETOUR_TOOL_NAME,
            )),
      );
      assert.equal(detourTouch, false, "detour tool must not appear without engine");
      const judgeAccepted = rows.some(
        (row) =>
          row.type === "message" &&
          row.message?.role === "toolResult" &&
          row.message?.toolName === "ak_judge_output" &&
          row.message?.isError !== true &&
          row.message?.details?.judgeStatus === "converged",
      );
      assert.equal(judgeAccepted, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
