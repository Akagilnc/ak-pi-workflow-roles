/**
 * #106 public Judge path — admission, freeze, terminal settlement, grace, renderer.
 * Seams: parseJudgeArgv / admitJudgeInvocation / TerminalResult / raceNavigatorGrace /
 * renderPublicAkRoleCommand / runAkRole(judge) with injectable Pi runner.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  access,
  copyFile,
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
import { isAuditEscalationResult } from "../../src/audit-escalation.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { renderPublicAkRoleCommand } from "../../src/public-cli/command-renderer.ts";
import {
  admitJudgeInvocation,
  buildJudgeTransportPrompt,
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
  formatTerminalResult,
  recommendationNavigatorFact,
  type TerminalResult,
} from "../../src/public-cli/terminal.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import {
  packageRoot,
  persistActivationSessionFile,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";
import { resolveInternalRoleEntrypoint } from "../../src/public-cli/explicit-internal.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";

function sessionToolResultLine(toolName: string, details: unknown): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      isError: false,
      details,
    },
  })}\n`;
}

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

test("S1: judge escalate public CLI prints every decisionGate option text in order", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const options = ["采纳既有法源", "改采审刑院意见"];
    const result = await runAkRole(
      ["judge", "--project", project, "show escalation options"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s1-judge-options",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
              judgeStatus: "escalate",
              decisionGate: { question: "请二选一", options },
            }),
            "utf8",
          );
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(stdout.join(""), formatTerminalResult(result.terminal));
    const face = stdout.join("");
    assert.ok(face.includes(options[0]!));
    assert.ok(face.includes(options[1]!));
    assert.ok(face.indexOf(options[0]!) < face.indexOf(options[1]!));
  });
});

test("parseJudgeArgv rejects public burden selectors and unknown flags", () => {
  // Typed structural reject only (AC6) — never freeze human diagnostic phrasing.
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
  assert.throws(() => parseJudgeArgv(["--burden", "heavy"]), isUsage);
  assert.throws(() => parseJudgeArgv(["--ak-judge-burden=light"]), isUsage);
  assert.throws(() => parseJudgeArgv(["--judge-burden", "x"]), isUsage);
  assert.throws(() => parseJudgeArgv(["--unknown-flag"]), isUsage);
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

test("parseJudgeArgv rejects blank --project/--attach path values", () => {
  // Typed structural reject only (AC6) — path-flag prose is unfrozen presentation.
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
  assert.throws(() => parseJudgeArgv(["--project=", "task"]), isUsage);
  assert.throws(() => parseJudgeArgv(["--project", "", "task"]), isUsage);
  assert.throws(() => parseJudgeArgv(["--project", "   ", "task"]), isUsage);
  assert.throws(() => parseJudgeArgv(["--attach=", "task"]), isUsage);
});

test("admitJudgeInvocation rejects blank project override before resolve", async () => {
  await withTempHome(async (home) => {
    await assert.rejects(
      () =>
        admitJudgeInvocation({
          home,
          cwd: home,
          instruction: "task",
          attachmentPaths: [],
          project: "",
        }),
      // Typed structural reject only (AC6) — do not freeze diagnostic phrasing.
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );
  });
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

test("structurally empty request stays empty while attachments remain typed transport", () => {
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
    sessionFile: "/r/session/session.jsonl",
    admittedRequestPath: "/r/admitted-request.json",
  });
  assert.equal(empty, "");

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
    sessionFile: "/r/session/session.jsonl",
    admittedRequestPath: "/r/admitted-request.json",
  });
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
  // Presentation yields one non-empty write payload; layout/labels stay unfrozen (AC6).
  const formatted = formatTerminalResult(terminal);
  assert.equal(typeof formatted, "string");
  assert.ok(formatted.length > 0);
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
  const continueEntries = [
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
  const continueOutcome = extractJudgeRoleOutcome(continueEntries);
  assert.ok(continueOutcome);
  assert.equal(continueOutcome.status, "continue");
  assert.equal(continueOutcome.decisiveFacts.note, note);
  assert.equal(continueOutcome.decisiveFacts.fixSummary, fixSummary);

  const escalateEntries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: {
          judgeStatus: "escalate",
          decisionGate: { question: decisionQuestion, options: ["A", "B"] },
        },
      },
    },
  ];
  const escalateOutcome = extractJudgeRoleOutcome(escalateEntries);
  assert.ok(escalateOutcome);
  assert.equal(escalateOutcome.status, "escalate");
  assert.equal(escalateOutcome.decisiveFacts.decisionQuestion, decisionQuestion);

  const navigator = extractNavigatorFact(continueEntries);
  assert.equal(navigator.disposition, "recommendation");
  if (navigator.disposition === "recommendation") {
    assert.equal(navigator.reason, reason);
    assert.equal(navigator.command, "ak-role reviewer");
  }
  const terminal: TerminalResult = {
    roleOutcome: continueOutcome,
    navigator,
    artifacts: [
      { kind: "report", path: "/run/artifacts/report.json" },
      { kind: "evidence", path: "/run/artifacts/evidence.json" },
    ],
    runId: "run-settle-encode",
  };
  // Typed artifact refs only — no rendered table/path presentation freeze (AC6).
  assert.equal(terminal.artifacts.length, 2);
  assert.equal(
    terminal.artifacts.some((a) => a.path.includes("forged")),
    false,
  );
});

test("raceNavigatorGrace is ten seconds and yields timeout sentinel", async () => {
  assert.equal(NAVIGATOR_POST_ROLE_GRACE_MS, 10_000);

  // Timeout path: production default grace + deferred sleep (no wall clock, no short override).
  let capturedDelay: number | undefined;
  let releaseTimer!: () => void;
  const timerHeld = new Promise<void>((resolve) => {
    releaseTimer = resolve;
  });
  let raceResolved = false;
  const pendingRace = raceNavigatorGrace(
    new Promise<string>(() => {
      /* never settles */
    }),
    // Default production grace — not a shortened test-only override.
    NAVIGATOR_POST_ROLE_GRACE_MS,
    async (ms) => {
      capturedDelay = ms;
      await timerHeld;
    },
  ).then((result) => {
    raceResolved = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(capturedDelay, 10_000);
  assert.equal(raceResolved, false);

  releaseTimer();
  assert.deepEqual(await pendingRace, { status: "timeout" });
  assert.equal(raceResolved, true);

  // Early completion while deferred timer stays unreleased: 10s is a maximum, not a fixed delay.
  let holdEarlyTimer!: () => void;
  const earlyTimerHeld = new Promise<void>((resolve) => {
    holdEarlyTimer = resolve;
  });
  const done = await raceNavigatorGrace(
    Promise.resolve("ok"),
    NAVIGATOR_POST_ROLE_GRACE_MS,
    async (ms) => {
      assert.equal(ms, 10_000);
      await earlyTimerHeld;
    },
  );
  assert.deepEqual(done, { status: "done", value: "ok" });
  holdEarlyTimer();
});

