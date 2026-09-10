import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { payloadFacts, payloadStatus } from "../helpers/terminal-payload.ts";
/**
 * #572 / ADR 0074 public Countersign seat — ticket materials in, 署/封驳 verdict
 * out via real runAkRole entry; #599 resume continues the exact session.
 * #742: court admission auto-runs the public 起居郎 station before the body turn.
 * #771: ticket identity comes from 起居郎 LLM typed assertion (court station),
 * never from mechanical matching of summons text against book records;
 * ADR 0079: same-ticket re-summons resume prior run via that typed key;
 * 起居录 path delivery rides the shared post-admission mount.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import type { HostContext, RoleHost, RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitCountersignInvocation,
  bindAdmittedTicketNumber,
  parseCountersignArgv,
  type AdmittedCountersignInvocation,
} from "../../src/public-cli/invocation.ts";
import {
  buildCountersignTurnRequest,
  runPublicCountersign,
  type CountersignRunEnv,
} from "../../src/public-cli/countersign-run.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import {
  findLatestRunIdForSeatTicket,
  readRoleRunState,
} from "../../src/public-cli/run-lifecycle.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  ensureTicketProvenanceVolume,
  readTicketProvenance,
  resolveTicketProvenanceVolume,
} from "../../src/ticket-provenance.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-countersign-", async (home) => {
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

    const admitted = await admitCountersignInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "裁",
      attachmentPaths: [ticket],
      createRunId: () => "01a0sign00-0000-7000-8000-000000000582",
    });
    assert.equal(admitted.ticketNumber, undefined);

    const turn = buildCountersignTurnRequest(admitted, {
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
    () => parseCountersignArgv(["--ticket", "582", "裁"]),
    (error: unknown) =>
      error instanceof CliUsageError
      && /unknown countersign option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );
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
              if (receipt.countersignStatus === "converged") {
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
                    args: { status: "pass", findings: [] },
                  }),
                  "utf8",
                );
              }
              return outcome;
            },
          }),
        },
      );
      assert.equal(result.exitCode, 0, `receipt ${receipt.countersignStatus}`);
      assert.ok(result.terminal, `receipt ${receipt.countersignStatus}`);
      assert.equal(result.terminal.roleOutcome.kind, "accepted");
      assert.equal(
        payloadStatus(result.terminal.roleOutcome),
        receipt.countersignStatus,
      );
      const facts = payloadFacts(result.terminal.roleOutcome);
      assert.equal(facts.countersignStatus, receipt.countersignStatus);
      // #757: nested fields pass through — no lift to fixSummary/decisionQuestion.
      if (receipt.countersignStatus === "continue") {
        const fix = facts.fix as { summary?: string } | undefined;
        assert.equal(fix?.summary, receipt.fix.summary);
      }
      if (receipt.countersignStatus === "escalate") {
        const gate = facts.decisionGate as { question?: string; options?: string[] } | undefined;
        assert.equal(gate?.question, receipt.decisionGate.question);
        assert.deepEqual(gate?.options, [...receipt.decisionGate.options]);
      }
      if (receipt.countersignStatus === "converged") {
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
    const first = await runAkRole(
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
    const resumed = await runAkRole(["resume", runId, "再裁一次"], {
      home,
      packageRoot,
      cwd: project,
      io: resumeIo,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        // Resume still refreshes 起居郎 (refresh-every-court); true-unbound face.
        piRunner: withTrueUnboundDiarist(async (args, options) => {
          resumeArgs = [...args];
          return scriptedCountersignSession({
            countersignStatus: "converged",
            note: "RESUMED-续署",
          })(args, options);
        }),
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "countersign resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumeArgs![resumeArgs!.indexOf("--ak-role") + 1], "countersign");
    assert.equal(resumeArgs![resumeArgs!.indexOf("--session-dir") + 1], coords.sessionDirectory);
    assert.equal(resumeArgs!.includes("再裁一次"), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "countersign");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatus(resumed.terminal.roleOutcome)
        : undefined,
      "converged",
    );
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? payloadFacts(resumed.terminal.roleOutcome)
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
    const first = await runAkRole(
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
          piRunner: withTrueUnboundDiarist(
            scriptedCountersignSession({
              countersignStatus: "converged",
              note: "FIRST-署",
            }),
          ),
        }),
      },
    );
    assert.equal(first.exitCode, 0);
    assert.equal(
      first.terminal?.roleOutcome.kind === "accepted"
        ? payloadFacts(first.terminal.roleOutcome).note
        : undefined,
      "FIRST-署",
    );

    let resumeDispatches = 0;
    let resumeArgs: string[] | undefined;
    const { io: resumeIo, stdout } = captureIo();
    const resumed = await runAkRole(["resume", runId, "再裁一次"], {
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
          return scriptedCountersignSession({
            countersignStatus: "continue",
            fix: { summary: "RESUMED-再审" },
          })(args, options);
        },
      }),
    });
    assert.equal(resumeDispatches, 1, "sealed resume with message must reach the host");
    assert.equal(resumeArgs!.includes("再裁一次"), true);
    assert.equal(resumed.exitCode, 0, stdout.join("") || "sealed countersign resume failed");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatus(resumed.terminal.roleOutcome)
        : undefined,
      "continue",
    );
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? payloadFacts(resumed.terminal.roleOutcome)
      : undefined;
    assert.equal((facts?.fix as { summary?: string } | undefined)?.summary, "RESUMED-再审");
  });
});

test("countersign resume timeout is not masked by a prior-attempt residual", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0sign00-0000-7000-8000-0000000000ac";
    const first = await runAkRole(
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
          piRunner: withTrueUnboundDiarist(
            scriptedTerminatingToolSession({
              role: "countersign",
              toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
              details: { countersignStatus: "converged", note: "PRIOR-residual" },
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
    const resumed = await runAkRole(["resume", runId, "再试"], {
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
          const prior = await readFile(sessionFile, "utf8");
          const resumeUser = {
            type: "message",
            id: "user-resume",
            parentId: null,
            timestamp: "2026-08-30T00:01:00.000Z",
            message: { role: "user", content: "再试", timestamp: 10 },
          };
          await writeFile(
            sessionFile,
            `${prior}${JSON.stringify(resumeUser)}\n`,
            "utf8",
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
            countersignStatus: "converged",
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
    const result = await runPublicCountersign(
      ["--ticket", "582", "裁：本票是否足以开工。"],
      countersignPathEnv({
        home,
        project,
        runId: "01a0sign00-0000-7000-8000-000000000p01",
        blockTurn: true,
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.admitted, undefined);
  });
});

test("public countersign path: 起居郎 typed handoff binds ticket; dossier volume stays readable", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // Volume may pre-exist; binding still requires 起居郎 typed assertion (#771).
    ensureTicketProvenanceVolume(582, project, home);
    let turnTicket: number | undefined;
    const result = await runPublicCountersign(
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
      parseCountersignArgv,
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
    const result = await runPublicCountersign(
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
      parseCountersignArgv,
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
    const result = await runPublicCountersign(
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
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    assert.equal(turnTicket, undefined);
  });
});

/**
 * Multi-role faux pi: diarist envelope when --ak-role diarist, else countersign.
 * ticketAssertion: positive N = 本庭对象; null = true-unbound (真无票→无录).
 */
