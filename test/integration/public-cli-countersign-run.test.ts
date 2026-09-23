import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
/**
 * #572 / ADR 0074 public Countersign seat — ticket materials in, 署/封驳 verdict
 * out via real runAkRole entry; #599 / #987 resume continues via explicit package
 * runId. #742: court admission auto-runs the public 起居郎 station before the
 * body turn. #771: ticket identity comes from 起居郎 LLM typed assertion (court
 * station), never from mechanical matching of summons text against book records.
 * Public re-summons mint a new run under the typed ticket (#505 / #987).
 * Gate handoff resumes by parent run path. Explicit ak-role resume takes a runId.
 * 起居录 path delivery rides the shared post-admission mount.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import type { HostContext, RoleHost, RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitPublicRole,
  bindAdmittedTicketNumber,
  relocateAdmittedRunToTicket,
  type AdmittedCountersignInvocation,
  type AdmittedRoleInvocation,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import { type CountersignRunEnv } from "../../src/public-cli/countersign-run.ts";
import {
  buildInstructionSeatTurnRequest,
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { roleRunPlacement } from "../../src/role-run-placement.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { resolveNotarySourceRunLocator } from "../../src/notary-source-run.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  sessionRowTime,
  sessionToolExchangeRows,
  sessionUserMessageRow,
  writeSessionJsonl,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import {
  recordNonSealedSubmissionForSpawn,
  sealAcceptedSubmissionForSpawn,
} from "../helpers/submission-ledger-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
import {
  ensureTicketProvenanceVolume,
  readTicketProvenance,
} from "../../src/ticket-provenance.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-countersign-", async (home) => {
    // Nested court seats resolve from the live table (no package fill-in, #178).
    // Caller-specify via production config set — not a parallel seed helper.
    const quiet = captureIo().io;
    await runAkRole(
      [
        "config",
        "set",
        "countersign",
        "test/caller-seat:high",
        "diarist",
        "test/caller-seat:high",
        "judge",
        "test/caller-seat:high",
        "notary",
        "test/caller-seat:high",
        "inspector",
        "test/caller-seat:high",
        "auditor",
        "test/caller-seat:high",
        "gatekeeper",
        "test/caller-seat:high",
      ],
      { packageRoot, home, io: quiet },
    );
    const binDir = join(home, "bin");
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    return withPrimaryAwareCleanup(
      () => scenario(home),
      async () => {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      },
    );
  });
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

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "countersign@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Countersign Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

/** Court station always runs 起居郎 first (#771); body tests use true-unbound. */
function withTrueUnboundDiarist(inner: LegacyFauxPiRunner): LegacyFauxPiRunner {
  return async (args, options) => {
    if (argvFlagValue(args, "--ak-role") === "diarist") {
      return courtPipelinePiRunner(null)(args, options);
    }
    return inner(args, options);
  };
}

function scriptedCountersignSession(details: unknown) {
  return scriptedTerminatingToolSession({
    role: "countersign",
    toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
    details,
  });
}

test("countersign admission freezes attachments and binds the countersign role", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticket = join(project, "ticket.md");
    await writeFile(ticket, "# 票面\n五问裁决。", "utf8");

    const admitted = await admitPublicRole("countersign", {
      instruction: "裁：本票是否足以开工。",
      attachmentPaths: [ticket],
    }, {
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      createRunId: () => "01a0sign00-0000-7000-8000-000000000001",
    });

    assert.deepEqual(
      admitted.role, "countersign");
    assert.equal(admitted.instructionEmpty, false);
    assert.equal(admitted.attachments.length, 1);
    assert.ok(admitted.attachments[0]?.frozenPath);

    const turn = buildInstructionSeatTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁：本票是否足以开工。" },
    });
    assert.equal(turn.activation.role, "countersign");
    // Unbound admission: no ticket on activation (legal).
    assert.equal(
      "ticketNumber" in turn.activation ? turn.activation.ticketNumber : undefined,
      undefined,
    );
  });
});

test("countersign admission ignores attachment frontmatter; --ticket is unknown", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticket = join(project, "ticket.md");
    await writeFile(ticket, "---\nticketNumber: 100\n---\n\n五问。\n", "utf8");

    const admitted = await admitPublicRole("countersign", {
      instruction: "裁",
      attachmentPaths: [ticket],
    }, {
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      createRunId: () => "01a0sign00-0000-7000-8000-000000000582",
    });
    assert.equal(admitted.ticketNumber, undefined);

    const turn = buildInstructionSeatTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "裁" },
    });
    assert.equal(turn.activation.role, "countersign");
    assert.equal(
      "ticketNumber" in turn.activation ? turn.activation.ticketNumber : undefined,
      undefined,
    );

    // #632: private countersign ticket transport flag is gone (was write-only).
    const piArgv = buildPiTurnExtraArgs(turn, piDurablePrincipalAuthority);
    assert.equal(piArgv.includes("--ak-countersign-ticket-number"), false);
  });

  assert.throws(
    () => parsePublicSeatArgv("countersign", ["--ticket", "582", "裁"]),
    (error: unknown) =>
      error instanceof CliUsageError
      && /unknown countersign option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );
});

