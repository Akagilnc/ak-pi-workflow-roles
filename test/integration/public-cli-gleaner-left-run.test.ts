/**
 * #502 public Gleaner-Left seat — empty instruction admitted; empty and
 * nonempty 弹章 settle as accepted completed terminals; one-shot (no resume).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "../../src/gleaner-left-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  admitGleanerLeftInvocation,
  parseGleanerLeftArgv,
} from "../../src/public-cli/invocation.ts";
import { buildGleanerLeftTurnRequest } from "../../src/public-cli/gleaner-left-run.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "gleaner-left@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Gleaner Left Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function gleanerLeftSessionRows(toolArgs: unknown) {
  const toolCallId = "call_gleaner_left_1";
  return [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-31T00:00:00.000Z",
      message: { role: "user", content: "kickoff", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-08-31T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: GLEANER_LEFT_OUTPUT_TOOL_NAME,
            arguments: toolArgs,
          },
        ],
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "result-1",
      parentId: "assistant-1",
      timestamp: "2026-08-31T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: GLEANER_LEFT_OUTPUT_TOOL_NAME,
        content: [{ type: "text", text: "Gleaner-left output accepted" }],
        details: toolArgs,
        isError: false,
        timestamp: 3,
      },
    },
  ];
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function scriptedGleanerLeftSession(toolArgs: unknown) {
  return async (extraArgs: readonly string[]) => {
    const sessionFile = flagValue(extraArgs, "--session");
    assert.ok(sessionFile);
    await mkdir(join(sessionFile, ".."), { recursive: true });
    await writeFile(
      sessionFile,
      `${gleanerLeftSessionRows(toolArgs).map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    const lawful =
      typeof toolArgs === "object" &&
      toolArgs !== null &&
      "status" in toolArgs &&
      (toolArgs as { status?: unknown }).status === "completed";
    return {
      code: 0,
      timedOut: false,
      stderr: "",
      args: [...extraArgs],
      ...(lawful
        ? { sealedAcceptance: { role: "gleaner-left" as const, details: toolArgs } }
        : {}),
    };
  };
}

test("gleaner-left admits empty instruction as the lawful path", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const parsed = parseGleanerLeftArgv(["--project", project]);
    assert.equal(parsed.instruction, "");

    const admitted = await admitGleanerLeftInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "",
      attachmentPaths: [],
      createRunId: () => "01a0glean00-0000-7000-8000-000000000001",
    });

    assert.equal(admitted.role, "gleaner-left");
    assert.equal(admitted.instructionEmpty, true);
    assert.equal(admitted.attachments.length, 0);

    const turn = buildGleanerLeftTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "" },
    });
    assert.equal(turn.activation.role, "gleaner-left");
  });
});

test("gleaner-left argv rejects unknown options", async () => {
  assert.throws(
    () => parseGleanerLeftArgv(["--bogus"]),
  );
});

test("empty and nonempty 弹章 settle as accepted completed terminals", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const receipts = [
      { status: "completed" as const, findings: [] },
      {
        status: "completed" as const,
        findings: [
          {
            pointer: "src/packaged-role-registry.ts:22",
            statement: "公开角色表未收编左拾遗",
          },
        ],
      },
    ] as const;

    for (const [index, receipt] of receipts.entries()) {
      const { io } = captureIo();
      const runId = `01a0glean00-0000-7000-8000-${String(index).padStart(12, "0")}`;
      const result = await runAkRole(
        ["gleaner-left", "--project", project],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () => runId,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedGleanerLeftSession(receipt),
          }),
        },
      );
      assert.equal(result.exitCode, 0, `receipt findings ${receipt.findings.length}`);
      assert.ok(result.terminal, `receipt findings ${receipt.findings.length}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.equal(result.terminal.roleOutcome.status, "completed");
      const facts = result.terminal.roleOutcome.decisiveFacts as Record<
        string,
        unknown
      >;
      assert.equal(facts.status, "completed");
      assert.deepEqual(facts.findings, [...receipt.findings]);
      const coords = issuePiDurablePrincipalCoordinates({
        cwd: project,
        runId,
        role: "gleaner-left",
        home,
      });
      const state = await readRoleRunState(
        coords.runDirectory,
        piDurablePrincipalAuthority,
      );
      assert.equal(state?.role, "gleaner-left");
      assert.equal(state?.state, "terminal");
    }
  });
});

test("gleaner-left runs are one-shot — resume is refused", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-0000000000aa";
    const result = await runAkRole(
      ["gleaner-left", "--project", project],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedGleanerLeftSession({
            status: "completed",
            findings: [],
          }),
        }),
      },
    );
    assert.equal(result.exitCode, 0);

    const { io: resumeIo } = captureIo();
    const refused = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
    });
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.terminal, undefined);
  });
});
