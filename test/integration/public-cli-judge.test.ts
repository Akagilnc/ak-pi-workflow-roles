import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
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
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
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
import { resolveInternalRoleEntrypoint } from "../../src/pi/role-turn-host.ts";

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

/** Temp physical root + dir-symlink alias; owns cleanup after successful mkdtemp. */
async function withPhysicalAliasFixture<T>(
  body: (paths: { physicalRoot: string; aliasRoot: string }) => Promise<T>,
  hooks?: {
    mkdirWork?: (physicalRoot: string) => Promise<void>;
    linkAlias?: (physicalRoot: string, aliasRoot: string) => Promise<void>;
    /** Test-only: inject teardown unlink failure after successful setup. */
    unlinkAlias?: (aliasRoot: string) => Promise<void>;
  },
): Promise<T> {
  const physicalRoot = await mkdtemp(join(tmpdir(), "ak-nav-subject-"));
  const aliasRoot = `${physicalRoot}-alias`;
  let aliasCreated = false;
  const mkdirWork =
    hooks?.mkdirWork ??
    (async (root: string) => {
      await mkdir(join(root, "repo", ".ak", "work"), { recursive: true });
    });
  const linkAlias =
    hooks?.linkAlias ??
    (async (root: string, alias: string) => {
      await symlink(root, alias, "dir");
    });
  const unlinkAlias =
    hooks?.unlinkAlias ??
    (async (alias: string) => {
      await unlink(alias);
    });
  try {
    // Every fallible step after mkdtemp stays inside the cleanup region.
    await mkdirWork(physicalRoot);
    await linkAlias(physicalRoot, aliasRoot);
    aliasCreated = true;
    return await body({ physicalRoot, aliasRoot });
  } finally {
    try {
      if (aliasCreated) {
        await unlinkAlias(aliasRoot);
      }
    } finally {
      // Root removal still runs if alias unlink rejects.
      await rm(physicalRoot, { recursive: true, force: true });
    }
  }
}

async function assertPathGone(path: string): Promise<void> {
  await assert.rejects(() => access(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
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
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const details = {
            judgeStatus: "escalate",
            decisionGate: { question: "请二选一", options },
          };
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, details),
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge" as const, details },
          };
        },
          }),
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
      principalAuthority: piDurablePrincipalAuthority,
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
      principalAuthority: piDurablePrincipalAuthority,
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
    assert.equal(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, join(admitted.runDirectory, "session"));
    await access(admitted.admittedRequestPath);
    // Unbound admit writes no waiting.jsonl; when present it must never hold request content.
    const waitingPath = join(home, ".ak-roles", "books", bookKey, "waiting.jsonl");
    try {
      const waiting = await readFile(waitingPath, "utf8");
      assert.equal(waiting.includes("review the attachment"), false);
      assert.equal(waiting.includes("admitted-bytes-v1"), false);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
  });
});

test("structurally empty request stays empty while attachments remain typed transport", () => {
  const empty = buildJudgeTransportPrompt(
    fixtureJudgeAdmitted({
      runId: "r",
      bookKey: "b",
      projectRoot: "/p",
      instruction: "   ",
      instructionEmpty: true,
      runDirectory: "/r",
      sessionDirectory: "/r/session",
      sessionFile: "/r/session/session.jsonl",
    }),
  );
  assert.equal(empty, "");

  const withAttach = buildJudgeTransportPrompt(
    fixtureJudgeAdmitted({
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
    }),
  );
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

test("extractNavigatorFact keeps three-state attendance: affirmative no-advice vs missing/uncorrelated/unparseable", () => {
  const invocationId = "019f8c2a-1111-7111-8111-111111111111";
  const correlated = {
    version: 1,
    invocationId,
    role: "judge",
    phase: null,
    subjectKey: "/repo/.ak/work",
  };
  const invocationPrincipal = {
    type: "custom",
    customType: "ak-navigator-invocation",
    data: { invocationId, role: "judge", phase: null, subjectKey: "/repo/.ak/work" },
  };
  const judgeTerminal = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { judgeStatus: "converged" },
    },
  };

  const noAdvice = extractNavigatorFact([
    invocationPrincipal,
    judgeTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: { details: { ...correlated, disposition: "no-advice" } },
    },
  ]);
  assert.equal(noAdvice.disposition, "no-advice");

  const missing = extractNavigatorFact([judgeTerminal]);
  assert.equal(missing.disposition, "unavailable");
  if (missing.disposition === "unavailable") {
    assert.equal(missing.source, "unknown");
    assert.equal(typeof missing.reason, "string");
  }

  const uncorrelated = extractNavigatorFact([
    invocationPrincipal,
    judgeTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: {
        details: {
          disposition: "no-advice",
          // missing invocation/role/phase/subject correlation facts
        },
      },
    },
  ]);
  assert.equal(uncorrelated.disposition, "unavailable");
  if (uncorrelated.disposition === "unavailable") {
    assert.equal(uncorrelated.source, "unknown");
  }

  const unparseable = extractNavigatorFact([
    judgeTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: { details: "not-an-object" },
    },
  ]);
  assert.equal(unparseable.disposition, "unavailable");
  if (unparseable.disposition === "unavailable") {
    assert.equal(unparseable.source, "unknown");
  }

  const badDisposition = extractNavigatorFact([
    invocationPrincipal,
    judgeTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: { details: { ...correlated, disposition: "mystery" } },
    },
  ]);
  assert.equal(badDisposition.disposition, "unavailable");
});