function courtPipelinePiRunner(
  ticketAssertion: number | null = 582,
  countersignDetails: unknown = {
    countersignStatus: "converged",
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
      const priorRunDir = process.env.AK_ROLE_RUN_DIR;
      const runDir = options.env.AK_ROLE_RUN_DIR;
      if (typeof runDir === "string" && runDir.trim() !== "") {
        process.env.AK_ROLE_RUN_DIR = runDir;
      }
      try {
        const runtime = createDiaristRoleRuntime(host, {
          loadSoul: async () => "起居郎职分（测试装载）",
        });
        await runtime.activate();
        assert.ok(registered, "diarist envelope registered no output tool");
        // 起居郎 LLM asserts the court target; envelope binds typed key (#771 / #779).
        const accepted = await registered.execute(
          "call_diarist_1",
          {
            status: "completed",
            ticketNumber: ticketAssertion,
            entries: [],
          },
          undefined,
          undefined,
          {} as HostContext,
        );
        return scriptedTerminatingToolSession({
          role: "diarist",
          toolName: DIARIST_OUTPUT_TOOL_NAME,
          details: accepted.details,
        })(args, options);
      } finally {
        if (priorRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
        else process.env.AK_ROLE_RUN_DIR = priorRunDir;
      }
    }
    return scriptedCountersignSession(countersignDetails)(args, options);
  };
}

