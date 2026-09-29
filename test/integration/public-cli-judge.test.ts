import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "../helpers/role-turn-host-fixture.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #106 public Judge path — admission, freeze, terminal settlement, grace.
 * Seams: parseJudgeArgv / admitJudgeInvocation / TerminalResult / raceNavigatorGrace /
 * runAkRole(judge) with injectable Pi runner.
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
import { join, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { readComplianceCandidate } from "../../src/compliance-transport.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitPublicRole,
  buildInstructionTransportPrompt,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import {
  extractNavigatorFact,
  NAVIGATOR_POST_ROLE_GRACE_MS,
  raceNavigatorGrace,
  settleSeatTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  formatTerminalResult,
  adviceNavigatorFact,
  type TerminalResult,
  type TerminalRoleOutcome,
} from "../../src/public-cli/terminal.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import {
  packageRoot,
  persistActivationSessionFile,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";
import { resolveInternalRoleEntrypoint } from "../../src/pi/role-turn-host.ts";

import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

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
  return withTempRoot("ak-public-cli-judge-", scenario);
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
  const physicalRoot = await mkdtemp(worktreeTempPrefix("ak-nav-subject-"));
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
  // Independent cleanups: unlink failure must not erase primary or skip root rm.
  return withPrimaryAwareCleanup(
    async () => {
      await mkdirWork(physicalRoot);
      await linkAlias(physicalRoot, aliasRoot);
      aliasCreated = true;
      return await body({ physicalRoot, aliasRoot });
    },
    async () => {
      if (aliasCreated) await unlinkAlias(aliasRoot);
    },
    async () => {
      await rm(physicalRoot, { recursive: true, force: true });
    },
  );
}

async function assertPathGone(path: string): Promise<void> {
  await assert.rejects(() => access(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

test("S1: judge escalate public CLI keeps decisionGate options on typed payload in order", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const options = ["采纳既有法源", "改采审刑院意见"];
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "show escalation options"],
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
            status: "escalate",
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
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), ["escalate"]);
    const payload = objectPayloads(result.terminal.roleOutcome)[0] ?? {};
    assert.deepEqual(payload.decisionGate, { question: "请二选一", options });
  });
});