test("extractNavigatorFact keeps minimal invocationId provenance and post-terminal order", async () => {
  const sessionId = "019f-session-current";
  const cwd = "/repo";
  const subjectKey = "/repo/.ak/work";
  // Opaque principals — not sessionId:sequence (restart-repeatable).
  const currentInvocationId = "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b";
  const oldInvocationId = "019f8c2a-0000-7000-8000-000000000001";
  const futureInvocationId = "019f8c2a-ffff-7fff-8fff-ffffffffffff";
  const sessionHeader = {
    type: "session",
    id: sessionId,
    cwd,
  };
  const invocation = (invocationId: string, data: Record<string, unknown> = {}) => ({
    type: "custom",
    customType: "ak-navigator-invocation",
    data: { invocationId, role: "judge", phase: null, subjectKey, ...data },
  });
  // Durable accepted terminal (shared classifier). isError:true/details:{} is nonterminal.
  const currentTerminal = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { judgeStatus: "converged" },
    },
  };
  const attendance = (details: Record<string, unknown>) => ({
    type: "custom_message",
    customType: "ak-navigator-attendance",
    message: { details: { disposition: "no-advice", ...details } },
  });
  const matched = {
    invocationId: currentInvocationId,
  };

  // Attendance before the current role terminal is an old-round/stale fact.
  const beforeTerminal = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    attendance(matched),
    currentTerminal,
  ]);
  assert.equal(beforeTerminal.disposition, "unavailable");

  // Runtime-self-produced role/phase/subject/version are not re-reconciled (ADR 0042).
  // Divergent self-fields still admit when invocationId + post-terminal order hold.
  const mismatchedSelfFields = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    attendance({
      ...matched,
      version: 99,
      role: "fixer",
      phase: "apply",
      subjectKey: "/other/work",
    }),
  ]);
  assert.equal(mismatchedSelfFields.disposition, "no-advice");

  // Old attendance token (and old marker left behind a newer principal) rejected.
  const oldAttendance = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    invocation(currentInvocationId),
    currentTerminal,
    attendance({ invocationId: oldInvocationId }),
  ]);
  assert.equal(oldAttendance.disposition, "unavailable");
  // Old attendance event before the current terminal is stale, even with matching old marker.
  const oldAttendanceEvent = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    attendance({ invocationId: oldInvocationId }),
    invocation(currentInvocationId),
    currentTerminal,
  ]);
  assert.equal(oldAttendanceEvent.disposition, "unavailable");

  // Future marker/event after terminal must not supply the principal.
  const futureMarker = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    invocation(futureInvocationId),
    attendance({ invocationId: futureInvocationId }),
  ]);
  assert.equal(futureMarker.disposition, "unavailable");
  // Attendance carrying future token while current marker is before terminal.
  const futureAttendance = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    attendance({ invocationId: futureInvocationId }),
  ]);
  assert.equal(futureAttendance.disposition, "unavailable");

  // Malformed nearest marker before terminal blocks fallback to older valid marker.
  const malformedNearest = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    { type: "custom", customType: "ak-navigator-invocation", data: { invocationId: "" } },
    currentTerminal,
    attendance({ invocationId: oldInvocationId }),
  ]);
  assert.equal(malformedNearest.disposition, "unavailable");
  const malformedData = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    { type: "custom", customType: "ak-navigator-invocation", data: "not-an-object" },
    currentTerminal,
    attendance(matched),
  ]);
  assert.equal(malformedData.disposition, "unavailable");

  // Missing independent invocation principal → unavailable.
  const noInvocationPrincipal = extractNavigatorFact([
    sessionHeader,
    currentTerminal,
    attendance(matched),
  ]);
  assert.equal(noInvocationPrincipal.disposition, "unavailable");

  // No session header and no independent invocation principal → unavailable.
  const noSessionHeader = extractNavigatorFact([
    currentTerminal,
    attendance(matched),
  ]);
  assert.equal(noSessionHeader.disposition, "unavailable");

  // Wrong invocation id (different opaque principal) is not this call.
  const wrongInvocation = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    attendance({ invocationId: "019f8c2a-aaaa-7bbb-8ccc-ddddeeeeffff" }),
  ]);
  assert.equal(wrongInvocation.disposition, "unavailable");

  // Exact current token (nearest before terminal) correlates; older rounds stay ignored.
  const current = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    attendance({ invocationId: oldInvocationId }),
    invocation(currentInvocationId),
    currentTerminal,
    attendance(matched),
  ]);
  assert.equal(current.disposition, "no-advice");

  // Future marker after terminal is ignored when current marker is before terminal.
  const ignoreFutureMarker = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    invocation(futureInvocationId),
    attendance(matched),
  ]);
  assert.equal(ignoreFutureMarker.disposition, "no-advice");

  // Same-session new invocation: only the current token (nearest before terminal) correlates.
  const priorTerminal = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { judgeStatus: "converged" },
    },
  };
  const sameSessionNewInvocation = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    priorTerminal,
    attendance({ invocationId: oldInvocationId }),
    invocation(currentInvocationId),
    currentTerminal,
    attendance(matched),
  ]);
  assert.equal(sameSessionNewInvocation.disposition, "no-advice");
  const sameSessionStaleAttendance = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    priorTerminal,
    attendance({ invocationId: oldInvocationId }),
    invocation(currentInvocationId),
    currentTerminal,
    attendance({ invocationId: oldInvocationId }),
  ]);
  assert.equal(sameSessionStaleAttendance.disposition, "unavailable");

  // Marker self role/phase/subject are not re-reconciled against the terminal or admitted identity.
  const mismatchedMarkerFields = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId, { role: "coder", phase: "apply", subjectKey: "/other/work" }),
    currentTerminal,
    attendance({
      invocationId: currentInvocationId,
      role: "coder",
      phase: "apply",
      subjectKey: "/other/work",
    }),
  ]);
  assert.equal(mismatchedMarkerFields.disposition, "no-advice");

  // Attendance extraction does not re-litigate marker↔terminal cardinality (receipt settlement owns that).
  // Latest durable terminal + invocationId + post-terminal order still admits affirmative attendance.
  const twoDurable = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: { judgeStatus: "revise" },
      },
    },
    attendance(matched),
  ]);
  assert.equal(twoDurable.disposition, "no-advice");

  // Real entry → external result: divergent recommendation (next differs from settlement role) appears as-is.
  const divergentRecommendation = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    currentTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: {
        details: {
          disposition: "recommendation",
          invocationId: currentInvocationId,
          role: "judge",
          phase: null,
          subjectKey,
          next: { role: "merger", phase: null },
          reason: "游奕使建议直接合并（与判词无关，原样交调用者）",
          command: "ak-role merger",
        },
      },
    },
  ]);
  assert.equal(divergentRecommendation.disposition, "recommendation");
  if (divergentRecommendation.disposition === "recommendation") {
    assert.deepEqual(divergentRecommendation.next, { role: "merger", phase: null });
    assert.equal(divergentRecommendation.reason, "游奕使建议直接合并（与判词无关，原样交调用者）");
    assert.equal(divergentRecommendation.command, "ak-role merger");
  }
});

