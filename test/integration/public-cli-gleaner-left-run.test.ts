/**
 * #502 public Gleaner-Left seat — required --base, empty instruction admitted,
 * one-shot (no resume). Does not fake a session for the terminal path.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  admitGleanerLeftInvocation,
  parseGleanerLeftArgv,
} from "../../src/public-cli/invocation.ts";
import { buildGleanerLeftTurnRequest } from "../../src/public-cli/gleaner-left-run.ts";
import { markRunAdmitted } from "../../src/public-cli/run-lifecycle.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-gleaner-left-"));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await scenario(home);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "gleaner-left@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Gleaner Left Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

test("gleaner-left requires --base and admits empty instruction", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    assert.throws(() => parseGleanerLeftArgv([]), (error: unknown) => {
      return error instanceof CliUsageError;
    });
    assert.throws(() => parseGleanerLeftArgv(["--bogus"]), (error: unknown) => {
      return error instanceof CliUsageError;
    });

    const parsed = parseGleanerLeftArgv(["--project", project, "--base", "HEAD"]);
    assert.equal(parsed.instruction, "");
    assert.equal(parsed.baseRevision, "HEAD");

    const admitted = await admitGleanerLeftInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "",
      attachmentPaths: [],
      baseRevision: parsed.baseRevision,
      createRunId: () => "01a0glean00-0000-7000-8000-000000000001",
    });

    assert.equal(admitted.role, "gleaner-left");
    assert.equal(admitted.instructionEmpty, true);
    assert.equal(admitted.baseRevision, "HEAD");
    assert.equal(admitted.attachments.length, 0);

    const turn = buildGleanerLeftTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "" },
    });
    assert.equal(turn.activation.role, "gleaner-left");
    assert.ok(turn.activation.role === "gleaner-left");
    assert.equal(turn.activation.baseRevision, "HEAD");
  });
});

test("gleaner-left runs are one-shot — resume is refused", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-0000000000aa";
    const admitted = await admitGleanerLeftInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "",
      attachmentPaths: [],
      baseRevision: "HEAD",
      createRunId: () => runId,
    });
    await markRunAdmitted(admitted, piDurablePrincipalAuthority);

    const { io } = captureIo();
    const refused = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      io,
    });
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.terminal, undefined);
  });
});