test("countersign argv rejects unknown options", async () => {
  assert.throws(
    () => parsePublicSeatArgv("countersign", ["--bogus", "裁"]),
    (error: unknown) => error instanceof CliUsageError,
  );
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const rejected = await runAkRole(["countersign", "--model", "test/caller-seat:high", "--bogus", "裁"],
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
      { status: "converged" as const, note: "署" },
      {
        status: "continue" as const,
        fix: { summary: "票面授权无可溯真源" },
      },
      {
        status: "escalate" as const,
        decisionGate: { question: "本票走哪条路？", options: ["a", "b"] },
      },
    ] as const;

    for (const [index, receipt] of receipts.entries()) {
      const { io } = captureIo();
      const runId = `01a0sign00-0000-7000-8000-${String(index).padStart(12, "0")}`;
      const result = await runAkRole(["countersign", "--model", "test/caller-seat:high", "--project", project, "裁：本票五问。"],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () => runId,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            // Court station runs 起居郎 first (#771); true-unbound for no-ticket body.
            piRunner: async (args, options) => {
              const role = argvFlagValue(args, "--ak-role");
              if (role === "diarist") {
                return courtPipelinePiRunner(null, receipt)(args, options);
              }
              const outcome = await scriptedCountersignSession(receipt)(args, options);
              // #634: scriptedTerminatingToolSession writes only the countersign
              // terminating receipt — it never opens a real pi role activation that
              // would summon Notary. Seed the direct officer volume the production
              // gate would leave, so Terminal projection still asserts typed seats.
              if (receipt.status === "converged") {
                const sessionFile = argvFlagValue(args, "--session");
                assert.ok(sessionFile);
                const auditorDir = join(dirname(sessionFile), "auditor-roles");
                await mkdir(auditorDir, { recursive: true });
                await writeFile(
                  join(auditorDir, "o01_notary.jsonl"),
                  gateToolSessionJsonl({
                    id: "direct-notary",
                    startedAt: "2026-09-04T00:00:00.000Z",
                    endedAt: "2026-09-04T00:00:10.000Z",
                    toolName: "ak_notary_output",
                    args: { status: "converged", findings: [] },
                  }),
                  "utf8",
                );
              }
              return outcome;
            },
          }),
        },
      );
      assert.equal(result.exitCode, 0, `receipt ${receipt.status}`);
      assert.ok(result.terminal, `receipt ${receipt.status}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), [receipt.status,
      ]);
      const facts = (objectPayloads(result.terminal.roleOutcome)[0] ?? {});
      assert.equal(facts.status, receipt.status);
      // #757: nested fields pass through — no lift to fixSummary/decisionQuestion.
      if (receipt.status === "continue") {
        const fix = facts.fix as { summary?: string } | undefined;
        assert.equal(fix?.summary, receipt.fix.summary);
      }
      if (receipt.status === "escalate") {
        const gate = facts.decisionGate as { question?: string; options?: string[] } | undefined;
        assert.equal(gate?.question, receipt.decisionGate.question);
        assert.deepEqual(gate?.options, [...receipt.decisionGate.options]);
      }
      if (receipt.status === "converged") {
        assert.equal(facts.note, receipt.note);
        assert.ok(result.terminal.gate);
        assert.deepEqual(result.terminal.gate!.actualSeats, ["notary"]);
        assert.equal(result.terminal.gate!.rounds[0]!.dispatch.kind, "direct");
        assert.equal(result.terminal.gate!.rounds[0]!.dispatch.officer, "notary");
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

test("ak-role resume continues countersign on the exact session", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000aa";
    // Ticket acceptance surface: interrupt first (unsealed), then resume lands a
    // distinct sealed verdict — not a vacuous re-read of a first-run seal (#599).
    const first = await runAkRole(["countersign", "--model", "test/caller-seat:high", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: withTrueUnboundDiarist(async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            await writeFile(sessionFile, "\n", "utf8");
            return {
              code: 1,
              stderr: "upstream timeout\n",
              timedOut: true,
              args: [...args],
            };
          }),
        }),
      },
    );
    assert.equal(first.exitCode, 1);
    assert.equal(first.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      first.terminal?.roleOutcome.kind === "failure"
        ? first.terminal.roleOutcome.cause
        : undefined,
      "timeout",
    );

    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "countersign",
      home,
    });
    const { io: resumeIo, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    let resumeStdin: string | undefined;
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        // Resume still refreshes 起居郎 (ADR 0075: 每次过庭都跑是调用者用法); true-unbound face.
        piRunner: withTrueUnboundDiarist(async (args, options) => {
          resumeArgs = [...args];
          resumeStdin = options.stdin;
          return scriptedCountersignSession({
            status: "converged",
            note: "RESUMED-续署",
          })(args, options);
        }),
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "countersign resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumeArgs![resumeArgs!.indexOf("--ak-role") + 1], "countersign");
    assert.equal(resumeArgs![resumeArgs!.indexOf("--session-dir") + 1], coords.sessionDirectory);
    assert.equal(resumeArgs!.includes("再裁一次"), false);
    assert.equal(readUserDialogueStdin(resumeStdin ?? ""), "再裁一次");
    assert.equal(resumed.terminal?.roleOutcome.role, "countersign");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["converged"],
    );
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? (objectPayloads(resumed.terminal.roleOutcome)[0] ?? {})
      : undefined;
    assert.equal(facts?.note, "RESUMED-续署");
  });
});

test("ak-role resume with message after sealed countersign dispatches a new court (#833)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000ab";
    const first = await runAkRole(["countersign", "--model", "test/caller-seat:high", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: withTrueUnboundDiarist(
            scriptedCountersignSession({
              status: "converged",
              note: "FIRST-署",
            }),
          ),
        }),
      },
    );
    assert.equal(first.exitCode, 0);
    assert.equal(
      first.terminal?.roleOutcome.kind === "accepted"
        ? (objectPayloads(first.terminal.roleOutcome)[0] ?? {}).note
        : undefined,
      "FIRST-署",
    );

    let resumeDispatches = 0;
    let resumeArgs: string[] | undefined;
    let resumeStdin: string | undefined;
    const { io: resumeIo, stdout } = captureIo();
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          resumeDispatches += 1;
          resumeArgs = [...args];
          resumeStdin = options.stdin;
          return scriptedCountersignSession({
            status: "continue",
            fix: { summary: "RESUMED-再审" },
          })(args, options);
        },
      }),
    });
    assert.equal(resumeDispatches, 1, "sealed resume with message must reach the host");
    assert.equal(resumeArgs!.includes("再裁一次"), false);
    assert.equal(readUserDialogueStdin(resumeStdin ?? ""), "再裁一次");
    assert.equal(resumed.exitCode, 0, stdout.join("") || "sealed countersign resume failed");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(resumed.terminal?.roleOutcome.payloads, [
      { status: "continue", fix: { summary: "RESUMED-再审" } },
    ]);
    assert.deepEqual(resumed.terminal?.submissions, [
      { status: "converged", note: "FIRST-署" },
      { status: "continue", fix: { summary: "RESUMED-再审" } },
    ]);
  });
});

test("countersign resume timeout is not masked by a prior-attempt residual", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000ac";
    const first = await runAkRole(["countersign", "--model", "test/caller-seat:high", "--project", project, "裁"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: withTrueUnboundDiarist(
            scriptedTerminatingToolSession({
              role: "countersign",
              toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
              details: { status: "converged", note: "PRIOR-residual" },
              isError: true,
              acceptedText: "PRIOR-attempt-residual-error",
            }),
          ),
        }),
      },
    );
    assert.equal(first.exitCode, 1);
    assert.equal(first.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      first.terminal?.roleOutcome.kind === "failure"
        ? first.terminal.roleOutcome.cause
        : undefined,
      "output",
    );

    const { io: resumeIo, stdout } = captureIo();
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId, "再试"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: withTrueUnboundDiarist(async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          // Append a resumed user turn; keep the prior residual so the scan
          // boundary is exercised (production resume appends, does not wipe).
          await writeSessionJsonl(
            sessionFile,
            [sessionUserMessageRow("user-resume", "再试", 60)],
            "append",
          );
          return {
            code: 1,
            stderr: "upstream timeout\n",
            timedOut: true,
            args: [...args],
          };
        }),
      }),
    });
    assert.equal(resumed.exitCode, 1, stdout.join("") || "resume timeout path failed");
    assert.equal(resumed.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "failure"
        ? resumed.terminal.roleOutcome.cause
        : undefined,
      "timeout",
      "prior-attempt residual must not mask current resume timeout",
    );
  });
});

/** Countersign-bound exchange over the shared session row writer (#843). */
function csExchange(input: {
  readonly stem: string;
  readonly parentId: string;
  readonly callId: string;
  readonly details: unknown;
  readonly body: string;
  readonly isError: boolean | "omit";
  readonly n: number;
  readonly bound?: boolean;
}) {
  return sessionToolExchangeRows({
    ...input,
    toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
  });
}

function countersignScriptedHost(piRunner: LegacyFauxPiRunner) {
  return roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: withTrueUnboundDiarist(piRunner),
  });
}

function notaryBounceError(findings: readonly string[]) {
  return new GatekeeperDecisionError({
    status: "continue",
    officer: "notary",
    receipt: { status: "continue", findings: [...findings] },
  });
}

async function recordCountersignBounce(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly details: unknown;
  readonly toolCallId: string;
  readonly findings: readonly string[];
}): Promise<void> {
  await recordNonSealedSubmissionForSpawn({
    cwd: input.cwd,
    env: input.env,
    role: "countersign",
    details: input.details,
    toolCallId: input.toolCallId,
    executeError: notaryBounceError(input.findings),
  });
}

/** Append one user turn with optional decoy rows + bound residual bounce. */
async function appendResidualBounceTurn(input: {
  readonly sessionFile: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly userContent: string;
  readonly callId: string;
  readonly details: unknown;
  readonly body: string;
  readonly findings: readonly string[];
  readonly n: number;
  readonly extraRows?: readonly unknown[];
}): Promise<void> {
  await writeSessionJsonl(
    input.sessionFile,
    [
      sessionUserMessageRow(input.userId, input.userContent, input.n),
      ...(input.extraRows ?? []),
      ...csExchange({
        stem: `${input.userId}-bounce`,
        parentId: input.userId,
        callId: input.callId,
        details: input.details,
        body: input.body,
        isError: true,
        n: input.n + 3,
      }),
    ],
    "append",
  );
  await recordCountersignBounce({
    cwd: input.cwd,
    env: input.env,
    details: input.details,
    toolCallId: input.callId,
    findings: input.findings,
  });
}

/**
 * #843: shared seat settlement — court-scoped resume (message) bounce then sealed
 * accept stays accepted; gate bounce→pass rounds keep status/findings; bare resume
 * bounce after a prior accept is not masked by run-scoped stale acceptance; reverse
 * same-turn accept then bounce keeps rejection facts on payloads/gate.
 */
test("#843 same-attempt correctable-rejection residual does not outrank later sealed accepted",
  async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const seedAccepted = {
      status: "converged" as const,
      note: "PRIOR-COURT-SEED",
    };
    const rejected = {
      status: "continue" as const,
      fix: { summary: "REJECTED-FIRST-findings-visible" },
    };
    const accepted = {
      status: "converged" as const,
      note: "ACCEPTED-AFTER-CORRECTION",
    };
    const rejectionBody = "CORRECTABLE-REJECTION-RESIDUAL-BODY";
    const laterBounceBody = "SECOND-TURN-BOUNCE-BODY";
    const reverseBounceBody = "REVERSE-ORDER-BOUNCE-BODY";
    const gateFindings = ["REJECTED-FIRST-findings-visible"] as const;
    const reverseGateFindings = ["BOUNCED-AFTER-ACCEPT-VISIBLE"] as const;
    const runId = "01a0sign00-0000-7000-8000-000000000843";
    const seatModel = ["--model", "test/caller-seat:high"] as const;

    type SeedGateRound = {
      readonly id: string;
      readonly startedAt: string;
      readonly endedAt: string;
      readonly status: "continue" | "converged";
      readonly findings: readonly string[];
    };
    const gateRound = (
      id: string,
      startN: number,
      status: "continue" | "converged",
      findings: readonly string[],
    ): SeedGateRound => ({
      id,
      startedAt: sessionRowTime(startN).iso,
      endedAt: sessionRowTime(startN + 10).iso,
      status,
      findings,
    });
    const seedGateRounds = async (
      sessionFile: string,
      rounds: readonly SeedGateRound[],
    ): Promise<void> => {
      const auditorDir = join(dirname(sessionFile), "auditor-roles");
      await mkdir(auditorDir, { recursive: true });
      for (let i = 0; i < rounds.length; i += 1) {
        const round = rounds[i]!;
        await writeFile(
          join(auditorDir, `o${String(i + 1).padStart(2, "0")}_notary.jsonl`),
          gateToolSessionJsonl({
            id: round.id,
            startedAt: round.startedAt,
            endedAt: round.endedAt,
            toolName: "ak_notary_output",
            args: { status: round.status, findings: [...round.findings] },
          }),
          "utf8",
        );
      }
    };
    const bounceThenPassGates = [
      gateRound("direct-notary-bounce", 1000, "continue", gateFindings),
      gateRound("direct-notary-pass", 1020, "converged", []),
    ] as const;
    const passThenBounceGates = [
      gateRound("direct-notary-pass-rev", 2000, "converged", []),
      gateRound("direct-notary-bounce-rev", 2020, "continue", reverseGateFindings),
    ] as const;

    const runScripted = (
      argv: string[],
      piRunner: LegacyFauxPiRunner,
      createRunId?: () => string,
    ) => {
      const cap = captureIo();
      return {
        cap,
        done: runAkRole(argv, {
          home,
          packageRoot,
          cwd: project,
          io: cap.io,
          ...(createRunId === undefined ? {} : { createRunId }),
          roleTurnHost: countersignScriptedHost(piRunner),
        }),
      };
    };

    // Seed a sealed prior court so resume-with-message mints courtAttemptId (#833).
    const seed = runScripted(
      ["countersign", ...seatModel, "--project", project, "裁"],
      scriptedCountersignSession(seedAccepted),
      () => runId,
    );
    const seeded = await seed.done;
    assert.equal(
      seeded.exitCode,
      0,
      seed.cap.stdout.join("") || seed.cap.stderr.join("") || "seed court must accept",
    );

    // 1) Same court/attempt via resume+message: bounce then sealed accept → accepted / exit 0.
    // sealedLedgerOutcome reads attempt-scoped rows when courtAttemptId is present.
    let sawCourtAttemptId = false;
    const { cap, done } = runScripted(
      ["resume", ...seatModel, runId, "再裁"],
      async (args, options) => {
        const courtAttemptId = options.env.AK_ROLE_COURT_ATTEMPT;
        if (typeof courtAttemptId === "string" && courtAttemptId.length > 0) {
          sawCourtAttemptId = true;
        }
        const sessionFile = args[args.indexOf("--session") + 1]!;
        await writeSessionJsonl(
          sessionFile,
          [
            sessionUserMessageRow("user-court", "再裁", 40),
            ...csExchange({
              stem: "reject",
              parentId: "user-court",
              callId: "call-reject",
              details: rejected,
              body: rejectionBody,
              isError: true,
              n: 41,
            }),
            ...csExchange({
              stem: "accept",
              parentId: "result-reject",
              callId: "call-accept",
              details: accepted,
              body: "countersign output accepted",
              isError: false,
              n: 43,
            }),
          ],
          "append",
        );
        await recordCountersignBounce({
          cwd: options.cwd,
          env: options.env,
          details: rejected,
          toolCallId: "call-reject",
          findings: gateFindings,
        });
        await sealAcceptedSubmissionForSpawn({
          cwd: options.cwd,
          env: options.env,
          role: "countersign",
          details: accepted,
          toolCallId: "call-accept",
        });
        await seedGateRounds(sessionFile, bounceThenPassGates);
        return { code: 0, timedOut: false, stderr: "", args: [...args] };
      },
    );
    const result = await done;

    assert.equal(
      sawCourtAttemptId,
      true,
      "resume with message must mint courtAttemptId for attempt-scoped ledger",
    );
    assert.equal(
      result.exitCode,
      0,
      cap.stdout.join("") || cap.stderr.join("") || "expected accepted exit 0",
    );
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    // This-court payloads only when courtAttemptId is present (#879).
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), [
      "continue",
      "converged",
    ]);
    const payloads = objectPayloads(result.terminal.roleOutcome);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0]!.status, "continue");
    assert.equal(
      (payloads[0]!.fix as { summary?: string } | undefined)?.summary,
      "REJECTED-FIRST-findings-visible",
    );
    assert.equal(payloads[1]!.status, "converged");
    assert.equal(payloads[1]!.note, "ACCEPTED-AFTER-CORRECTION");
    // submissions stay run-scoped (#836): prior seed + this-court bounce/accept.
    assert.deepEqual(result.terminal.submissions, [seedAccepted, rejected, accepted]);
    assert.ok(result.terminal.gate);
    assert.deepEqual(result.terminal.gate!.actualSeats, ["notary"]);
    assert.equal(result.terminal.gate!.rounds.length, 2);
    assert.equal(result.terminal.gate!.rounds[0]!.dispatch.kind, "direct");
    assert.equal(result.terminal.gate!.rounds[0]!.dispatch.officer, "notary");
    assert.equal(result.terminal.gate!.rounds[0]!.officer.status, "continue");
    assert.deepEqual(result.terminal.gate!.rounds[0]!.officer.findings, [...gateFindings]);
    assert.equal(result.terminal.gate!.rounds[1]!.officer.status, "converged");
    assert.deepEqual(result.terminal.gate!.rounds[1]!.officer.findings, []);

    // 2 / 2b / 2c) Bare resume residual bounces must stay failure — plain bounce,
    // bound missing-isError decoy, and unbound isError:false decoy must not wash
    // the current residual via run-scoped stale accepted.
    const residualBounceCases = [
      {
        label: "bare-resume",
        userId: "user-resume",
        callId: "call-resume-bounce",
        body: laterBounceBody,
        findings: ["SECOND-TURN-ONLY-BOUNCE"] as const,
        summary: "SECOND-TURN-ONLY-BOUNCE",
        n: 60,
        extraRows: undefined as readonly unknown[] | undefined,
      },
      {
        label: "bound-missing-isError",
        userId: "user-resume-missing-isError",
        callId: "call-resume-missing-isError-bounce",
        body: "MISSING-ISERROR-STILL-BOUNCE-BODY",
        findings: ["bound-missing-isError"] as const,
        summary: "bound-missing-isError",
        n: 70,
        // bound decoy omits isError — must not establish success
        extraRows: csExchange({
          stem: "resume-missing-isError-decoy",
          parentId: "user-resume-missing-isError",
          callId: "call-resume-missing-isError-decoy",
          details: accepted,
          body: "missing-isError decoy",
          isError: "omit",
          n: 71,
        }),
      },
      {
        label: "unbound-isError-false",
        userId: "user-resume-unbound-false",
        callId: "call-resume-unbound-false-bounce",
        body: "UNBOUND-FALSE-STILL-BOUNCE-BODY",
        findings: ["unbound-isError-false"] as const,
        summary: "unbound-isError-false",
        n: 80,
        // orphan toolResult only — no matching assistant toolCall
        extraRows: csExchange({
          stem: "resume-unbound-false-decoy",
          parentId: "user-resume-unbound-false",
          callId: "call-resume-unbound-false-orphan",
          details: accepted,
          body: "unbound isError:false decoy",
          isError: false,
          n: 81,
          bound: false,
        }),
      },
    ] as const;

    for (const caseSpec of residualBounceCases) {
      const caseBounce = {
        status: "continue" as const,
        fix: { summary: caseSpec.summary },
      };
      const caseRun = runScripted(
        ["resume", ...seatModel, runId],
        async (args, options) => {
          await appendResidualBounceTurn({
            sessionFile: args[args.indexOf("--session") + 1]!,
            cwd: options.cwd,
            env: options.env,
            userId: caseSpec.userId,
            userContent: caseSpec.label,
            callId: caseSpec.callId,
            details: caseBounce,
            body: caseSpec.body,
            findings: caseSpec.findings,
            n: caseSpec.n,
            ...(caseSpec.extraRows === undefined
              ? {}
              : { extraRows: caseSpec.extraRows }),
          });
          return { code: 0, timedOut: false, stderr: "", args: [...args] };
        },
      );
      const caseResumed = await caseRun.done;
      assert.equal(
        caseResumed.exitCode,
        1,
        caseRun.cap.stdout.join("") ||
          caseRun.cap.stderr.join("") ||
          `${caseSpec.label} must stay failure`,
      );
      assert.equal(caseResumed.terminal?.roleOutcome.kind, "failure");
      assert.equal(
        caseResumed.terminal?.roleOutcome.kind === "failure"
          ? caseResumed.terminal.roleOutcome.diagnostic
          : undefined,
        caseSpec.body,
      );
    }

    // 3) Reverse same-turn order (accepted first, bounce later): terminal may
    // stay accepted, but rejection facts must remain on payloads and gate.
    const reverseAccepted = {
      status: "converged" as const,
      note: "ACCEPTED-FIRST-REVERSE",
    };
    const reverseBounced = {
      status: "continue" as const,
      fix: { summary: "BOUNCED-AFTER-ACCEPT-VISIBLE" },
    };
    const reverseRunId = "01a0sign00-0000-7000-8000-000000000844";
    const reverseRun = runScripted(
      ["countersign", ...seatModel, "--project", project, "再裁"],
      async (args, options) => {
        const sessionFile = args[args.indexOf("--session") + 1]!;
        await writeSessionJsonl(sessionFile, [
          sessionUserMessageRow("user-rev", "reverse", 120),
          ...csExchange({
            stem: "rev-accept",
            parentId: "user-rev",
            callId: "call-rev-accept",
            details: reverseAccepted,
            body: "countersign output accepted",
            isError: false,
            n: 121,
          }),
          {
            type: "custom",
            customType: "ak-role-submission-closure",
            data: { toolName: COUNTERSIGN_OUTPUT_TOOL_NAME, isError: false, details: reverseAccepted },
            id: "closure-rev-accept",
            parentId: "result-rev-accept",
            timestamp: sessionRowTime(122).iso,
          },
          ...csExchange({
            stem: "rev-bounce",
            parentId: "result-rev-accept",
            callId: "call-rev-bounce",
            details: reverseBounced,
            body: reverseBounceBody,
            isError: true,
            n: 123,
          }),
        ]);
        await sealAcceptedSubmissionForSpawn({
          cwd: options.cwd,
          env: options.env,
          role: "countersign",
          details: reverseAccepted,
          toolCallId: "call-rev-accept",
        });
        await recordCountersignBounce({
          cwd: options.cwd,
          env: options.env,
          details: reverseBounced,
          toolCallId: "call-rev-bounce",
          findings: ["BOUNCED-AFTER-ACCEPT-VISIBLE"],
        });
        await seedGateRounds(sessionFile, passThenBounceGates);
        return { code: 0, timedOut: false, stderr: "", args: [...args] };
      },
      () => reverseRunId,
    );
    const reversed = await reverseRun.done;
    assert.equal(
      reversed.exitCode,
      0,
      reverseRun.cap.stdout.join("") ||
        reverseRun.cap.stderr.join("") ||
        "reverse order keeps accepted exit 0",
    );
    assert.equal(reversed.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(reversed.terminal!.roleOutcome), [
      "converged",
      "continue",
    ]);
    const reversePayloads = objectPayloads(reversed.terminal!.roleOutcome);
    assert.equal(reversePayloads[0]!.note, "ACCEPTED-FIRST-REVERSE");
    assert.equal(
      (reversePayloads[1]!.fix as { summary?: string } | undefined)?.summary,
      "BOUNCED-AFTER-ACCEPT-VISIBLE",
    );
    assert.ok(reversed.terminal!.gate);
    assert.equal(reversed.terminal!.gate!.rounds.length, 2);
    assert.equal(reversed.terminal!.gate!.rounds[0]!.officer.status, "converged");
    assert.deepEqual(reversed.terminal!.gate!.rounds[0]!.officer.findings, []);
    assert.equal(reversed.terminal!.gate!.rounds[1]!.officer.status, "continue");
    assert.deepEqual(
      reversed.terminal!.gate!.rounds[1]!.officer.findings,
      [...reverseGateFindings],
    );
  });
});

/**
 * #709 ticket identity reuse from the real public countersign entry.
 * Shared project fixture; typed fields only (no prompt-wording assertions).
 */

async function withCountersignProject(
  run: (ctx: { home: string; project: string }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );
    await installGhFixture(join(home, "bin"), {
      issues: {
        582: { body: "issue 582 body", comments: [] },
        82: { body: "issue 82 body", comments: [] },
      },
    });
    await run({ home, project });
  });
}

function admittedCountersign(
  admitted: AdmittedRoleInvocation | undefined,
): AdmittedCountersignInvocation {
  if (admitted?.role !== "countersign") {
    throw new Error("countersign entry did not admit countersign");
  }
  return admitted;
}

function countersignPathEnv(input: {
  home: string;
  project: string;
  runId: string;
  onTurn?: (request: RoleTurnRequest) => void;
  blockTurn?: boolean;
  /** Typed 起居郎 handoff (or no-op). Body-path tests isolate nested seat. */
  runCourtDiaristStation?: (
    admitted: AdmittedCountersignInvocation,
  ) => Promise<void>;
}): CountersignRunEnv {
  const host = input.blockTurn
    ? {
        async executeTurn() {
          throw new Error("turn must not start");
        },
      }
    : (() => {
        const base = roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedCountersignSession({
            status: "converged",
            note: "署",
          }),
        });
        return {
          async executeTurn(request: RoleTurnRequest) {
            input.onTurn?.(request);
            return base.executeTurn(request);
          },
        };
      })();
  return {
    home: input.home,
    agentDir: join(input.home, ".pi"),
    packageRoot,
    cwd: input.project,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    roleTurnHost: host,
    createRunId: () => input.runId,
    // Body-path tests isolate the nested 起居郎 seat; #742 station proofs use production env.
    runCourtDiaristStation:
      input.runCourtDiaristStation ?? (async () => undefined),
  };
}

test("public countersign path: --ticket is unknown-option reject (exit 2)", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const result = await runPublicInstructionSeat(
      ["--ticket", "582", "裁：本票是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p01",
        blockTurn: true,
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.admitted, undefined);
  });
});

test("public countersign path: invalid attachment rejects before identity or run persistence", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const runId = "01a0sign00-0000-7000-8000-000000000bad";
    let identityCalls = 0;
    const result = await runPublicInstructionSeat(
      ["--attach", join(project, "missing.md"), "裁：附件无效。"],
      countersignPathEnv({
        home,
        project,
        runId,
        blockTurn: true,
        runCourtDiaristStation: async () => {
          identityCalls += 1;
        },
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.admitted, undefined);
    assert.equal(identityCalls, 0);
    const placement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey: resolveBookKeyFromGit(project),
      subject: { unbound: true },
      runId,
      role: "countersign",
    });
    await assert.rejects(readFile(join(placement.runDirectory, "invocation.json")));
  });
});

test("public countersign path: 起居郎 typed handoff binds ticket; dossier volume stays readable", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // Volume may pre-exist; binding still requires 起居郎 typed assertion (#771).
    ensureTicketProvenanceVolume(582, project, home);
    let turnTicket: number | undefined;
    const result = await runPublicInstructionSeat(
      ["裁：继续审票 #582 是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p02",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
        runCourtDiaristStation: async (admitted) => {
          await bindAdmittedTicketNumber(admitted, 582);
        },
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(turnTicket, 582);
    const inv = JSON.parse(
      await readFile(join(result.admitted!.runDirectory, "invocation.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(inv.ticketNumber, 582);
    const volume = await readTicketProvenance(582, project, home);
    assert.ok(volume.recordFile);
    await readFile(volume.recordFile, "utf8");
  });
});

test("public countersign path: no 起居郎 handoff stays unbound (真无票 face)", async () => {
  await withCountersignProject(async ({ home, project }) => {
    let turnTicket: number | undefined;
    const result = await runPublicInstructionSeat(
      ["一般性程序问询，本庭无具体票号。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p04",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(turnTicket, undefined);
    const state = await readRoleRunState(
      result.admitted!.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.role, "countersign");
    assert.equal(state?.runDirectory, result.admitted!.runDirectory);
  });
});

test("public countersign path: summons text alone never mints a ticket without 起居郎 assertion", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // Book has #82; summons mentions #582 — code must not match either.
    ensureTicketProvenanceVolume(82, project, home);
    let turnTicket: number | undefined;
    const result = await runPublicInstructionSeat(
      ["裁：票 #582 / 邻 #82 是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p03",
        onTurn: (req) => {
          turnTicket =
            req.activation.role === "countersign" ? req.activation.ticketNumber : undefined;
        },
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(turnTicket, undefined);
  });
});

/**
 * Multi-role faux pi: diarist envelope when --ak-role diarist, else countersign.
 * ticketAssertion: positive N = 本庭对象; null = true-unbound; "escalate" = 认不出;
 * or escalate object (may carry ticketNumber / other receipt facts — #953).
 * courtTicketNumbers: #871 optional typed co-review set on identity turns only.
 * Bound refresh (`整理 #N 的本案依据。`) asserts ticket N so each member volume is real.
 */
type CourtDiaristTicketAssertion =
  | number
  | null
  | "escalate"
  | {
      readonly status: "escalate";
      readonly reason: string;
      readonly ticketNumber?: number;
    };

function courtPipelinePiRunner(
  ticketAssertion: CourtDiaristTicketAssertion = 582,
  countersignDetails: unknown = {
    status: "converged",
    note: "署",
  },
  courtTicketNumbers?: readonly number[],
  recordBeforeEscalate?: string,
): LegacyFauxPiRunner {
  return async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "diarist") {
      let registered:
        | {
            readonly name: string;
            execute(
              toolCallId: string,
              parameters: unknown,
              signal: undefined,
              onUpdate: undefined,
              ctx: HostContext,
            ): Promise<{ details?: unknown }>;
          }
        | undefined;
      const host = {
        registerTool(tool: unknown) {
          registered = tool as typeof registered;
        },
        on() {},
        getAllTools: () =>
          registered === undefined ? [] : [{ name: registered.name }],
      } as unknown as RoleHost;
      const runDir = options.env.AK_ROLE_RUN_DIR ?? "";
      const runtime = createDiaristRoleRuntime(host, {
          loadSoul: async () => "起居郎职分（测试装载）",
        });
        await runtime.activate();
        assert.ok(registered, "diarist envelope registered no output tool");
        // Bound refresh places the child under the member ticket dir; identity stays unbound.
        // Prefer durable run placement over argv prose (instruction is not a stable argv leaf).
        const ticketDirMatch = /[\\/](\d+)[\\/]runs[\\/][^\\/]+@diarist$/.exec(runDir);
        const boundTicket =
          ticketDirMatch !== null ? Number(ticketDirMatch[1]) : undefined;
        // 起居郎 LLM asserts the court target; envelope binds typed key (#771 / #779).
        const escalateParams =
          typeof ticketAssertion === "object" &&
          ticketAssertion !== null &&
          ticketAssertion.status === "escalate"
            ? ticketAssertion
            : ticketAssertion === "escalate"
              ? { status: "escalate" as const, reason: "cannot identify court target" }
              : undefined;
        const params =
          boundTicket !== undefined
            ? {
                status: "completed" as const,
                ticketNumber: boundTicket,
                sessions: [] as const,
              }
            : escalateParams !== undefined
              ? escalateParams
              : ticketAssertion === null
                ? { status: "completed" as const, ticketNumber: null, sessions: [] as const }
                : {
                    status: "completed" as const,
                    ticketNumber: ticketAssertion as number,
                    sessions: [] as const,
                    ...(courtTicketNumbers === undefined
                      ? {}
                      : { courtTicketNumbers: [...courtTicketNumbers] }),
                  };
      if (recordBeforeEscalate !== undefined) {
        await registered.execute(
          "call_diarist_record",
          { status: "completed", ticketNumber: null,
            sessions: [{ path: recordBeforeEscalate, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
          }, undefined, undefined, { runDirectory: runDir } as HostContext,
        );
      }
      const accepted = await registered.execute(
        "call_diarist_1",
        params,
        undefined,
        undefined,
        { runDirectory: runDir } as HostContext,
      );
      return scriptedTerminatingToolSession({
        role: "diarist",
        toolName: DIARIST_OUTPUT_TOOL_NAME,
        details: accepted.details,
      })(args, options);
    }
    return scriptedCountersignSession(countersignDetails)(args, options);
  };
}

test("public CLI keeps ticket, unbound, first-binding, run records, and all readers on one book topology", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // #771 LLM assert + #742 court diarist station; volume may or may not pre-exist.
    ensureTicketProvenanceVolume(582, project, home);
    // Temp-home seat row only — never write the real ~/.ak-roles table.
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      publicCliConfigPath(home),
      `${JSON.stringify({
        seats: { diarist: { provider: "openai-codex", model: "gpt-5.6-sol", host: "grok-build" } },
      })}\n`,
      "utf8",
    );

    const parentRoles: string[] = [];
    const childRoles: string[] = [];
    let countersignRunDirectory = "";
    const parentBase = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner(),
    });
    const parentHost = {
      async executeTurn(request: RoleTurnRequest) {
        parentRoles.push(request.activation.role);
        if (request.activation.role === "countersign") {
          countersignRunDirectory = request.runDirectory;
        }
        const outcome = await parentBase.executeTurn(request);
        if (request.activation.role === "countersign") {
          const auditorDir = join(request.runDirectory, "session", "auditor-roles");
          await mkdir(auditorDir, { recursive: true });
          await writeFile(
            join(auditorDir, "o01_notary.jsonl"),
            gateToolSessionJsonl({
              id: "topology-notary",
              startedAt: "2026-09-11T00:00:00.000Z",
              endedAt: "2026-09-11T00:00:01.000Z",
              toolName: "ak_notary_output",
              args: { status: "converged", findings: [] },
            }),
            "utf8",
          );
        }
        return outcome;
      },
    };
    let observedDiaristRunId = "";
    const childBase = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner(),
    });
    const childHost = {
      async executeTurn(request: RoleTurnRequest) {
        childRoles.push(request.activation.role);
        observedDiaristRunId = basename(request.runDirectory).split("@")[0]!;
        return childBase.executeTurn(request);
      },
    };

    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["countersign", "--model", "test/caller-seat:high", "--project", project, "裁：继续审票 #582 是否足以开工。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: parentHost,
        hostAdapters: [
          adapter("pi", parentHost),
          adapter("grok-build", childHost),
        ],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000d45",
        io,
      },
    );
    assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));
    assert.deepEqual(parentRoles, ["countersign"], "parent adapter must not execute the court diarist child");
    assert.deepEqual(childRoles, ["diarist", "diarist"], "child seat adapter must execute court diarist station");
    const bookKey = resolveBookKeyFromGit(project);

    assert.ok(observedDiaristRunId);
    const diaristCoords = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey,
      subject: { ticketNumber: 582 },
      runId: observedDiaristRunId,
      role: "diarist",
    });
    const diaristState = await readRoleRunState(
      diaristCoords.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(diaristState?.role, "diarist");
    assert.equal(diaristState?.state, "terminal");

    const diaristInvocation = JSON.parse(
      await readFile(join(diaristCoords.runDirectory, "invocation.json"), "utf8"),
    ) as { host?: string; model?: string; provider?: string };
    assert.equal(
      diaristInvocation.host,
      "grok-build",
      "court diarist station child must record own seat host",
    );
    assert.equal(
      diaristInvocation.provider,
      "openai-codex",
      "court diarist station child must record own seat provider",
    );
    assert.equal(
      diaristInvocation.model,
      "gpt-5.6-sol",
      "court diarist station child must record own seat model",
    );

    const bookRoot = join(home, ".ak-roles", "books", bookKey);
    const ticketRun = join(bookRoot, "582", "runs", `${result.terminal!.runId}@countersign`);
    assert.equal(countersignRunDirectory, ticketRun);
    assert.equal(
      diaristCoords.runDirectory.startsWith(join(bookRoot, "582", "runs")),
      true,
      "the first ticket-identifying leg is relocated after its typed assertion",
    );
    assert.equal(
      existsSync(
        join(bookRoot, "unbound", "runs", `${observedDiaristRunId}@diarist`),
      ),
      false,
      "relocate must remove the unbound admission leaf (not copy-and-leave)",
    );

    assert.deepEqual(result.terminal?.gate?.actualSeats, ["notary"]);
    await readFile(join(ticketRun, "session", "auditor-roles", "o01_notary.jsonl"), "utf8");

    // #987 Result 7: public re-summons without parentRunPath always mints a new
    // countersign run (no ticketNumber same-ticket selection). Gate same-parent
    // resume stays on parentRunPath; callers continue an old public run via
    // explicit `ak-role resume <runId>`.
    const reminted = await runAkRole(
      ["countersign", "--model", "test/caller-seat:high", "--project", project, "裁：继续复审 #582。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: parentHost,
        hostAdapters: [adapter("pi", parentHost), adapter("grok-build", childHost)],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000d46",
        io: captureIo().io,
      },
    );
    assert.equal(reminted.exitCode, 0);

    const unboundId = "01a0sign00-0000-7000-8000-00000000free";
    let unboundRunDirectory = "";
    const unboundBase = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "judge",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        details: { status: "converged" },
      }),
    });
    const unbound = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "Decide without a ticket."],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => unboundId,
        roleTurnHost: {
          async executeTurn(request: RoleTurnRequest) {
            unboundRunDirectory = request.runDirectory;
            return unboundBase.executeTurn(request);
          },
        },
      },
    );
    assert.equal(unbound.exitCode, 0);
    assert.equal(unboundRunDirectory, join(bookRoot, "unbound", "runs", `${unboundId}@judge`));
    const submissionRecord = join(unboundRunDirectory, "session", "submission-ledger", "records.jsonl");
    await readFile(submissionRecord, "utf8");
    const recorded = await readRecordedSubmissionRows(project, unboundId, home);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.role, "judge");
    assert.deepEqual(recorded[0]!.accepted, { status: "converged" });

    assert.ok(unbound.terminal?.artifacts.length);
    for (const artifact of unbound.terminal!.artifacts) {
      assert.equal(artifact.path.startsWith(join(unboundRunDirectory, "artifacts")), true);
      await readFile(artifact.path, "utf8");
    }

    // #863 / #859: work-seat self-report — admission unbound → bind → in-home relocate.
    const coderId = "01a0sign00-0000-7000-8000-0000000coder";
    const coderUnboundRun = join(bookRoot, "unbound", "runs", `${coderId}@coder`);
    const peerRun = join(bookRoot, "unbound", "runs", "01a0sign00-0000-7000-8000-00000000peer@judge");
    await mkdir(peerRun, { recursive: true });
    const peerPage = `${JSON.stringify({ runDirectory: peerRun, sourceRun: { runDirectory: coderUnboundRun } }, null, 2)}\n`;
    await writeFile(
      join(peerRun, "admitted-request.json"),
      peerPage,
      "utf8",
    );
    const coderBase = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "coder",
        toolName: CODER_OUTPUT_TOOL_NAME,
        details: {
          status: "completed",
          report: "work-seat typed self-report",
          ticketNumber: 582,
        },
      }),
    });
    let coderAdmissionDirectory = "";
    const coder = await runAkRole(
      ["coder", "--model", "test/caller-seat:high", "--project", project, "Implement ticket work."],
      {
        home,
        packageRoot,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: captureIo().io,
        createRunId: () => coderId,
        roleTurnHost: {
          async executeTurn(request: RoleTurnRequest) {
            coderAdmissionDirectory = request.runDirectory;
            return coderBase.executeTurn(request);
          },
        },
      },
    );
    assert.equal(coder.exitCode, 0);
    assert.equal(
      coderAdmissionDirectory,
      join(bookRoot, "unbound", "runs", `${coderId}@coder`),
      "work seat admits under unbound before typed self-report bind",
    );
    const coderTicketRun = join(bookRoot, "582", "runs", `${coderId}@coder`);
    assert.equal(
      existsSync(coderTicketRun),
      true,
      "work seat relocates in-home after first legal typed ticket bind",
    );
    assert.equal(
      existsSync(coderAdmissionDirectory),
      false,
      "work seat relocate must remove the unbound admission leaf (not copy-and-leave)",
    );
    const coderAdmitted = JSON.parse(
      await readFile(join(coderTicketRun, "admitted-request.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(coderAdmitted.ticketNumber, 582);
    const resumedIdentity = await readRoleRunState(
      coderTicketRun,
      piDurablePrincipalAuthority,
    );
    assert.equal(resumedIdentity?.runDirectory, coderTicketRun);
    assert.equal(
      await readFile(join(peerRun, "admitted-request.json"), "utf8"),
      peerPage,
      "online relocate must not read or overwrite an unleased peer page",
    );
    const relocatedFromDurableLocator = await resolveNotarySourceRunLocator({
      projectRoot: project,
      sourceRun: coderUnboundRun,
      home,
    });
    assert.equal(
      relocatedFromDurableLocator.runDirectory,
      coderTicketRun,
      "a typed durable locator must follow the run identity after relocation",
    );
    assert.ok(coder.terminal?.artifacts.length);
    for (const artifact of coder.terminal!.artifacts) {
      assert.equal(
        artifact.path.startsWith(join(coderTicketRun, "artifacts")),
        true,
        "relocated terminal artifacts must expose the live ticket-scoped paths",
      );
      await readFile(artifact.path, "utf8");
    }

    const allowedBookEntries = new Set(["582", "unbound", "navigator", "collector-handbook"]);
    for (const entry of await readdir(bookRoot)) {
      assert.equal(allowedBookEntries.has(entry), true, entry);
    }
    const countersignLeaves = [
      ...(await readdir(join(bookRoot, "582", "runs"))),
      ...(await readdir(join(bookRoot, "unbound", "runs"))),
    ]
      .filter((entry) => entry.endsWith("@countersign"))
      .sort();
    assert.deepEqual(
      countersignLeaves,
      [
        `${result.terminal!.runId}@countersign`,
        "01a0sign00-0000-7000-8000-000000000d46@countersign",
      ].sort(),
      "public re-summons without parentRunPath mint a second countersign run under the typed ticket",
    );
  });
});

