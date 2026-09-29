import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
/**
 * #572 / ADR 0074 public Countersign seat — ticket materials in, 署/封驳 verdict
 * out via real runAkRole entry; #599 / #987 resume continues via explicit package
 * runId. #1111: court admission leaves diary refresh to the caller; countersign
 * asserts its own ticketNumber, never matching summons prose against book records.
 * Public re-summons mint a new run under the typed ticket (#505 / #987).
 * Gate handoff resumes by parent run path. Explicit ak-role resume takes a runId.
 * #1092: no code-side 起居录 path delivery.
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
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/auditor-role.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import type { HostContext, RoleHost, RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { summonPublicRole } from "../../src/public-role-summons.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitPublicRole,
  relocateAdmittedRunToTicket,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import { type CountersignRunEnv } from "../../src/public-cli/countersign-run.ts";
import {
  buildInstructionSeatTurnRequest,
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import { findRunDirectoryById, readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
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
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
import {
  ensureTicketProvenanceVolume,
} from "../helpers/ticket-provenance-fixture.ts";

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

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

/** Gate child uses a lawful notary receipt; countersign does not summon diarist (#1111). */
function withConvergedNotary(inner: LegacyFauxPiRunner): LegacyFauxPiRunner {
  return async (args, options) => {
    if (argvFlagValue(args, "--ak-role") === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary", toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged" },
      })(args, options);
    }
    return inner(args, options);
  };
}

function scriptedCountersignSession(details: unknown) {
  return withConvergedNotary(scriptedTerminatingToolSession({
    role: "countersign",
    toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
    details,
  }));
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

test("countersign admission ignores attachment frontmatter", async () => {
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
            // The court body receives its own scripted receipt; no diarist child.
            piRunner: async (args, options) => {
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
          piRunner: withConvergedNotary(async (args) => {
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
        // Resume does not refresh 起居郎; the caller owns diary refresh (#1111).
        piRunner: withConvergedNotary(async (args, options) => {
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
          piRunner: withConvergedNotary(
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
          if (argvFlagValue(args, "--ak-role") === "countersign") {
            resumeDispatches += 1;
            resumeArgs = [...args];
            resumeStdin = options.stdin;
          }
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
          piRunner: withConvergedNotary(
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
        piRunner: withConvergedNotary(async (args) => {
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
    piRunner: withConvergedNotary(piRunner),
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
    assert.equal(result.terminal.gate!.rounds.length, 1);
    assert.equal(result.terminal.gate!.rounds[0]!.dispatch.kind, "direct");
    assert.equal(result.terminal.gate!.rounds[0]!.dispatch.officer, "notary");
    assert.equal(result.terminal.gate!.rounds[0]!.officer.status, "converged");
    assert.deepEqual(result.terminal.gate!.rounds[0]!.officer.findings, []);

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
    // Two seeded volumes plus the live notary pass required before settlement.
    const reverseRounds = reversed.terminal!.gate!.rounds;
    assert.equal(reverseRounds.length, 3);
    assert.ok(reverseRounds.some((round) =>
      round.officer.status === "converged" && round.officer.findings.length === 0));
    const bounced = reverseRounds.filter((round) => round.officer.status === "continue");
    assert.equal(bounced.length, 1);
    assert.deepEqual(bounced[0]!.officer.findings, [...reverseGateFindings]);
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

function countersignPathEnv(input: {
  home: string;
  project: string;
  runId: string;
  onTurn?: (request: RoleTurnRequest) => void;
  blockTurn?: boolean;
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
          piRunner: withConvergedNotary(scriptedCountersignSession({
            status: "converged",
            note: "署",
          })),
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
  };
}

test("public countersign path: invalid attachment rejects before identity or run persistence", async () => {
  await withCountersignProject(async ({ home, project }) => {
    const runId = "01a0sign00-0000-7000-8000-000000000bad";
    const result = await runPublicInstructionSeat(
      ["--attach", join(project, "missing.md"), "裁：附件无效。"],
      countersignPathEnv({
        home,
        project,
        runId,
        blockTurn: true,
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.admitted, undefined);
    const placement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey: resolveBookKeyFromGit(project),
      subject: { unbound: true },
      runId,
      role: "countersign",
    });
    await assert.rejects(readFile(join(placement.runDirectory, "invocation.json")));
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
 * Used to detect accidental diarist summons while running Countersign.
 */
function courtPipelinePiRunner(
  ticketAssertion: number | null = 582,
  countersignDetails: unknown = {
    status: "converged",
    note: "署",
  },
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
        const params = { status: "completed", ticketNumber: ticketAssertion, sessions: [] };
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

test("public countersign path: typed ticket mints a new run; explicit resume continues the named run", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // #505 / #987: public entry without a caller runId mints under the typed
    // ticket. It does not resume by ticket number. Explicit resume takes the
    // package runId.
    ensureTicketProvenanceVolume(582, project, home);

    const seen: Array<{ runId: string; kind: string }> = [];
    const parentSeal = { status: "converged" as const, note: "署", ticketNumber: 582 };
    let diaristTurns = 0;
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = argvFlagValue(args, "--ak-role");
        if (role === "diarist") {
          diaristTurns += 1;
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
    assert.equal(diaristTurns, 0, "an existing diary does not trigger a child on first court");
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
    assert.equal(diaristTurns, 0, "repeat court does not refresh the diary");
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
    assert.equal(diaristTurns, 0, "explicit resume does not refresh the diary");
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