test("withPhysicalAliasFixture cleans alias and root when body rejects", async () => {
  let physicalRoot = "";
  let aliasRoot = "";
  const bodyRejected = new Error("body rejected");
  await assert.rejects(
    () =>
      withPhysicalAliasFixture(async (paths) => {
        physicalRoot = paths.physicalRoot;
        aliasRoot = paths.aliasRoot;
        await access(physicalRoot);
        await access(aliasRoot);
        throw bodyRejected;
      }),
    (error: unknown) => error === bodyRejected,
  );
  assert.notEqual(physicalRoot, "");
  assert.notEqual(aliasRoot, "");
  await assertPathGone(aliasRoot);
  await assertPathGone(physicalRoot);
});

test("withPhysicalAliasFixture cleans root when mkdir setup rejects after mkdtemp", async () => {
  let physicalRoot = "";
  let aliasRoot = "";
  const mkdirRejected = new Error("mkdir rejected");
  await assert.rejects(
    () =>
      withPhysicalAliasFixture(
        async () => {
          assert.fail("body must not run after mkdir rejection");
        },
        {
          mkdirWork: async (root) => {
            physicalRoot = root;
            aliasRoot = `${root}-alias`;
            throw mkdirRejected;
          },
        },
      ),
    (error: unknown) => error === mkdirRejected,
  );
  assert.notEqual(physicalRoot, "");
  await assertPathGone(physicalRoot);
  await assertPathGone(aliasRoot);
});