test("public countersign path: identity-time source mutation cannot change the admitted snapshot", async () => {
  await withCountersignProject(async ({ home, project }) => {
    ensureTicketProvenanceVolume(582, project, home);
    const source = join(project, "ticket.md");
    await writeFile(source, "before identity", "utf8");
    let identityMutated = false;
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        if (argvFlagValue(args, "--ak-role") === "diarist" && !identityMutated) {
          identityMutated = true;
          await rm(source);
        }
        return courtPipelinePiRunner()(args, options);
      },
    });

    const result = await runPublicInstructionSeat(
      ["--attach", source, "裁：继续审票 #582。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000snap",
        host: "pi",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(identityMutated, true);
    assert.equal(
      await readFile(result.admitted!.attachments[0]!.frozenPath, "utf8"),
      "before identity",
    );
  });
});

test("A2: exhausted court diarist station is not re-run by parent auto-resume", async () => {
  await withCountersignProject(async ({ home, project }) => {
    ensureTicketProvenanceVolume(582, project, home);
    let diaristTurns = 0;
    let parentTurns = 0;
    const successChild = courtPipelinePiRunner();
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = argvFlagValue(args, "--ak-role");
        if (role === "diarist") {
          diaristTurns += 1;
          if (diaristTurns === 1) return successChild(args, options);
          const sd = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sd, { recursive: true });
          const sf = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sf,
            JSON.stringify({
              type: "message",
              message: { role: "user", content: [{ type: "text", text: "go" }] },
            }) + "\n",
            "utf8",
          );
          return { code: 1, stderr: `diarist fail ${diaristTurns}\n`, timedOut: false, args: [...args] };
        }
        parentTurns += 1;
        return courtPipelinePiRunner()(args, options);
      },
    });
    const { io } = captureIo();
    const result = await runPublicInstructionSeat(
      ["裁：继续审票 #582 是否足以开工。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000a2p",
        host: "pi",
      },
      io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(parentTurns, 0, "parent body must not run after the station child exhausts");
    assert.equal(
      diaristTurns,
      4,
      "identity once + bound refresh uses the child's own auto-resume budget, not parent retries",
    );
    assert.equal(result.terminal?.autoResumeCount ?? 0, 0, "parent must not auto-resume over an exhausted child");
  });
});