test("public countersign path: 起居郎 asserts then countersign runs with 起居录 paths", async () => {
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
    let turnPrompt = "";
    const parentBase = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner(),
    });
    const parentHost = {
      async executeTurn(request: RoleTurnRequest) {
        parentRoles.push(request.activation.role);
        if (request.activation.role === "countersign") {
          turnPrompt = request.continuation.prompt;
        }
        return parentBase.executeTurn(request);
      },
    };
    const childBase = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner(),
    });
    const childHost = {
      async executeTurn(request: RoleTurnRequest) {
        childRoles.push(request.activation.role);
        return childBase.executeTurn(request);
      },
    };

    const { io, stdout, stderr } = captureIo();
    const result = await runPublicCountersign(
      ["裁：继续审票 #582 是否足以开工。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: parentHost,
        hostAdapters: [
          adapter("pi", parentHost),
          adapter("grok-build", childHost),
        ],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000d45",
        host: "pi",
      },
      io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));
    assert.deepEqual(parentRoles, ["countersign"], "parent adapter must not execute the court diarist child");
    assert.deepEqual(childRoles, ["diarist", "diarist"], "child seat adapter must execute court diarist station");
    assert.ok(result.admitted?.bookKey);
    assert.equal(result.admitted?.ticketNumber, 582);

    const diaristRunId = await findLatestRunIdForSeatTicket({
      home,
      bookKey: result.admitted!.bookKey,
      role: "diarist",
      ticketNumber: 582,
    });
    assert.ok(diaristRunId);
    const diaristCoords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId: diaristRunId!,
      role: "diarist",
      home,
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

    const volume = resolveTicketProvenanceVolume(582, project, home);
    assert.ok(turnPrompt.includes(volume.humanViewFile));
    assert.ok(turnPrompt.includes(volume.recordFile));
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
    const result = await runPublicCountersign(
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
      parseCountersignArgv,
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
    const result = await runPublicCountersign(
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
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));
    assert.equal(bindAttempts, 2, "parent must retry its own beforeDispatch bind");
    assert.equal(parentTurns, 1, "body turn runs once after bind succeeds");
    assert.equal(result.terminal?.autoResumeCount, 1);
    assert.equal(result.admitted?.ticketNumber, 582);
  });
});

test("public countersign path: same-ticket re-summons resumes prior run via typed 起居郎 key", async () => {
  await withCountersignProject(async ({ home, project }) => {
    // ADR 0079 ticket-seat-memory-countersign-principal: same ticket → resume,
    // not a fresh mint. Lookup key is 起居郎's typed assertion only (#771).
    ensureTicketProvenanceVolume(582, project, home);

    const seen: Array<{ runId: string; kind: string }> = [];
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: courtPipelinePiRunner(582, {
        countersignStatus: "converged",
        note: "署",
      }),
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

    const first = await runPublicCountersign(
      ["裁：继续审票 #582 是否足以开工。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000s001",
      },
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(first.exitCode, 0);
    assert.equal(first.admitted?.ticketNumber, 582);
    assert.equal(first.admitted?.runId, "01a0sign00-0000-7000-8000-00000000s001");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    assert.equal(seen[0]!.runId, "01a0sign00-0000-7000-8000-00000000s001");

    // createRunId would mint s002 if auto-resume were skipped — must not fire.
    const second = await runPublicCountersign(
      ["裁：#582 二轮再审。"],
      {
        ...envBase,
        createRunId: () => "01a0sign00-0000-7000-8000-00000000s002",
      },
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(second.exitCode, 0);
    assert.equal(
      second.admitted?.runId,
      "01a0sign00-0000-7000-8000-00000000s001",
      "same-ticket re-summons must resume prior run via typed key, not mint s002",
    );
    assert.equal(second.admitted?.ticketNumber, 582);
    assert.notEqual(
      second.admitted?.runId,
      "01a0sign00-0000-7000-8000-00000000s002",
    );
    // A dispatched body turn on re-summons must be resume on the prior run.
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "resume");
    assert.equal(seen[1]!.runId, "01a0sign00-0000-7000-8000-00000000s001");
  });
});

test("public countersign path: true-unbound 起居郎 asserts null — no ticket bind, no 起居录 paths", async () => {
  await withCountersignProject(async ({ home, project }) => {
    let turnPrompt = "";
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      // 起居郎 LLM: true-unbound (null) — not a mechanical skip.
      piRunner: courtPipelinePiRunner(null),
    });
    const result = await runPublicCountersign(
      ["一般性程序问询，本庭无具体票号。"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: {
          async executeTurn(request: RoleTurnRequest) {
            if (request.activation.role === "countersign") {
              turnPrompt = request.continuation.prompt;
            }
            return host.executeTurn(request);
          },
        },
        hostAdapters: [adapter("pi", host)],
        createRunId: () => "01a0sign00-0000-7000-8000-000000000d46",
      },
      captureIo().io,
      parseCountersignArgv,
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

    // Unbound delivers no volume path; a known partition path must not appear.
    const volume = resolveTicketProvenanceVolume(582, project, home);
    assert.equal(turnPrompt.includes(volume.humanViewFile), false);
    assert.equal(turnPrompt.includes(volume.recordFile), false);
  });
});