test("withPhysicalAliasFixture cleans root when symlink setup rejects after mkdtemp", async () => {
  let physicalRoot = "";
  let aliasRoot = "";
  const symlinkRejected = new Error("symlink rejected");
  await assert.rejects(
    () =>
      withPhysicalAliasFixture(
        async () => {
          assert.fail("body must not run after symlink rejection");
        },
        {
          linkAlias: async (root, alias) => {
            physicalRoot = root;
            aliasRoot = alias;
            await access(physicalRoot);
            throw symlinkRejected;
          },
        },
      ),
    (error: unknown) => error === symlinkRejected,
  );
  assert.notEqual(physicalRoot, "");
  assert.notEqual(aliasRoot, "");
  await assertPathGone(aliasRoot);
  await assertPathGone(physicalRoot);
});

test("withPhysicalAliasFixture removes root and rethrows original unlink error", async () => {
  let physicalRoot = "";
  let aliasRoot = "";
  const unlinkRejected = new Error("unlink rejected");
  try {
    await assert.rejects(
      () =>
        withPhysicalAliasFixture(
          async (paths) => {
            physicalRoot = paths.physicalRoot;
            aliasRoot = paths.aliasRoot;
            await access(physicalRoot);
            await access(aliasRoot);
          },
          {
            unlinkAlias: async () => {
              throw unlinkRejected;
            },
          },
        ),
      (error: unknown) => error === unlinkRejected,
    );
    assert.notEqual(physicalRoot, "");
    assert.notEqual(aliasRoot, "");
    // Nested finally still removed the physical root despite unlink rejection.
    await assertPathGone(physicalRoot);
    // Alias intentionally retained (dangling after root rm); lstat avoids follow.
    assert.equal((await lstat(aliasRoot)).isSymbolicLink(), true);
  } finally {
    // Test owns residual alias cleanup so the baseline stays clean.
    if (aliasRoot !== "") {
      await unlink(aliasRoot).catch(() => undefined);
    }
  }
  await assertPathGone(aliasRoot);
});