test("beforeDispatch ticket-bind failure uses parent call-local auto-resume", async () => {
  await withCountersignProject(async ({ home, project }) => {
    ensureTicketProvenanceVolume(582, project, home);
    let bindAttempts = 0;
    let parentTurns = 0;
    const { io, stdout, stderr } = captureIo();
    const result = await runPublicInstructionSeat(
      ["裁：继续审票 #582 是否足以开工。"],
      {
        ...countersignPathEnv({
          home,
          project,
          runId: "01a0sign00-0000-7000-8000-000000000p1b",
          onTurn: (request) => {
            if (request.activation.role === "countersign") parentTurns += 1;
          },
          runCourtDiaristStation: async (admitted) => {
            bindAttempts += 1;
            if (bindAttempts === 1) {
              throw new Error("transient ticket bind");
            }
            await bindAdmittedTicketNumber(admitted, 582);
          },
        }),
      },
      io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));
    assert.equal(bindAttempts, 2, "parent must retry its own beforeDispatch bind");
    assert.equal(parentTurns, 1, "body turn runs once after bind succeeds");
    assert.equal(result.terminal?.autoResumeCount, 1);
    assert.equal(result.admitted?.ticketNumber, 582);
  });
});

test("public countersign path: typed ticket mints a new run; explicit resume continues the named run", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // #505 / #987: public entry without a caller runId mints under the typed
    // ticket. It does not resume by ticket number. Explicit resume takes the
    // package runId.
    ensureTicketProvenanceVolume(582, project, home);

    const seen: Array<{ runId: string; kind: string }> = [];
    const parentSeal = { status: "converged" as const, note: "署" };
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = argvFlagValue(args, "--ak-role");
        if (role === "diarist") {
          return courtPipelinePiRunner(582)(args, options);
        }
        return courtPipelinePiRunner(582, parentSeal)(args, options);
      },
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        if (request.activation.role === "countersign") {
          const leaf = request.runDirectory.split("/").pop() ?? "";
          const runId = leaf.endsWith("@countersign")
            ? leaf.slice(0, -"@countersign".length)
            : leaf;
          seen.push({ runId, kind: request.continuation.kind });
        }
        return baseHost.executeTurn(request);
      },
    };

    const envBase = {
      home,
      agentDir: join(home, ".pi"),
      packageRoot,
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      roleTurnHost: host,
      hostAdapters: [adapter("pi", host)],
    };

    const first = await runPublicInstructionSeat(
      ["裁：继续审票 #582 是否足以开工。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000s001",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(first.exitCode, 0);
    assert.equal(first.admitted?.ticketNumber, 582);
    assert.equal(first.admitted?.runId, "01a0sign00-0000-7000-8000-00000000s001");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    assert.equal(seen[0]!.runId, "01a0sign00-0000-7000-8000-00000000s001");

    const secondAttachment = join(project, "second-court.md");
    await writeFile(secondAttachment, "second court snapshot", "utf8");
    const second = await runPublicInstructionSeat(
      ["--attach", secondAttachment, "裁：#582 二轮再审。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000s002",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(second.exitCode, 0);
    assert.equal(
      second.admitted?.runId,
      "01a0sign00-0000-7000-8000-00000000s002",
      "public re-summons without runId must mint a new run",
    );
    assert.equal(second.admitted?.ticketNumber, 582);
    assert.ok(
      second.admitted?.runDirectory.includes(`${sep}582${sep}runs${sep}`),
      second.admitted?.runDirectory,
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "initial");
    assert.equal(seen[1]!.runId, "01a0sign00-0000-7000-8000-00000000s002");
    const secondAttachments = await readdir(
      join(second.admitted!.runDirectory, "attachments"),
      { recursive: true },
    );
    assert.ok(
      secondAttachments.some((entry) => entry.endsWith("00-second-court.md")),
      "new mint owns its own attachment snapshot",
    );
    const firstAttachments = await readdir(
      join(first.admitted!.runDirectory, "attachments"),
      { recursive: true },
    ).catch(() => [] as string[]);
    assert.equal(
      firstAttachments.some((entry) => entry.endsWith("00-second-court.md")),
      false,
      "public re-summons must not freeze new attachments into the prior run",
    );

    const third = await runPublicInstructionSeatResume(
      {
        runId: "01a0sign00-0000-7000-8000-00000000s001",
        summons: {
          instruction: "裁：#582 显式 resume 再审。",
          instructionEmpty: false,
        },
      },
      envBase,
      captureIo().io,
    );
    assert.equal(third.exitCode, 0);
    assert.equal(
      third.admitted?.runId,
      "01a0sign00-0000-7000-8000-00000000s001",
      "explicit resume continues the named package runId",
    );
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.kind, "resume");
    assert.equal(seen[2]!.runId, "01a0sign00-0000-7000-8000-00000000s001");
  });
});

