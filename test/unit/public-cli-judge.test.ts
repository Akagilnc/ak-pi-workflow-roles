/**
 * #106 public Judge path — admission, freeze, terminal settlement, grace, renderer.
 * Seams: parseJudgeArgv / admitJudgeInvocation / TerminalResult / raceNavigatorGrace /
 * renderPublicAkRoleCommand / runAkRole(judge) with injectable Pi runner.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { renderPublicAkRoleCommand } from "../../src/public-cli/command-renderer.ts";
import {
  admitJudgeInvocation,
  buildJudgeTransportPrompt,
  EMPTY_INVOCATION_TRANSPORT_ENVELOPE,
  parseJudgeArgv,
} from "../../src/public-cli/invocation.ts";
import {
  extractJudgeRoleOutcome,
  extractNavigatorFact,
  NAVIGATOR_POST_ROLE_GRACE_MS,
  raceNavigatorGrace,
} from "../../src/public-cli/settlement.ts";
import {
  formatTerminalResult,
  parseTerminalResultRegions,
  recommendationNavigatorFact,
} from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-judge-"));
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
  execFileSync("git", ["config", "user.email", "judge@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Judge Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test("parseJudgeArgv rejects public burden selectors and unknown flags", () => {
  assert.throws(
    () => parseJudgeArgv(["--burden", "heavy"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /does not accept a public burden selector/.test(error.message),
  );
  assert.throws(
    () => parseJudgeArgv(["--ak-judge-burden=light"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseJudgeArgv(["--judge-burden", "x"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  assert.throws(
    () => parseJudgeArgv(["--unknown-flag"]),
    (error: unknown) =>
      error instanceof CliUsageError && /unknown judge option/.test(error.message),
  );
  const parsed = parseJudgeArgv([
    "--attach",
    "a.md",
    "--project",
    "/tmp/p",
    "opaque",
    "instruction",
  ]);
  assert.equal(parsed.instruction, "opaque instruction");
  assert.deepEqual(parsed.attachmentPaths, ["a.md"]);
  assert.equal(parsed.project, "/tmp/p");
});

test("admitJudgeInvocation freezes regular-file attachments against later mutation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const source = join(home, "evidence.txt");
    await writeFile(source, "admitted-bytes-v1", "utf8");

    const admitted = await admitJudgeInvocation({
      home,
      cwd: project,
      instruction: "review the attachment",
      attachmentPaths: [source],
      createRunId: () => "run-freeze-001",
    });

    assert.equal(admitted.attachments.length, 1);
    const frozen = admitted.attachments[0]!;
    assert.equal(await readFile(frozen.frozenPath, "utf8"), "admitted-bytes-v1");
    const frozenSha = frozen.sha256;

    await writeFile(source, "mutated-after-admission", "utf8");
    assert.equal(await readFile(frozen.frozenPath, "utf8"), "admitted-bytes-v1");
    assert.equal(frozen.sha256, frozenSha);

    await unlink(source);
    assert.equal(await readFile(frozen.frozenPath, "utf8"), "admitted-bytes-v1");

    // #78 placement: run under book runs/, session reserved, no index content bytes.
    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(admitted.bookKey, bookKey);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "runs", "run-freeze-001@judge"),
    );
    assert.equal(admitted.sessionDirectory, join(admitted.runDirectory, "session"));
    await access(admitted.admittedRequestPath);
    // Index file (waiting.jsonl) must not receive request content.
    await assert.rejects(
      () => readFile(join(home, ".ak-roles", "books", bookKey, "waiting.jsonl"), "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });
});

test("structurally empty request transports only the nonblank envelope", () => {
  const empty = buildJudgeTransportPrompt({
    role: "judge",
    runId: "r",
    bookKey: "b",
    projectRoot: "/p",
    instruction: "   ",
    instructionEmpty: true,
    attachments: [],
    runDirectory: "/r",
    sessionDirectory: "/r/session",
    admittedRequestPath: "/r/admitted-request.json",
  });
  assert.equal(empty, EMPTY_INVOCATION_TRANSPORT_ENVELOPE);
  assert.equal(empty.includes("please"), false);
  assert.equal(empty.includes("task"), false);

  const withAttach = buildJudgeTransportPrompt({
    role: "judge",
    runId: "r",
    bookKey: "b",
    projectRoot: "/p",
    instruction: "",
    instructionEmpty: true,
    attachments: [
      {
        provenancePath: "/orig",
        frozenPath: "/frozen/00-a.txt",
        byteLength: 1,
        sha256: "abc",
        mediaKind: "regular-file",
      },
    ],
    runDirectory: "/r",
    sessionDirectory: "/r/session",
    admittedRequestPath: "/r/admitted-request.json",
  });
  assert.equal(withAttach.startsWith(EMPTY_INVOCATION_TRANSPORT_ENVELOPE), true);
  assert.match(withAttach, /\/frozen\/00-a\.txt/);
});

test("registry renderer owns public command text; model prose is ignored", () => {
  assert.equal(
    renderPublicAkRoleCommand({ role: "reviewer", phase: null }),
    "ak-role reviewer",
  );
  assert.equal(
    renderPublicAkRoleCommand({ role: "fixer", phase: "apply" }),
    "ak-role fixer apply",
  );
  assert.equal(
    renderPublicAkRoleCommand({ role: "coder", phase: "plan" }),
    "ak-role coder plan",
  );
  assert.equal(
    renderPublicAkRoleCommand({ role: "navigator", phase: null }),
    undefined,
  );

  const fact = recommendationNavigatorFact({
    next: { role: "reviewer", phase: null },
    reason: "next seat",
    modelCommand: "Usage: pi --ak-role reviewer --help DO NOT USE",
  });
  assert.equal(fact.disposition, "recommendation");
  if (fact.disposition === "recommendation") {
    assert.equal(fact.command, "ak-role reviewer");
    assert.equal(fact.command.includes("pi --ak-role"), false);
  }
});

test("Terminal result regions carry role outcome, navigator fact, and artifact refs", () => {
  const formatted = formatTerminalResult({
    roleOutcome: {
      kind: "accepted",
      role: "judge",
      status: "converged",
      decisiveFacts: { judgeStatus: "converged", note: "done" },
    },
    navigator: {
      disposition: "recommendation",
      next: { role: "fixer", phase: "apply" },
      reason: "repair next",
      command: "ak-role fixer apply",
    },
    artifacts: [
      { kind: "report", path: "/r/artifacts/report.json" },
      { kind: "evidence", path: "/r/artifacts/evidence.json" },
    ],
    runId: "run-term-1",
  });
  const regions = parseTerminalResultRegions(formatted);
  assert.equal(regions.role, "judge");
  assert.equal(regions.outcomeKind, "accepted");
  assert.equal(regions.status, "converged");
  assert.equal(regions.facts.judgeStatus, "converged");
  assert.equal(regions.navigatorDisposition, "recommendation");
  assert.equal(regions.nextRole, "fixer");
  assert.equal(regions.nextPhase, "apply");
  assert.equal(regions.command, "ak-role fixer apply");
  assert.equal(regions.artifacts.length, 2);
  assert.equal(regions.runId, "run-term-1");
});

test("settlement extracts Judge outcome and Navigator recommendation without model command prose", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: {
          judgeStatus: "continue",
          fix: { summary: "close the gate" },
          classes: [{ name: "A", owner: "o", boundary: "b", disposition: "open" }],
        },
      },
    },
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: {
        details: {
          disposition: "recommendation",
          next: { role: "fixer", phase: "apply" },
          reason: "typed next",
          command: "Usage: pi --ak-role fixer --help",
          route: [
            { role: "judge", phase: null },
            { role: "fixer", phase: "apply" },
          ],
        },
      },
    },
  ];
  const outcome = extractJudgeRoleOutcome(entries);
  assert.equal(outcome?.kind, "accepted");
  assert.equal(outcome?.status, "continue");
  assert.equal(outcome?.decisiveFacts.fixSummary, "close the gate");

  const navigator = extractNavigatorFact(entries);
  assert.equal(navigator.disposition, "recommendation");
  if (navigator.disposition === "recommendation") {
    assert.equal(navigator.command, "ak-role fixer apply");
    assert.equal(navigator.command.includes("pi --ak-role"), false);
  }
});

test("raceNavigatorGrace is three seconds and yields timeout sentinel", async () => {
  assert.equal(NAVIGATOR_POST_ROLE_GRACE_MS, 3_000);
  let slept = 0;
  const result = await raceNavigatorGrace(
    new Promise<string>(() => {
      /* never settles */
    }),
    50,
    async (ms) => {
      slept = ms;
    },
  );
  assert.equal(result.status, "timeout");
  assert.equal(slept, 50);

  const done = await raceNavigatorGrace(
    Promise.resolve("ok"),
    1_000,
    async () => {
      await new Promise((r) => setTimeout(r, 50));
    },
  );
  assert.deepEqual(done, { status: "done", value: "ok" });
});