test("settlement extracts Judge outcome and Navigator recommendation without model command prose", () => {
  const entries = [
    {
      type: "custom",
      customType: "ak-navigator-invocation",
      data: {
        invocationId: "019f8c2a-3333-7333-8333-333333333333",
        role: "judge",
        phase: null,
        subjectKey: "/repo/.ak/work",
      },
    },
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
          version: 1,
          disposition: "recommendation",
          invocationId: "019f8c2a-3333-7333-8333-333333333333",
          role: "judge",
          phase: null,
          subjectKey: "/repo/.ak/work",
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
      type: "custom",
      customType: "ak-navigator-invocation",
      data: {
        invocationId: "019f8c2a-4444-7444-8444-444444444444",
        role: "judge",
        phase: null,
        subjectKey: "/repo/.ak/work",
      },
    },
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
          version: 1,
          disposition: "recommendation",
          invocationId: "019f8c2a-4444-7444-8444-444444444444",
          role: "judge",
          phase: null,
          subjectKey: "/repo/.ak/work",
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

test("runAkRole judge rejects burden selector before admission", async () => {
  await withTempHome(async (home) => {
    const { io, stderr } = captureIo();
    let ran = false;
    const result = await runAkRole(["judge", "--burden", "heavy", "task"], {
      packageRoot,
      home,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        ran = true;
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(ran, false);
    // Emission happened; phrasing is unfrozen presentation (AC6).
    assert.equal(stderr.length >= 1, true);
    assert.equal(result.terminal, undefined);
  });
});

test("runAkRole Judge publishes accepted Terminal facts when its audit has no receipt", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // ADR 0049 host correlation channel remains optional env; no lease mint.
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
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
          capturedArgs = [...args];
          capturedEnv = options.env;
          const sessionDirIdx = args.indexOf("--session-dir");
          assert.ok(sessionDirIdx >= 0);
          const sessionDir = args[sessionDirIdx + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const sessionFile = join(sessionDir, "session.jsonl");
          const subjectKey = join(project, ".ak/work");
          const rows = [
            {
              type: "custom",
              customType: "ak-navigator-invocation",
              data: {
                invocationId: "019f8c2a-5555-7555-8555-555555555555",
                role: "judge",
                phase: null,
                subjectKey,
              },
            },
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: {
                  judgeStatus: "converged",
                  note: "ok",
                  auditNoReceipt: {
                    status: "no-receipt",
                    terminalToolCalled: false,
                    rejectedReceipts: [],
                    deliveryTurns: 2,
                    sessionCompletion: "settled-without-accepted-receipt",
                    runPointer: "/audit/run",
                    attemptPointer: "audit-attempt",
                    acceptedReceipt: false,
                  },
                },
              },
            },
            {
              type: "custom_message",
              customType: "ak-navigator-attendance",
              message: {
                details: {
                  version: 1,
                  disposition: "recommendation",
                  invocationId: "019f8c2a-5555-7555-8555-555555555555",
                  role: "judge",
                  phase: null,
                  // Matches admitted projectRoot work identity.
                  subjectKey,
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
            sealedAcceptance: {
              role: "judge" as const,
              details: {
                judgeStatus: "converged",
                note: "ok",
                auditNoReceipt: {
                  status: "no-receipt",
                  terminalToolCalled: false,
                  rejectedReceipts: [],
                  deliveryTurns: 2,
                  sessionCompletion: "settled-without-accepted-receipt",
                  runPointer: "/audit/run",
                  attemptPointer: "audit-attempt",
                  acceptedReceipt: false,
                },
              },
            },
          };
        },
          }),
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

    // ADR 0049 host correlation channel: optional env id reaches the child when present.
    assert.equal(capturedEnv?.AK_CORRELATION_ID, "corr-106-unit");
    assert.equal(
      typeof capturedEnv?.AK_ROLE_RUN_DIR === "string" &&
        capturedEnv.AK_ROLE_RUN_DIR.includes("run-cli-judge-001@judge"),
      true,
    );

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-cli-judge-001@judge",
    );
    const terminal = await settleJudgeTerminalResult(
      fixtureJudgeAdmitted({
        runId: "run-cli-judge-001",
        runDirectory: runDir,
        projectRoot: project,
        bookKey,
        instruction: "Decide whether the attachment is sufficient.",
        instructionEmpty: false,
      }),
      piDurablePrincipalAuthority,
    );
    assert.equal(stdout.length, 1);
    assert.notEqual(stdout[0]?.trim(), "");
    // #416 autoResumeCount is call-local observation (0 for first-attempt lawful) and is part of Terminal presentation
    (terminal as { autoResumeCount?: number }).autoResumeCount = 0;
    assert.equal(stdout.join(""), formatTerminalResult(terminal));
    assert.equal(terminal.roleOutcome.role, "judge");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "converged");
    assert.equal(
      (terminal.roleOutcome.decisiveFacts.auditNoReceipt as { acceptedReceipt?: unknown })?.acceptedReceipt,
      false,
    );
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
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        prompt = String(args.at(-1));
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        const details = { judgeStatus: "converged" };
        await writeFile(
          join(sessionDir, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details,
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
          sealedAcceptance: { role: "judge" as const, details },
        };
      },
          }),
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
    const terminal = await settleJudgeTerminalResult(
      fixtureJudgeAdmitted({
        runId: "run-empty-001",
        runDirectory: runDir,
        projectRoot: project,
        bookKey,
        instruction: "",
        instructionEmpty: true,
      }),
      piDurablePrincipalAuthority,
    );
    // Missing attendance is not successful no-advice — require affirmative typed fact.
    assert.equal(terminal.navigator.disposition, "unavailable");
    if (terminal.navigator.disposition === "unavailable") {
      assert.equal(terminal.navigator.source, "unknown");
      assert.equal(typeof terminal.navigator.reason, "string");
    }
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "converged");
  });
});