test("public countersign path: true-unbound 起居郎 asserts null — no ticket bind; stays unbound", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      // 起居郎 LLM: true-unbound (null) — not a mechanical skip.
      piRunner: courtPipelinePiRunner(null),
    });
    const result = await runPublicInstructionSeat(
      ["一般性程序问询，本庭无具体票号。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000d46",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.ok(result.admitted?.runDirectory);

    // 起居郎 still ran to assert true-unbound; countersign stays unbound.
    const runsDir = join(result.admitted!.runDirectory, "..");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(runsDir).catch(() => [] as string[]);
    assert.equal(
      entries.some((entry) => entry.endsWith("@diarist")),
      true,
    );
  });
});

test("public countersign relocates its unbound diarist when the body asserts a ticket", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner(null, { status: "continue", ticketNumber: 582, fix: { summary: "补正" } }),
    });
    const result = await runPublicInstructionSeat(
      ["裁票"],
      {
        home, agentDir: join(home, ".pi"), packageRoot, cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: host, hostAdapters: [adapter("pi", host)],
        createRunId: () => "01a0sign00-0000-7000-8000-000000001010",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    const book = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project));
    const ticketRuns = await readdir(join(book, "582", "runs"));
    assert.ok(ticketRuns.some((entry) => entry.endsWith("@diarist")));
    assert.equal((await readdir(join(book, "unbound", "runs"))).some((entry) => entry.endsWith("@diarist")), false);
  });
});