test("Judge compliance table uses the real role, audit, SessionManager, and public settlement", async () => {
  const variants = [
    { name: "string-array-pass", arguments: { status: "pass", violations: "[]", conflicts: "[]", decisionGate: null }, expectedOutcome: "accepted" as const },
    { name: "status-only-pass", arguments: { status: "pass" }, expectedOutcome: "accepted" as const },
    { name: "additional-key-pass", arguments: { status: "pass", auditCost: 3 }, expectedOutcome: "accepted" as const },
    { name: "empty-violations-revise", arguments: { status: "revise", violations: [] }, expectedOutcome: "failure" as const },
  ];
  for (const variant of variants) {
    await withActivationHome({ prefix: `ak-judge-s4-${variant.name}-` }, async ({ home, agentDir }) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, `deliver ${variant.name}`],
        {
          packageRoot,
          home,
          agentDir,
          cwd: project,
          createRunId: () => `run-judge-compliance-${variant.name}`,
          io,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            const sessionDirectory = args[args.indexOf("--session-dir") + 1]!;
            const seedFile = persistActivationSessionFile({
              home,
              bookKey: resolveBookKeyFromGit(project),
              name: `s4-${variant.name}`,
              cwd: project,
            });
            await copyFile(seedFile, sessionFile);
            const sessionManager = SessionManager.open(sessionFile, sessionDirectory, project);
            const faux = (await import("@earendil-works/pi-ai")).fauxProvider({
              api: `ak-judge-s4-${variant.name}`,
              provider: `ak-judge-s4-${variant.name}`,
            });
            faux.setResponses([
              fauxAssistantMessage(
                fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, {
                  judgeStatus: "converged",
                  note: `verdict-${variant.name}`,
                }, { id: `judge-role-${variant.name}` }),
                { stopReason: "toolUse" },
              ),
              fauxAssistantMessage(
                fauxToolCall(JUDGE_AUDIT_TOOL_NAME, variant.arguments, { id: `judge-audit-${variant.name}` }),
                { stopReason: "toolUse" },
              ),
              ...(variant.expectedOutcome === "failure"
                ? [fauxAssistantMessage("audit revision observed", { stopReason: "stop" })]
                : []),
            ]);
            await withInProcessPi({
              cwd: project,
              agentDir,
              faux,
              sessionManager,
              additionalExtensionPaths: [resolveInternalRoleEntrypoint(packageRoot)],
              systemPrompt: "S4 REAL JUDGE",
              mode: "json",
              flags: { "ak-role": "judge" },
              noTools: "builtin",
            }, async ({ session }) => {
              await session.prompt(`deliver ${variant.name}`);
            });
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
      assert.equal(result.exitCode, variant.expectedOutcome === "accepted" ? 0 : 1, `${variant.name}: ${stdout.join("")} ${stderr.join("")}`);
      assert.equal(result.terminal?.roleOutcome.kind, variant.expectedOutcome, variant.name);
      assert.equal(stdout.join("").includes(`verdict-${variant.name}`), variant.expectedOutcome === "accepted");
      assert.equal(stderr.length > 0, variant.expectedOutcome === "failure");
    });
  }
});

