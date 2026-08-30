/**
 * #572 / ADR 0074 public Countersign seat — ticket materials in, 署/封驳 verdict
 * out via real runAkRole entry; one-shot (no resume).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitCountersignInvocation,
  parseCountersignArgv,
} from "../../src/public-cli/invocation.ts";
import { buildCountersignTurnRequest } from "../../src/public-cli/countersign-run.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-countersign-"));
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
  execFileSync("git", ["config", "user.email", "countersign@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Countersign Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function countersignSessionRows(toolArgs: unknown) {
  const toolCallId = "call_countersign_1";
  return [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-30T00:00:00.000Z",
      message: { role: "user", content: "kickoff", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-08-30T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: COUNTERSIGN_OUTPUT_TOOL_NAME,
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
      timestamp: "2026-08-30T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        content: [{ type: "text", text: "Countersign output accepted" }],
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

function scriptedCountersignSession(toolArgs: unknown) {
  return async (extraArgs: readonly string[]) => {
    const sessionFile = flagValue(extraArgs, "--session");
    assert.ok(sessionFile);
    await mkdir(join(sessionFile, ".."), { recursive: true });
    await writeFile(
      sessionFile,
      `${countersignSessionRows(toolArgs).map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    const lawful =
      typeof toolArgs === "object" &&
      toolArgs !== null &&
      "countersignStatus" in toolArgs &&
      ["converged", "continue", "escalate"].includes(
        String((toolArgs as { countersignStatus?: unknown }).countersignStatus),
      );
    return {
      code: 0,
      timedOut: false,
      stderr: "",
      args: [...extraArgs],
      ...(lawful
        ? { sealedAcceptance: { role: "countersign" as const, details: toolArgs } }
        : {}),
    };
  };
}

test("countersign admission freezes attachments and binds the countersign role", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticket = join(project, "ticket.md");
    await writeFile(ticket, "# 票面\n五问裁决。", "utf8");

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁：本票是否足以开工。",
      attachmentPaths: [ticket],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000001",
    });

    assert.equal(admitted.role, "countersign");
    assert.equal(admitted.instructionEmpty, false);
    assert.equal(admitted.attachments.length, 1);
    assert.ok(admitted.attachments[0]?.frozenPath);

    const turn = buildCountersignTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁：本票是否足以开工。" },
    });
    assert.equal(turn.activation.role, "countersign");
  });
});

test("countersign argv rejects unknown options", async () => {
  assert.throws(
    () => parseCountersignArgv(["--bogus", "裁"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const rejected = await runAkRole(
      ["countersign", "--bogus", "裁"],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(rejected.exitCode, 2);
    assert.equal(rejected.terminal, undefined);
  });
});

test("countersign 署 (converged) and 封驳 (continue) settle as accepted terminals", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const receipts = [
      { countersignStatus: "converged" as const, note: "署" },
      {
        countersignStatus: "continue" as const,
        fix: { summary: "票面授权无可溯真源" },
      },
      {
        countersignStatus: "escalate" as const,
        decisionGate: { question: "本票走哪条路？", options: ["a", "b"] },
      },
    ] as const;

    for (const [index, receipt] of receipts.entries()) {
      const { io } = captureIo();
      const runId = `01a0sign00-0000-7000-8000-${String(index).padStart(12, "0")}`;
      const result = await runAkRole(
        ["countersign", "--project", project, "裁：本票五问。"],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () => runId,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedCountersignSession(receipt),
          }),
        },
      );
      assert.equal(result.exitCode, 0, `receipt ${receipt.countersignStatus}`);
      assert.ok(result.terminal, `receipt ${receipt.countersignStatus}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.equal(
        result.terminal.roleOutcome.status,
        receipt.countersignStatus,
      );
      const facts = result.terminal.roleOutcome.decisiveFacts as Record<
        string,
        unknown
      >;
      assert.equal(facts.countersignStatus, receipt.countersignStatus);
      if (receipt.countersignStatus === "continue") {
        assert.equal(facts.fixSummary, receipt.fix.summary);
      }
      if (receipt.countersignStatus === "escalate") {
        assert.equal(facts.decisionQuestion, receipt.decisionGate.question);
        assert.deepEqual(facts.decisionOptions, [...receipt.decisionGate.options]);
      }
      if (receipt.countersignStatus === "converged") {
        assert.equal(facts.note, receipt.note);
      }
      const coords = issuePiDurablePrincipalCoordinates({
        cwd: project,
        runId,
        role: "countersign",
        home,
      });
      const state = await readRoleRunState(
        coords.runDirectory,
        piDurablePrincipalAuthority,
      );
      assert.equal(state?.role, "countersign");
      assert.equal(state?.state, "terminal");
    }
  });
});

test("countersign runs are one-shot — resume is refused", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000aa";
    const result = await runAkRole(
      ["countersign", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedCountersignSession({
            countersignStatus: "converged",
            findings: [],
          }),
        }),
      },
    );
    assert.equal(result.exitCode, 0);

    const { io: resumeIo } = captureIo();
    const refused = await runAkRole(["resume", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
    });
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.terminal, undefined);
  });
});