test("public countersign retains an already-recorded diarist child when the child escalates", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const sessionPath = join(home, ".claude", "projects", "escalated-child", "session.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ type: "user", uuid: "escalated-child-owner", message: { role: "user", content: "证言" }, origin: { kind: "human" } })}\n`);
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner("escalate", undefined, undefined, sessionPath),
    });
    const result = await runPublicInstructionSeat(
      ["裁票"],
      { home, agentDir: join(home, ".pi"), packageRoot, cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: host, hostAdapters: [adapter("pi", host)],
        createRunId: () => "01a0sign00-0000-7000-8000-00000000e101",
      }, captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.admitted);
    const parent = result.admitted;
    await bindAdmittedTicketNumber(parent, 582);
    await relocateAdmittedRunToTicket(parent, piDurablePrincipalAuthority);
    assert.equal((await readTicketProvenance(582, project, home)).lines[0]?.id, "escalated-child-owner");
  });
});

/**
 * #871 sole tracer: typed co-review set on the real countersign entry.
 * Parent {100,101,102} → explicit resume keeps set → public re-summons mints
 * new with {100,101,103} (#987: set replace rides a new mint; keep rides
 * explicit resume). Single-ticket + true-unbound are the same line's minimal
 * boundaries. Asserts typed identities / call counts / readable records only —
 * never prose.
 */
