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
  settleJudgeTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  decodeTerminalField,
  encodeTerminalField,
  formatTerminalResult,
  recommendationNavigatorFact,
  type TerminalResult,
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

test("typed TerminalResult owns complete role, navigator, artifact, and run facts", () => {
  const terminal: TerminalResult = {
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
  };
  // AC4 typed owner: complete assembly before presentation.
  assert.equal(terminal.roleOutcome.role, "judge");
  assert.equal(terminal.roleOutcome.kind, "accepted");
  assert.equal(terminal.roleOutcome.status, "converged");
  assert.equal(terminal.roleOutcome.decisiveFacts.judgeStatus, "converged");
  assert.equal(terminal.navigator.disposition, "recommendation");
  if (terminal.navigator.disposition === "recommendation") {
    assert.equal(terminal.navigator.next.role, "fixer");
    assert.equal(terminal.navigator.next.phase, "apply");
    assert.equal(terminal.navigator.command, "ak-role fixer apply");
  }
  assert.equal(terminal.artifacts.length, 2);
  assert.equal(terminal.runId, "run-term-1");
  // Presentation is a single non-empty write payload; labels stay unfrozen.
  const formatted = formatTerminalResult(terminal);
  assert.equal(typeof formatted, "string");
  assert.ok(formatted.length > 0);
  assert.equal(formatted.endsWith("\n"), true);
});

test("Terminal free-text encoding preserves newlines/tabs and rejects forged artifact rows", () => {
  const forgedNote = "ok\nartifact\tevidence\t/tmp/forged";
  const fixSummary = "close the gate\twith tab\nand newline";
  const decisionQuestion = "Which authority?\nSoul\tCourt";
  const reason = "next seat\nwith\ttabs";

  // Cell encoder is the free-text contract — not presentation labels.
  for (const value of [forgedNote, fixSummary, decisionQuestion, reason]) {
    const encoded = encodeTerminalField(value);
    assert.equal(encoded.includes("\n"), false);
    assert.equal(encoded.includes("\t"), false);
    assert.equal(decodeTerminalField(encoded), value);
  }

  const terminal: TerminalResult = {
    roleOutcome: {
      kind: "accepted",
      role: "judge",
      status: "continue",
      decisiveFacts: {
        judgeStatus: "continue",
        note: forgedNote,
        fixSummary,
        decisionQuestion,
      },
    },
    navigator: {
      disposition: "recommendation",
      next: { role: "fixer", phase: "apply" },
      reason,
      command: "ak-role fixer apply",
    },
    artifacts: [
      { kind: "report", path: "/r/artifacts/report.json" },
      { kind: "evidence", path: "/r/artifacts/evidence.json" },
    ],
    runId: "run-encode-1",
  };
  // Typed owner retains original free-text facts.
  assert.equal(terminal.roleOutcome.decisiveFacts.note, forgedNote);
  assert.equal(terminal.roleOutcome.decisiveFacts.fixSummary, fixSummary);
  assert.equal(terminal.roleOutcome.decisiveFacts.decisionQuestion, decisionQuestion);
  if (terminal.navigator.disposition === "recommendation") {
    assert.equal(terminal.navigator.reason, reason);
    assert.equal(terminal.navigator.command, "ak-role fixer apply");
  }
  assert.deepEqual(
    terminal.artifacts.map((a) => a.path),
    ["/r/artifacts/report.json", "/r/artifacts/evidence.json"],
  );

  const formatted = formatTerminalResult(terminal);
  // Raw presentation must not contain an unencoded forged artifact line.
  assert.equal(formatted.includes("\nartifact\tevidence\t/tmp/forged\n"), false);
  assert.equal(formatted.includes(encodeTerminalField(forgedNote)), true);
  assert.equal(formatted.includes(encodeTerminalField(reason)), true);
  // Legitimate artifact paths remain distinct from the encoded free-text payload.
  assert.equal(formatted.includes(encodeTerminalField("/r/artifacts/report.json")), true);
  assert.equal(formatted.includes(encodeTerminalField("/tmp/forged")), false);
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

test("settlement extractors keep newline/tab receipt facts on typed TerminalResult", () => {
  const note = "ok\nartifact\tevidence\t/tmp/forged";
  const fixSummary = "summary with\ttab and\nnewline";
  const decisionQuestion = "Choose:\nA\tB";
  const reason = "because\nthis\tpath";
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: {
          judgeStatus: "continue",
          note,
          fix: { summary: fixSummary },
          decisionGate: { question: decisionQuestion },
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
          next: { role: "reviewer", phase: null },
          reason,
          command: "Usage: pi --ak-role reviewer --help",
        },
      },
    },
  ];
  const roleOutcome = extractJudgeRoleOutcome(entries);
  assert.ok(roleOutcome);
  assert.equal(roleOutcome.status, "continue");
  assert.equal(roleOutcome.decisiveFacts.note, note);
  assert.equal(roleOutcome.decisiveFacts.fixSummary, fixSummary);
  assert.equal(roleOutcome.decisiveFacts.decisionQuestion, decisionQuestion);
  const navigator = extractNavigatorFact(entries);
  assert.equal(navigator.disposition, "recommendation");
  if (navigator.disposition === "recommendation") {
    assert.equal(navigator.reason, reason);
    assert.equal(navigator.command, "ak-role reviewer");
  }
  const terminal: TerminalResult = {
    roleOutcome,
    navigator,
    artifacts: [
      { kind: "report", path: "/run/artifacts/report.json" },
      { kind: "evidence", path: "/run/artifacts/evidence.json" },
    ],
    runId: "run-settle-encode",
  };
  assert.equal(terminal.artifacts.length, 2);
  assert.equal(
    terminal.artifacts.some((a) => a.path.includes("forged")),
    false,
  );
  const formatted = formatTerminalResult(terminal);
  assert.equal(formatted.includes("\nartifact\tevidence\t/tmp/forged\n"), false);
  assert.equal(formatted.includes(encodeTerminalField(note)), true);
});

