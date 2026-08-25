/**
 * #448 public Notary seat — source-run locator only; four external terminal layers;
 * zero caller prompt/attachment framing; default judge path adds no intake notary call.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitNotaryInvocation,
  parseNotaryArgv,
} from "../../src/public-cli/invocation.ts";
import {
  buildNotaryActivationExtraArgs,
} from "../../src/public-cli/notary-run.ts";
import {
  extractNotaryRoleOutcome,
  trySettleNotaryTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  exitCodeForTerminalOutcome,
  isLawfulTypedTerminalOutcome,
} from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-notary-"));
  try {
    return await scenario(home);
  } finally {
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
  execFileSync("git", ["config", "user.email", "notary@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Notary Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function sessionRows(toolArgs: unknown, options: { isError?: boolean } = {}) {
  const toolCallId = "call_notary_1";
  return [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-25T00:00:00.000Z",
      message: { role: "user", content: "kickoff", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-08-25T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: NOTARY_OUTPUT_TOOL_NAME,
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
      timestamp: "2026-08-25T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        content: [{ type: "text", text: "Notary output accepted" }],
        details: toolArgs,
        isError: options.isError === true,
        timestamp: 3,
      },
    },
  ];
}

async function seedSourceRun(home: string, project: string): Promise<string> {
  const book = join(home, ".ak-roles", "books", "ak-public-cli-notary-project");
  // book key comes from git common dir basename — seed under resolved book after first admit
  // Use absolute path form for locator to avoid book-key coupling in unit tests.
  const runId = "01a034f1-75bf-71a6-bcf5-d1299145b1a5";
  const sourceDir = join(project, ".source-runs", `${runId}@judge`);
  await mkdir(join(sourceDir, "session"), { recursive: true });
  await writeFile(
    join(sourceDir, "session", "session.jsonl"),
    `${JSON.stringify({ type: "message", message: { role: "user", content: "draft" } })}\n`,
    "utf8",
  );
  return await realpath(sourceDir);
}

test("notary argv rejects caller prompt and attachment projection", () => {
  assert.throws(
    () => parseNotaryArgv(["--source-run", "x@judge", "please bounce lightly"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /rejects caller prompt|instruction/i.test(error.message),
  );
  assert.throws(
    () => parseNotaryArgv(["--attach", "./note.md", "--source-run", "x@judge"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseNotaryArgv([]),
    (error: unknown) => error instanceof CliUsageError,
  );
});

test("notary activation binds locator only — zero instruction/attachment on admitted request", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(home, project);

    const admitted = await admitNotaryInvocation({
      home,
      cwd: project,
      sourceRun: sourceRunPath,
      createRunId: () => "01a0notary-0000-7000-8000-000000000001",
    });

    assert.equal(admitted.role, "notary");
    assert.equal(admitted.instruction, "");
    assert.equal(admitted.instructionEmpty, true);
    assert.deepEqual(admitted.attachments, []);
    assert.equal(admitted.sourceRunPath, sourceRunPath);
    assert.equal(admitted.sourceRun.runId, "01a034f1-75bf-71a6-bcf5-d1299145b1a5");
    assert.equal(admitted.sourceRun.role, "judge");

    const extra = buildNotaryActivationExtraArgs(admitted, {
      packageRoot,
    });
    assert.equal(extra.includes("--ak-role"), true);
    assert.equal(extra[extra.indexOf("--ak-role") + 1], "notary");
    assert.equal(extra.includes("--ak-notary-source-run"), true);
    assert.equal(
      extra[extra.indexOf("--ak-notary-source-run") + 1],
      sourceRunPath,
    );
    // Transport prompt is package-owned fixed kickoff — no caller framing bytes.
    const prompt = extra[extra.length - 1]!;
    assert.match(prompt, /Notary review/);
    assert.equal(prompt.includes("please bounce"), false);
  });
});

test("layer ① accepted pass/bounce/incomplete-with-reason are lawful typed terminals (exit 0)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(home, project);

    for (const receipt of [
      { status: "pass", findings: [] as string[] },
      { status: "bounce", findings: ["quote has no source"], disposition: "rewrite" },
      { status: "incomplete", reason: "source run missing draft" },
    ] as const) {
      const admitted = await admitNotaryInvocation({
        home,
        cwd: project,
        sourceRun: sourceRunPath,
        createRunId: () => `01a0notary-0000-7000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`,
      });
      const lines = sessionRows(receipt)
        .map((row) => JSON.stringify(row))
        .join("\n");
      await writeFile(admitted.sessionFile, `${lines}\n`, "utf8");
      const terminal = await trySettleNotaryTerminalResult(admitted);
      assert.ok(terminal);
      assert.equal(terminal.roleOutcome.kind, "accepted");
      assert.equal(terminal.roleOutcome.role, "notary");
      assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), true);
      assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 0);
    }
  });
});

test("layer ② residual incomplete keeps candidate and exits non-zero", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(home, project);
    const admitted = await admitNotaryInvocation({
      home,
      cwd: project,
      sourceRun: sourceRunPath,
      createRunId: () => "01a0notary-0000-7000-8000-000000000002",
    });
    const bad = { status: "maybe", note: "not an explicit release" };
    const lines = sessionRows(bad, { isError: true })
      .map((row) => JSON.stringify(row))
      .join("\n");
    await writeFile(admitted.sessionFile, `${lines}\n`, "utf8");
    const terminal = await trySettleNotaryTerminalResult(admitted);
    assert.ok(terminal);
    assert.equal(terminal.roleOutcome.kind, "incomplete");
    if (terminal.roleOutcome.kind === "incomplete") {
      assert.equal(terminal.roleOutcome.role, "notary");
      assert.equal(terminal.roleOutcome.acceptedReceipt, false);
      assert.deepEqual(terminal.roleOutcome.candidate, bad);
    }
    assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
    assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);
  });
});

test("layer ③ no_receipt from shared lifecycle is lawful exit 0", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(home, project);
    const { io } = captureIo();

    // Scripted runner: no accepted Notary receipt + shared lifecycle no_receipt fact.
    // Public path classifies cause=output then settleFailureTerminalResult projects layer ③.
    const result = await runAkRole(
      ["notary", "--source-run", sourceRunPath],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-000000000003",
        notaryTimeoutMs: 5_000,
        piRunner: async (extraArgs, options) => {
          const sessionFile = flagValue(extraArgs, "--session");
          assert.ok(sessionFile);
          await mkdir(join(sessionFile, ".."), { recursive: true });
          const runDir = options.env.AK_ROLE_RUN_DIR;
          assert.ok(typeof runDir === "string");
          const noReceipt = {
            type: "custom",
            customType: "ak-no-receipt-lifecycle",
            data: {
              terminalToolCalled: false,
              rejectedReceipts: [],
              deliveryTurns: 2,
              sessionCompletion: "settled-without-accepted-receipt",
              acceptedReceipt: false,
              runPointer: runDir,
              attemptPointer: `current:${runDir}`,
            },
            timestamp: "2026-08-25T00:00:03.000Z",
          };
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              id: "u",
              message: { role: "user", content: "k", timestamp: 1 },
              timestamp: "2026-08-25T00:00:00.000Z",
            })}\n${JSON.stringify(noReceipt)}\n`,
            "utf8",
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...extraArgs],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "no_receipt");
    if (result.terminal.roleOutcome.kind === "no_receipt") {
      assert.equal(result.terminal.roleOutcome.role, "notary");
      assert.equal(result.terminal.roleOutcome.acceptedReceipt, false);
      assert.equal(result.terminal.roleOutcome.sessionCompletion, "settled-without-accepted-receipt");
    }
    assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), true);
  });
});

test("layer ④ transport/provider failure is controlled non-zero failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(home, project);
    const { io } = captureIo();
    const result = await runAkRole(
      ["notary", "--source-run", sourceRunPath],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-000000000004",
        notaryTimeoutMs: 5_000,
        piRunner: async (args) => {
          void args;
          throw new Error("provider disconnected");
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "failure");
    if (result.terminal.roleOutcome.kind === "failure") {
      assert.equal(result.terminal.roleOutcome.role, "notary");
    }
  });
});

test("default judge public path admits no notary seat intake (observable run)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    let dispatchedArgs: readonly string[] | undefined;
    const judgeRunId = "01a0judge0-0000-7000-8000-000000000099";

    await runAkRole(
      ["judge", "--project", project, "ticket court intake probe"],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => judgeRunId,
        piRunner: async (args, options) => {
          dispatchedArgs = args;
          const sessionFile = flagValue(args, "--session");
          assert.ok(sessionFile);
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(sessionFile, "", "utf8");
          // Stop before any role receipt; intake observation only.
          void options;
          return { code: 1, timedOut: false, stderr: "stop after intake", args: [...args] };
        },
      },
    );

    assert.ok(dispatchedArgs, "judge public path must dispatch once");
    assert.equal(flagValue(dispatchedArgs, "--ak-role"), "judge");
    assert.equal(dispatchedArgs.includes("--ak-notary-source-run"), false);
    assert.equal(flagValue(dispatchedArgs, "--ak-role") === "notary", false);

    // No notary run directory is created as a side effect of judge intake.
    const books = join(home, ".ak-roles", "books");
    const notaryRuns: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith("@notary")) notaryRuns.push(path);
          await walk(path);
        }
      }
    }
    await walk(books);
    assert.deepEqual(notaryRuns, []);
  });
});

test("extractNotaryRoleOutcome projects officer status onto accepted terminal facts", () => {
  const rows = sessionRows({ status: "pass", findings: ["ok"] });
  const extracted = extractNotaryRoleOutcome(rows as never);
  assert.ok(extracted);
  assert.equal(extracted.outcome.status, "pass");
  assert.equal(extracted.outcome.decisiveFacts.officer, "notary");
});

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}