test("real persisted Judge escalation remains bound to the retained audit response", async () => {
  await withActivationHome({ prefix: "ak-judge-persisted-escalation-" }, async ({ home, agentDir }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const conflicts = ["audit-owned conflict"];
    const decisionGate = { question: "Which authority?", options: ["owner", "audit"] };
    const result = await runAkRole(["judge", "--project", project, "escalate"], {
      packageRoot,
      home,
      agentDir,
      cwd: project,
      createRunId: () => "run-judge-persisted-escalation",
      io,
      piRunner: async (args) => {
        const sessionFile = args[args.indexOf("--session") + 1]!;
        const sessionDirectory = args[args.indexOf("--session-dir") + 1]!;
        const seedFile = persistActivationSessionFile({
          home,
          bookKey: resolveBookKeyFromGit(project),
          name: "s4-persisted-escalation",
          cwd: project,
        });
        await copyFile(seedFile, sessionFile);
        const sessionManager = SessionManager.open(sessionFile, sessionDirectory, project);
        const faux = (await import("@earendil-works/pi-ai")).fauxProvider({
          api: "ak-judge-persisted-escalation",
          provider: "ak-judge-persisted-escalation",
        });
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged", note: "persisted escalation" }, { id: "judge-escalating-role" }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(
            fauxToolCall(JUDGE_AUDIT_TOOL_NAME, { status: "escalate", conflicts, decisionGate }, { id: "judge-escalating-audit" }),
            { stopReason: "toolUse" },
          ),
        ]);
        let observedNavigator: ReturnType<typeof publicNavigatorSettlement>;
        let liveToolResultDetails: unknown;
        await withInProcessPi({
          cwd: project,
          agentDir,
          faux,
          sessionManager,
          extensionFactories: [((pi) => {
            pi.on("tool_result", (event) => {
              if (event.toolName === JUDGE_OUTPUT_TOOL_NAME) {
                liveToolResultDetails = event.details;
                observedNavigator = publicNavigatorSettlement("judge", null, event);
              }
            });
          })],
          additionalExtensionPaths: [resolveInternalRoleEntrypoint(packageRoot)],
          systemPrompt: "PERSISTED ESCALATION",
          mode: "json",
          flags: { "ak-role": "judge" },
          noTools: "builtin",
        }, async ({ session }) => {
          await session.prompt("escalate");
        });
        assert.deepEqual(
          observedNavigator,
          { kind: "human_decision", role: "judge", phase: null, status: "audit_escalation" },
        );
        assert.ok(liveToolResultDetails && typeof liveToolResultDetails === "object");
        assert.notEqual(
          publicNavigatorSettlement("judge", null, {
            toolName: JUDGE_OUTPUT_TOOL_NAME,
            isError: false,
            details: { ...(liveToolResultDetails as Record<string, unknown>) },
          })?.kind,
          "human_decision",
          "a copy of the real live tool_result must not retain audit ownership",
        );
        const liveTerminal = sessionManager.getEntries().find((entry) =>
          entry.type === "message" && entry.message.role === "toolResult" &&
          entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME,
        );
        if (liveTerminal?.type !== "message" || liveTerminal.message.role !== "toolResult") {
          throw new Error("real persisted escalation tool result is missing");
        }
        return { code: 0, stderr: "", timedOut: false, args: [...args] };
      },
    });
    assert.equal(result.exitCode, 0, `${stdout.join("")} ${stderr.join("")}`);
    assert.equal(result.terminal?.roleOutcome.kind, "audit_escalation");
    const sessionFile = join(
      home,
      ".ak-roles",
      "books",
      resolveBookKeyFromGit(project),
      "runs",
      "run-judge-persisted-escalation@judge",
      "session",
      "session.jsonl",
    );
    const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { message?: { role?: string; toolName?: string; details?: unknown } });
    const terminal = entries.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(terminal);
    assert.equal(isAuditEscalationResult(terminal.message?.details), true);
    assert.deepEqual((terminal.message?.details as any).conflicts, conflicts);
    assert.deepEqual((terminal.message?.details as any).auditDecisionGate, decisionGate);
    // Persisted/replayed details have no live object brand; the retained
    // response binder below owns persisted authenticity instead.
    assert.notEqual(
      publicNavigatorSettlement("judge", null, {
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: terminal.message?.details,
      })?.kind,
      "human_decision",
    );
    assert.notEqual(
      publicNavigatorSettlement("judge", null, {
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: { kind: "audit_escalation", conflicts: ["forged"], auditDecisionGate: decisionGate },
      })?.kind,
      "human_decision",
    );
    // Re-run the actual persisted public binder over this same session; shape
    // recognition above is only a fixture check, never the settlement proof.
    const bound = extractJudgeRoleOutcome(entries as never);
    assert.equal(bound?.kind, "audit_escalation");
    const forged = entries.map((entry) => entry.message?.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME
      ? { ...entry, message: { ...entry.message, details: { kind: "audit_escalation", conflicts: ["forged"], auditDecisionGate: decisionGate } } }
      : entry);
    assert.equal(extractJudgeRoleOutcome(forged as never), undefined);
  });
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
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(ran, false);
    // Emission happened; phrasing is unfrozen presentation (AC6).
    assert.equal(stderr.length >= 1, true);
    assert.equal(result.terminal, undefined);
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
      sessionFile: join(runDir, "session", "session.jsonl"),
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
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(prompt, "");
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
      sessionFile: join(runDir, "session", "session.jsonl"),
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