test("raceNavigatorGrace is ten seconds and yields timeout sentinel", async () => {
  assert.equal(NAVIGATOR_POST_ROLE_GRACE_MS, 10_000);
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

    // AC4: one stdout write of presentation; typed facts come from settlement owners.
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0]!.length > 0);

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-cli-judge-001@judge",
    );
    const terminal = await settleJudgeTerminalResult({
      role: "judge",
      runId: "run-cli-judge-001",
      runDirectory: runDir,
      sessionDirectory: join(runDir, "session"),
      projectRoot: project,
      bookKey,
      instruction: "Decide whether the attachment is sufficient.",
      instructionEmpty: false,
      attachments: [],
      admittedRequestPath: join(runDir, "admitted-request.json"),
    });
    assert.equal(terminal.roleOutcome.role, "judge");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "converged");
    assert.equal(terminal.navigator.disposition, "recommendation");
    if (terminal.navigator.disposition === "recommendation") {
      assert.equal(terminal.navigator.next.role, "reviewer");
      assert.equal(terminal.navigator.command, "ak-role reviewer");
      assert.equal(terminal.navigator.command.includes("pi --ak-role"), false);
    }
    assert.equal(terminal.runId, "run-cli-judge-001");
    assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);

    // Artifacts are openable paths under the run directory.
    for (const artifact of terminal.artifacts) {
      await access(artifact.path);
    }
    const report = JSON.parse(
      await readFile(
        terminal.artifacts.find((a) => a.kind === "report")!.path,
        "utf8",
      ),
    ) as { role: string; runId: string; outcome: { kind: string; status: string } };
    assert.equal(report.role, "judge");
    assert.equal(report.runId, "run-cli-judge-001");
    assert.equal(report.outcome.kind, "accepted");
    assert.equal(report.outcome.status, "converged");

    // Source mutation after admission does not affect frozen snapshot.
    await writeFile(attachment, "changed", "utf8");
    const frozenPath = join(runDir, "attachments", "00-note.txt");
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
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0]!.length > 0);

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-empty-001@judge",
    );
    const terminal = await settleJudgeTerminalResult({
      role: "judge",
      runId: "run-empty-001",
      runDirectory: runDir,
      sessionDirectory: join(runDir, "session"),
      projectRoot: project,
      bookKey,
      instruction: "",
      instructionEmpty: true,
      attachments: [],
      admittedRequestPath: join(runDir, "admitted-request.json"),
    });
    assert.equal(terminal.navigator.disposition, "no-advice");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "converged");
  });
});