test("runAkRole judge rejects burden selector before admission", async () => {
  await withTempHome(async (home) => {
    const { io, stderr } = captureIo();
    let ran = false;
    const result = await runAkRole(["judge", "--burden", "heavy", "task"], {
      packageRoot,
      home,
      io,
      piRunner: async (args) => {
        ran = true;
        return {
          code: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(ran, false);
    assert.match(stderr.join(""), /burden selector/);
  });
});

test("runAkRole judge admits, activates Internal, and publishes one Terminal result", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const attachment = join(home, "note.txt");
    await writeFile(attachment, "freeze-me", "utf8");

    const { io, stdout, stderr } = captureIo();
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    const result = await runAkRole(
      [
        "judge",
        "--attach",
        attachment,
        "--project",
        project,
        "Decide whether the attachment is sufficient.",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        correlationId: "corr-106-unit",
        createRunId: () => "run-cli-judge-001",
        io,
        piRunner: async (args, options) => {
          capturedArgs = [...args];
          capturedEnv = options.env;
          const sessionDirIdx = args.indexOf("--session-dir");
          assert.ok(sessionDirIdx >= 0);
          const sessionDir = args[sessionDirIdx + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const sessionFile = join(sessionDir, "session.jsonl");
          const rows = [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { judgeStatus: "converged", note: "ok" },
              },
            },
            {
              type: "custom_message",
              customType: "ak-navigator-attendance",
              message: {
                details: {
                  disposition: "recommendation",
                  next: { role: "reviewer", phase: null },
                  reason: "review next",
                  command: "Usage: pi --ak-role reviewer --help",
                },
              },
            },
          ];
          await writeFile(
            sessionFile,
            `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0, stderr.join(""));
    assert.equal(Array.isArray(capturedArgs), true);
    assert.equal(capturedArgs![0], "--no-extensions");
    assert.equal(capturedArgs!.includes("--ak-role"), true);
    assert.equal(capturedArgs!.includes("judge"), true);
    // No public burden selector on the Internal activation line.
    assert.equal(
      capturedArgs!.some((arg) => arg.includes("burden")),
      false,
    );
    // Opaque instruction reaches the gate as the prompt tail.
    assert.equal(
      capturedArgs!.at(-1)?.includes("Decide whether the attachment is sufficient."),
      true,
    );
    // Frozen attachment path (not the mutable source) is what the prompt references.
    const prompt = capturedArgs!.at(-1)!;
    assert.match(prompt, /attachments\/00-note\.txt/);
    assert.equal(prompt.includes(attachment), false);

    assert.equal(capturedEnv?.AK_CORRELATION_ID, "corr-106-unit");
    assert.equal(
      typeof capturedEnv?.AK_ROLE_RUN_DIR === "string" &&
        capturedEnv.AK_ROLE_RUN_DIR.includes("run-cli-judge-001@judge"),
      true,
    );

    const regions = parseTerminalResultRegions(stdout.join(""));
    assert.equal(regions.role, "judge");
    assert.equal(regions.outcomeKind, "accepted");
    assert.equal(regions.status, "converged");
    assert.equal(regions.navigatorDisposition, "recommendation");
    assert.equal(regions.nextRole, "reviewer");
    assert.equal(regions.command, "ak-role reviewer");
    assert.equal(regions.runId, "run-cli-judge-001");
    assert.equal(regions.artifacts.some((a) => a.kind === "report"), true);
    assert.equal(regions.artifacts.some((a) => a.kind === "evidence"), true);

    // Artifacts are openable paths under the run directory.
    for (const artifact of regions.artifacts) {
      await access(artifact.path);
    }

    // Source mutation after admission does not affect frozen snapshot.
    await writeFile(attachment, "changed", "utf8");
    const bookKey = resolveBookKeyFromGit(project);
    const frozenPath = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-cli-judge-001@judge",
      "attachments",
      "00-note.txt",
    );
    assert.equal(await readFile(frozenPath, "utf8"), "freeze-me");
  });
});

test("runAkRole judge empty request does not invent semantic task content on the transport", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "empty-proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    let prompt: string | undefined;

    const result = await runAkRole(["judge", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-empty-001",
      io,
      piRunner: async (args) => {
        prompt = String(args.at(-1));
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { judgeStatus: "converged" },
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(prompt, EMPTY_INVOCATION_TRANSPORT_ENVELOPE);
    const regions = parseTerminalResultRegions(stdout.join(""));
    assert.equal(regions.navigatorDisposition, "no-advice");
  });
});