test("parseJudgeArgv rejects public burden selectors and unknown flags", () => {
  // Typed structural reject only (AC6) — never freeze human diagnostic phrasing.
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
  assert.throws(() => parsePublicSeatArgv("judge", ["--burden", "heavy"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--ak-judge-burden=light"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--judge-burden", "x"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--unknown-flag"]), isUsage);
  const parsed = parsePublicSeatArgv("judge", [
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
  assert.throws(() => parsePublicSeatArgv("judge", ["--project=", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--project", "", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--project", "   ", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--attach=", "task"]), isUsage);
});

test("admitJudgeInvocation rejects blank project override before resolve", async () => {
  await withTempHome(async (home) => {
    await assert.rejects(
      () =>
        admitPublicRole("judge", {
          instruction: "task",
          attachmentPaths: [],
          project: "",
        }, {
          principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: home,
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

    const admitted = await admitPublicRole("judge", {
      instruction: "review the attachment",
      attachmentPaths: [source],
    }, {
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
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
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-freeze-001@judge"),
    );
    assert.equal(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, join(admitted.runDirectory, "session"));
    await access(admitted.admittedRequestPath);
    // #855: two-face waiting.jsonl deleted — admit must not create it.
    await assert.rejects(
      () => readFile(join(home, ".ak-roles", "books", bookKey, "waiting.jsonl"), "utf8"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});

test("structurally empty request stays empty while attachments remain typed transport", () => {
  const empty = buildInstructionTransportPrompt(
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

  const withAttach = buildInstructionTransportPrompt(
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

test("#959 adviceNavigatorFact projects prose as-is", () => {
  const fact = adviceNavigatorFact({
    prose: "next seat → reviewer",
  });
  assert.equal(fact.disposition, "advice");
  if (fact.disposition === "advice") {
    assert.equal(fact.prose, "next seat → reviewer");
  }
});

test("typed TerminalResult owns complete role, navigator, artifact, and run facts", () => {
  const terminal: TerminalResult = {
    roleOutcome: {
      kind: "accepted",
      role: "judge",
      payloads: [{ status: "converged", note: "done" }],
    },
    navigator: {
      disposition: "advice",
      prose: "repair next → fixer apply",
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
  assert.deepEqual(payloadStatusSequence(terminal.roleOutcome), ["converged"]);
  assert.equal((objectPayloads(terminal.roleOutcome)[0] ?? {}).status, "converged");
  assert.equal(terminal.navigator.disposition, "advice");
  if (terminal.navigator.disposition === "advice") {
    assert.equal(terminal.navigator.prose, "repair next → fixer apply");
  }
  assert.equal(terminal.artifacts.length, 2);
  assert.equal(terminal.runId, "run-term-1");
  // Presentation yields one non-empty write payload; layout/labels stay unfrozen (AC6).
  const formatted = formatTerminalResult(terminal);
  assert.equal(typeof formatted, "string");
  assert.ok(formatted.length > 0);
});

test("extractNavigatorFact keeps a native playbook read failure on the existing diagnostic", () => {
  const missing = extractNavigatorFact([
    {
      type: "custom",
      customType: "ak-navigator-route-playbook-failure",
      data: { message: "ENOENT: missing playbook" },
    },
  ]);
  assert.equal(missing.disposition, "unavailable");
  assert.equal(missing.advisoryDiagnostic, "ENOENT: missing playbook");
  const laterSuccess = extractNavigatorFact([
    {
      type: "custom",
      customType: "ak-navigator-route-playbook-failure",
      data: { message: "ENOENT: missing playbook" },
    },
    {
      type: "custom",
      customType: "ak-navigator-route-playbook-failure",
      data: { message: "" },
    },
  ]);
  assert.equal(laterSuccess.advisoryDiagnostic, undefined);
});

test("extractNavigatorFact keeps three-state attendance: affirmative no-advice vs missing/unparseable (#1087)", () => {
  // #1087: settlement takes this-call post-terminal attendance as-is — no marker /
  // invocationId correlation. Identity tokens on the payload are optional provenance.
  const judgeTerminal = {
    type: "custom",
    customType: "ak-role-submission-closure",
    data: {
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { status: "converged" },
      navigator: { disposition: "no-advice" },
    },
  };

  const noAdvice = extractNavigatorFact([
    judgeTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: { details: { disposition: "no-advice" } },
    },
  ]);
  assert.equal(noAdvice.disposition, "no-advice");

  const missing = extractNavigatorFact([{ ...judgeTerminal, data: { ...judgeTerminal.data, navigator: undefined } }]);
  assert.equal(missing.disposition, "unavailable");
  if (missing.disposition === "unavailable") {
    assert.equal(missing.source, "unknown");
    assert.equal(typeof missing.reason, "string");
  }

  const unparseable = extractNavigatorFact([
    { ...judgeTerminal, data: { ...judgeTerminal.data, navigator: "not-an-object" } },
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
    { ...judgeTerminal, data: { ...judgeTerminal.data, navigator: { disposition: "mystery" } } },
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: { details: { disposition: "mystery" } },
    },
  ]);
  assert.equal(badDisposition.disposition, "unavailable");

  // #959: historical recommendation with only next must stay advice, not no-advice.
  const legacyNextOnly = extractNavigatorFact([
    { ...judgeTerminal, data: { ...judgeTerminal.data, navigator: { disposition: "recommendation", next: { role: "reviewer", phase: null } } } },
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: {
        details: {
          disposition: "recommendation",
          next: { role: "reviewer", phase: null },
        },
      },
    },
  ]);
  assert.equal(legacyNextOnly.disposition, "advice");
  if (legacyNextOnly.disposition === "advice") {
    assert.ok(legacyNextOnly.prose.includes("reviewer"));
  }
});

test("extractNavigatorFact uses bound closure rather than late session attendance (#1087)", async () => {
  const subjectKey = "/repo/.ak/work";
  const currentInvocationId = "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b";
  const oldInvocationId = "019f8c2a-0000-7000-8000-000000000001";
  const sessionHeader = {
    type: "session",
    id: "019f-session-current",
    cwd: "/repo",
  };
  const invocation = (invocationId: string, data: Record<string, unknown> = {}) => ({
    type: "custom",
    customType: "ak-navigator-invocation",
    data: { invocationId, role: "judge", phase: null, subjectKey, ...data },
  });
  const currentTerminal = {
    type: "custom",
    customType: "ak-role-submission-closure",
    data: {
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { status: "converged" },
      navigator: { disposition: "no-advice" },
    },
  };
  const attendance = (details: Record<string, unknown>) => ({
    type: "custom_message",
    customType: "ak-navigator-attendance",
    message: { details: { disposition: "no-advice", ...details } },
  });

  // Lifecycle isolation: attendance before the current durable terminal is not this call.
  const beforeTerminal = extractNavigatorFact([
    sessionHeader,
    invocation(currentInvocationId),
    attendance({ invocationId: currentInvocationId }),
    currentTerminal,
  ]);
  assert.equal(beforeTerminal.disposition, "no-advice");

  // No historical marker / invocationId equality check (ADR 0042 / #1087).
  const withoutMarkerOrToken = extractNavigatorFact([
    sessionHeader,
    currentTerminal,
    attendance({ disposition: "no-advice" }),
  ]);
  assert.equal(withoutMarkerOrToken.disposition, "no-advice");

  const mismatchedSelfFields = extractNavigatorFact([
    sessionHeader,
    currentTerminal,
    attendance({
      invocationId: "019f8c2a-aaaa-7bbb-8ccc-ddddeeeeffff",
      version: 99,
      role: "fixer",
      phase: "apply",
      subjectKey: "/other/work",
    }),
  ]);
  assert.equal(mismatchedSelfFields.disposition, "no-advice");

  // Prior-round attendance before the current terminal stays outside the window.
  const oldAttendanceEvent = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    attendance({ invocationId: oldInvocationId }),
    invocation(currentInvocationId),
    currentTerminal,
  ]);
  assert.equal(oldAttendanceEvent.disposition, "no-advice");

  // Same-session successor: latest post-terminal attendance is this call's delivery.
  const priorTerminal = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { status: "converged" },
    },
  };
  const sameSessionNewInvocation = extractNavigatorFact([
    sessionHeader,
    invocation(oldInvocationId),
    priorTerminal,
    attendance({ invocationId: oldInvocationId }),
    invocation(currentInvocationId),
    currentTerminal,
    attendance({ invocationId: currentInvocationId }),
  ]);
  assert.equal(sameSessionNewInvocation.disposition, "no-advice");

  // Latest durable terminal bounds the window even when earlier terminals exist.
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
        details: { status: "continue" },
      },
    },
    attendance({ disposition: "no-advice" }),
  ]);
  assert.equal(twoDurable.disposition, "no-advice");

  // Real entry → external result: divergent prose advice appears as-is (#959).
  const divergentAdvice = extractNavigatorFact([
    sessionHeader,
    currentTerminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: {
        details: {
          disposition: "advice",
          prose: "游奕使建议直接合并（与判词无关，原样交调用者）",
        },
      },
    },
  ]);
  assert.equal(divergentAdvice.disposition, "no-advice");
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
  await withPrimaryAwareCleanup(
    async () => {
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
    },
    async () => {
      // Test owns residual alias cleanup so the baseline stays clean.
      if (aliasRoot !== "") await unlink(aliasRoot);
    },
  );
  await assertPathGone(aliasRoot);
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
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--burden", "heavy", "task"], {
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
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    // ADR 0049 host correlation channel remains optional env; no lease mint.
    const attachment = join(home, "note.txt");
    await writeFile(attachment, "freeze-me", "utf8");

    const { io, stdout, stderr } = captureIo();
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedStdin: string | undefined;

    const result = await runAkRole([
        "judge", "--model", "test/caller-seat:high",
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
          const role = args[args.indexOf("--ak-role") + 1];
          if (role === "notary" || role === "auditor") {
            return scriptedTerminatingToolSession({
              role, toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : AUDITOR_OUTPUT_TOOL_NAME,
              details: { status: "converged" },
            })(args, options);
          }
          capturedArgs = [...args];
          capturedEnv = options.env;
          capturedStdin = options.stdin;
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
                  status: "converged",
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
              type: "custom",
              customType: "ak-role-submission-closure",
              data: { toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details: { status: "converged" }, navigator: { disposition: "advice", prose: "review next → reviewer" } },
            },
            {
              type: "custom_message",
              customType: "ak-navigator-attendance",
              message: {
                details: {
                  version: 1,
                  disposition: "advice",
                  invocationId: "019f8c2a-5555-7555-8555-555555555555",
                  role: "judge",
                  phase: null,
                  // Deliberately contradict the bound closure: this late delivery
                  // must not replace the result of the admitted invocation.
                  subjectKey: "/other/work",
                  prose: "late advice from another call",
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
                status: "converged",
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
    // Opaque instruction reaches the host as typed stdin, not an argv tail.
    const prompt = readUserDialogueStdin(capturedStdin ?? "");
    assert.equal(
      prompt.includes("Decide whether the attachment is sufficient."),
      true,
    );
    // Frozen attachment path (not the mutable source) is what the prompt references.
    assert.match(prompt, /attachments\/00-note\.txt/);
    assert.equal(prompt.includes(attachment), false);

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
      "unbound", "runs",
      "run-cli-judge-001@judge",
    );
    const terminal = await settleSeatTerminalResult(
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
    assert.equal(terminal.roleOutcome.role, "judge");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(terminal.roleOutcome), ["converged"]);
    assert.equal(
      ((objectPayloads(terminal.roleOutcome)[0] ?? {}).auditNoReceipt as { acceptedReceipt?: unknown })?.acceptedReceipt,
      false,
    );
    assert.equal(terminal.navigator.disposition, "advice");
    if (terminal.navigator.disposition === "advice") {
      assert.equal(terminal.navigator.prose, "review next → reviewer");
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
    ) as { role: string; runId: string; outcome: TerminalRoleOutcome };
    assert.equal(report.role, "judge");
    assert.equal(report.runId, "run-cli-judge-001");
    assert.equal(report.outcome.kind, "accepted");
    // #836: the persisted report carries the role's original payload, not an
    // invented top-level status — read status off the last payload,
    // same as the live terminal above.
    assert.deepEqual(payloadStatusSequence(report.outcome), ["converged"]);

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
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    const { io, stdout } = captureIo();
    let prompt: string | undefined;

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-empty-001",
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
        const role = args[args.indexOf("--ak-role") + 1];
        if (role === "notary" || role === "auditor") {
          return scriptedTerminatingToolSession({
            role, toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : AUDITOR_OUTPUT_TOOL_NAME,
            details: { status: "converged" },
          })(args, options);
        }
        prompt = readUserDialogueStdin(String(options.stdin ?? ""));
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        const details = { status: "converged" };
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
      "unbound", "runs",
      "run-empty-001@judge",
    );
    const terminal = await settleSeatTerminalResult(
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
    assert.deepEqual(payloadStatusSequence(terminal.roleOutcome), ["converged"]);
  });
});