test("public countersign path: #871 typed co-review set refresh, resume keep, replace, single and unbound", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const parent = 100;
    const childA = 101;
    const childB = 102;
    const childC = 103;
    for (const n of [parent, childA, childB, childC]) {
      ensureTicketProvenanceVolume(n, project, home);
    }
    await installGhFixture(join(home, "bin"), {
      issues: {
        [parent]: { body: "parent body", comments: [] },
        [childA]: { body: "child A body", comments: [] },
        [childB]: { body: "child B body", comments: [] },
        [childC]: { body: "child C body", comments: [] },
      },
    });

    type Phase = "first" | "resumeKeep" | "replace" | "single" | "unbound";
    let phase: Phase = "first";
    const boundRefreshTickets: number[] = [];
    const countersignPrompts: string[] = [];
    let countersignBodyTurns = 0;

    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = argvFlagValue(args, "--ak-role");
        if (role === "diarist") {
          // Bound refresh places the child under the member ticket dir; identity stays unbound.
          const runDir = options.env.AK_ROLE_RUN_DIR ?? "";
          const ticketDirMatch = /[\\/](\d+)[\\/]runs[\\/][^\\/]+@diarist$/.exec(runDir);
          const boundTicket =
            ticketDirMatch !== null ? Number(ticketDirMatch[1]) : undefined;
          if (boundTicket !== undefined) {
            boundRefreshTickets.push(boundTicket);
            return courtPipelinePiRunner(boundTicket)(args, options);
          }
          if (phase === "first") {
            return courtPipelinePiRunner(parent, undefined, [parent, childA, childB])(
              args,
              options,
            );
          }
          if (phase === "resumeKeep") {
            // No new set field — resume must keep stored {parent,A,B}.
            return courtPipelinePiRunner(parent)(args, options);
          }
          if (phase === "replace") {
            return courtPipelinePiRunner(parent, undefined, [parent, childA, childC])(
              args,
              options,
            );
          }
          if (phase === "single") {
            return courtPipelinePiRunner(parent)(args, options);
          }
          return courtPipelinePiRunner(null)(args, options);
        }
        countersignBodyTurns += 1;
        return courtPipelinePiRunner(parent)(args, options);
      },
    });
    const host: RoleTurnHost = {
      executeTurn: async (request) => {
        if (request.activation.role === "countersign") {
          countersignPrompts.push(request.continuation.prompt);
        }
        return await baseHost.executeTurn(request);
      },
    };

    const envBase = {
      home,
      agentDir: join(home, ".pi"),
      packageRoot,
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      roleTurnHost: host,
      hostAdapters: [adapter("pi", host)],
    };

    async function assertReadableSubject(ticketNumber: number): Promise<void> {
      const volume = await readTicketProvenance(ticketNumber, project, home);
      assert.ok(volume.recordFile, `ticket #${ticketNumber} must have a record file`);
      await readFile(volume.recordFile, "utf8");
      // Empty-selection still ensures the volume; header ticket must match when present.
      if (volume.header !== undefined) {
        assert.equal(volume.header.ticket, ticketNumber);
      }
    }

    // --- first court: set {parent,A,B} ---
    phase = "first";
    boundRefreshTickets.length = 0;
    countersignBodyTurns = 0;
    const first = await runPublicInstructionSeat(
      ["裁：父子一庭合审 #100 与子票。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000871a",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(first.exitCode, 0);
    assert.equal(first.admitted?.ticketNumber, parent);
    assert.deepEqual(admittedCountersign(first.admitted).courtTicketNumbers, [parent, childA, childB]);
    assert.equal(countersignBodyTurns, 1, "countersign body runs once per court");
    assert.deepEqual(
      boundRefreshTickets,
      [parent, childA, childB],
      "first court bound-refreshes the typed set",
    );
    await assertReadableSubject(parent);
    await assertReadableSubject(childA);
    await assertReadableSubject(childB);
    const firstRunId = first.admitted!.runId;

    // --- #987 explicit resume, no new set: keep {parent,A,B} ---
    phase = "resumeKeep";
    boundRefreshTickets.length = 0;
    countersignBodyTurns = 0;
    const resumed = await runPublicInstructionSeatResume(
      {
        runId: firstRunId,
        summons: {
          instruction: "裁：#100 二轮再审，集合不变。",
          instructionEmpty: false,
        },
      },
      {
        ...envBase,
        runCourtDiaristStation: async () => {
          throw new Error("refresh unavailable");
        },
      },
      captureIo().io,
    );
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.admitted?.runId, firstRunId, "explicit resume keeps principal run");
    assert.equal(resumed.admitted?.ticketNumber, parent);
    assert.deepEqual(admittedCountersign(resumed.admitted).courtTicketNumbers, [parent, childA, childB]);
    assert.equal(countersignBodyTurns, 1);
    assert.equal(countersignPrompts.at(-1), "裁：#100 二轮再审，集合不变。");
    assert.equal(
      boundRefreshTickets.length,
      0,
      "explicit resume must dispatch without a diarist refresh precondition",
    );

    // --- #987 public re-summons mints new with set {parent,A,C}; B not refreshed ---
    phase = "replace";
    boundRefreshTickets.length = 0;
    countersignBodyTurns = 0;
    const replaced = await runPublicInstructionSeat(
      ["裁：#100 三轮，子票集合改为 A+C。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000871c",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(replaced.exitCode, 0);
    assert.notEqual(
      replaced.admitted?.runId,
      firstRunId,
      "set replace rides a new mint (no public ticketNumber resume)",
    );
    assert.equal(replaced.admitted?.runId, "01a0sign00-0000-7000-8000-00000000871c");
    assert.equal(replaced.admitted?.ticketNumber, parent);
    assert.deepEqual(admittedCountersign(replaced.admitted).courtTicketNumbers, [parent, childA, childC]);
    assert.equal(countersignBodyTurns, 1);
    assert.deepEqual(
      boundRefreshTickets,
      [parent, childA, childC],
      "new typed set whole-replaces; historical B is not refreshed",
    );
    assert.equal(boundRefreshTickets.includes(childB), false);
    await assertReadableSubject(parent);
    await assertReadableSubject(childA);
    await assertReadableSubject(childC);

    // --- single-ticket boundary: set defaults to [main] ---
    phase = "single";
    boundRefreshTickets.length = 0;
    countersignBodyTurns = 0;
    const single = await runPublicInstructionSeat(
      ["裁：单票 #100 开新庭。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000871d",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(single.exitCode, 0);
    assert.equal(single.admitted?.ticketNumber, parent);
    assert.deepEqual(admittedCountersign(single.admitted).courtTicketNumbers, [parent]);
    assert.equal(countersignBodyTurns, 1);
    assert.deepEqual(boundRefreshTickets, [parent]);
    await assertReadableSubject(parent);

    // --- true-unbound boundary: no typed ticket, zero diary generation ---
    phase = "unbound";
    boundRefreshTickets.length = 0;
    countersignBodyTurns = 0;
    const beforeUnboundVolumes = {
      parent: (await readTicketProvenance(parent, project, home)).lines.length,
      a: (await readTicketProvenance(childA, project, home)).lines.length,
    };
    const unbound = await runPublicInstructionSeat(
      ["一般性程序问询，本庭无具体票号。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000871e",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(unbound.exitCode, 0);
    assert.equal(unbound.admitted?.ticketNumber, undefined);
    assert.equal(admittedCountersign(unbound.admitted).courtTicketNumbers, undefined);
    assert.equal(countersignBodyTurns, 1, "true-unbound still runs countersign body");
    assert.deepEqual(boundRefreshTickets, [], "true-unbound must not bound-refresh any ticket");
    assert.equal(
      (await readTicketProvenance(parent, project, home)).lines.length,
      beforeUnboundVolumes.parent,
    );
    assert.equal(
      (await readTicketProvenance(childA, project, home)).lines.length,
      beforeUnboundVolumes.a,
    );
  });
});
