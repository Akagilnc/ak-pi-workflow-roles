/**
 * #448 public Notary seat — source-run locator only; four external terminal layers
 * via real runAkRole entry; default judge path adds no intake notary call.
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
import {
  NotarySourceRunError,
  resolveNotarySourceRunLocator,
} from "../../src/notary-source-run.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitNotaryInvocation,
  parseNotaryArgv,
} from "../../src/public-cli/invocation.ts";
import { buildNotaryActivationExtraArgs } from "../../src/public-cli/notary-run.ts";
import { isLawfulTypedTerminalOutcome } from "../../src/public-cli/terminal.ts";
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

async function seedSourceRun(project: string): Promise<string> {
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

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function scriptedNotarySession(
  toolArgs: unknown,
  options: { isError?: boolean } = {},
) {
  return async (extraArgs: readonly string[]) => {
    const sessionFile = flagValue(extraArgs, "--session");
    assert.ok(sessionFile);
    await mkdir(join(sessionFile, ".."), { recursive: true });
    await writeFile(
      sessionFile,
      `${sessionRows(toolArgs, options).map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    return {
      code: 0,
      timedOut: false,
      stderr: "",
      args: [...extraArgs],
    };
  };
}

test("notary argv rejects caller prompt and attachment projection", async () => {
  assert.throws(
    () => parseNotaryArgv(["--source-run", "x@judge", "please bounce lightly"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseNotaryArgv(["--attach", "./note.md", "--source-run", "x@judge"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseNotaryArgv([]),
    (error: unknown) => error instanceof CliUsageError,
  );

  // Public CLI structural exit for the same input contract.
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(project);
    const { io } = captureIo();
    const withPrompt = await runAkRole(
      ["notary", "--source-run", sourceRunPath, "caller framing must not admit"],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(withPrompt.exitCode, 2);
    assert.equal(withPrompt.terminal, undefined);

    const withAttach = await runAkRole(
      ["notary", "--attach", "./note.md", "--source-run", sourceRunPath],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(withAttach.exitCode, 2);
    assert.equal(withAttach.terminal, undefined);
  });
});

test("notary activation binds locator only — zero instruction/attachment on admitted request", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(project);

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

    const extra = buildNotaryActivationExtraArgs(admitted, { packageRoot });
    assert.equal(flagValue(extra, "--ak-role"), "notary");
    assert.equal(flagValue(extra, "--ak-notary-source-run"), sourceRunPath);
  });
});

test("notary bad source-run locator is structural reject (exit 2)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();

    const missing = await runAkRole(
      ["notary", "--source-run", join(project, "no-such-run@judge")],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.terminal, undefined);

    const filePath = join(project, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
    await writeFile(filePath, "not a directory\n", "utf8");
    const notDir = await runAkRole(
      ["notary", "--source-run", filePath],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(notDir.exitCode, 2);
    assert.equal(notDir.terminal, undefined);

    const badNameDir = join(project, "not-a-run-id");
    await mkdir(badNameDir, { recursive: true });
    const badName = await runAkRole(
      ["notary", "--source-run", badNameDir],
      { home, packageRoot, cwd: project, io },
    );
    assert.equal(badName.exitCode, 2);
    assert.equal(badName.terminal, undefined);

    // Unit seam: same failures surface as NotarySourceRunError before CLI wrap.
    await assert.rejects(
      () =>
        resolveNotarySourceRunLocator({
          projectRoot: project,
          sourceRun: join(project, "missing@judge"),
          home,
        }),
      (error: unknown) => error instanceof NotarySourceRunError,
    );
  });
});

test("layer ① accepted pass/bounce/incomplete-with-reason exit 0 via public entry", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(project);

    const receipts = [
      { status: "pass", findings: [] as string[] },
      {
        status: "bounce",
        findings: ["quote has no source"],
        disposition: "rewrite",
      },
      { status: "incomplete", reason: "source run missing draft" },
    ] as const;

    for (const [index, receipt] of receipts.entries()) {
      const { io } = captureIo();
      const result = await runAkRole(
        ["notary", "--source-run", sourceRunPath],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () =>
            `01a0notary-0000-7000-8000-${String(index).padStart(12, "0")}`,
          piRunner: scriptedNotarySession(receipt),
        },
      );
      assert.equal(result.exitCode, 0, `receipt ${receipt.status}`);
      assert.ok(result.terminal, `receipt ${receipt.status}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.equal(result.terminal.roleOutcome.role, "notary");
      assert.equal(
        result.terminal.roleOutcome.status,
        receipt.status,
        `receipt ${receipt.status}`,
      );
      assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), true);
    }
  });
});

test("layer ② residual incomplete keeps candidate and exits non-zero via public entry", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(project);
    const bad = { status: "maybe", note: "not an explicit release" };
    const { io } = captureIo();

    const result = await runAkRole(
      ["notary", "--source-run", sourceRunPath],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0notary-0000-7000-8000-000000000002",
        piRunner: scriptedNotarySession(bad, { isError: true }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "incomplete");
    if (result.terminal.roleOutcome.kind === "incomplete") {
      assert.equal(result.terminal.roleOutcome.role, "notary");
      assert.equal(result.terminal.roleOutcome.acceptedReceipt, false);
      assert.deepEqual(result.terminal.roleOutcome.candidate, bad);
    }
    assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), false);
  });
});

test("layer ③ no_receipt from shared lifecycle is lawful exit 0", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(project);
    const { io } = captureIo();

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
      assert.equal(
        result.terminal.roleOutcome.sessionCompletion,
        "settled-without-accepted-receipt",
      );
    }
    assert.equal(isLawfulTypedTerminalOutcome(result.terminal.roleOutcome), true);
  });
});

test("layer ④ transport/provider failure is controlled non-zero failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedSourceRun(project);
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
          void options;
          return {
            code: 1,
            timedOut: false,
            stderr: "stop after intake",
            args: [...args],
          };
        },
      },
    );

    assert.ok(dispatchedArgs, "judge public path must dispatch once");
    assert.equal(flagValue(dispatchedArgs, "--ak-role"), "judge");
    assert.equal(dispatchedArgs.includes("--ak-notary-source-run"), false);

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
