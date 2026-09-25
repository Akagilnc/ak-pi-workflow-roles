import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #635 / #709 / #771 — seat ticket identity from the public CLI true entry
 * (no --ticket / no frontmatter). Mechanical layer never matches summons text
 * against book-known numbers. Typed identity arrives only from:
 * - 起居郎 LLM assertion (countersign court station / diarist seat)
 * - --source-run admitted form (notary / auditor)
 * - already-bound resume
 * Asserts typed ticketNumber on admitted-request.json + invocation.json only
 * when a typed source provided it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/package-contracts/worker-output.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  bindAdmittedTicketNumber,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { ensureTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  await withTempRoot("ak-seat-self-ticket-", async (home) => {
    const binDir = join(home, "bin");
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    await withPrimaryAwareCleanup(
      () => run(home),
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "seat-ticket@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Seat Ticket"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
    cwd: root,
  });
}

async function withSeatProject(
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
      },
    });
    // Volume may exist; seats must not mechanically bind from it + summons text.
    ensureTicketProvenanceVolume(582, project, home);
    await configurePassingReviewSeats(home);
    await run({ home, project });
  });
}

function baseEnv(input: {
  home: string;
  project: string;
  runId: string;
  role: "coder" | "fixer" | "judge" | "countersign" | "notary";
  toolName: string;
  details: unknown;
  /** Gate/auditor escalation face; original `details` stay the ledger params. */
  outputDetails?: unknown;
  additionalDetails?: readonly unknown[];
  /** Countersign court station: may bind a typed ticket (起居郎 handoff face). */
  runCourtDiaristStation?: (
    admitted: { ticketNumber?: number; runDirectory: string },
  ) => Promise<void>;
}) {
  const host = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: scriptedTerminatingToolSession({
      role: input.role,
      toolName: input.toolName,
      details: input.details,
      ...(input.outputDetails === undefined
        ? {}
        : { outputDetails: input.outputDetails }),
    }),
  });
  const roleTurnHost = withPassingReviewHost({
    async executeTurn(request: RoleTurnRequest) {
      const result = await host.executeTurn(request);
      if (input.additionalDetails !== undefined) {
        for (const [index, details] of input.additionalDetails.entries()) {
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home: request.home,
            runId: input.runId,
            runDirectory: request.runDirectory,
            role: input.role,
            details,
            toolCallId: `call_${input.role}_${index + 2}`,
          });
        }
      }
      return result;
    },
  });
  return {
    home: input.home,
    agentDir: join(input.home, ".pi"),
    packageRoot,
    cwd: input.project,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    roleTurnHost,
    createRunId: () => input.runId,
    // #742: body-path tests stub the court diarist station (no real nested seat).
    ...(input.role === "countersign"
      ? {
          runCourtDiaristStation:
            input.runCourtDiaristStation ?? (async () => undefined),
        }
      : {}),
  };
}

async function assertDurableTicket(
  runDirectory: string,
  expected: number,
): Promise<void> {
  const admitted = JSON.parse(
    await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
  ) as { ticketNumber?: number };
  const invocation = JSON.parse(
    await readFile(join(runDirectory, "invocation.json"), "utf8"),
  ) as { ticketNumber?: number };
  assert.equal(admitted.ticketNumber, expected);
  assert.equal(invocation.ticketNumber, expected);
}

async function assertDurableUnbound(runDirectory: string): Promise<void> {
  const admitted = JSON.parse(
    await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
  ) as { ticketNumber?: number };
  const invocation = JSON.parse(
    await readFile(join(runDirectory, "invocation.json"), "utf8"),
  ) as { ticketNumber?: number };
  assert.equal(admitted.ticketNumber, undefined);
  assert.equal(invocation.ticketNumber, undefined);
}

test("public coder binds its typed receipt assertion without parsing summons text", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicInstructionSeat(
      ["apply", "Implement the fix for ticket #582."],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000coder",
        role: "coder",
        toolName: CODER_OUTPUT_TOOL_NAME,
        // #863 / #1071: unidentifiable first, then first legal field wins; all
        // original receipts retained. Topology unbound→bind→relocate belongs
        // to the #859 public-entry tracer.
        details: {
          status: "completed",
          report: "malformed ticket shape",
          ticketNumber: "not-a-ticket",
        },
        additionalDetails: [
          { status: "completed", report: "first legal", ticketNumber: 582 },
          { status: "completed", report: "later receipt", ticketNumber: 999 },
        ],
      }),
      captureIo().io,
      "coder",
      (args) => parsePublicSeatArgv("coder", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    if (result.terminal?.roleOutcome.kind !== "accepted") assert.fail("expected accepted outcome");
    assert.deepEqual(result.terminal.roleOutcome.payloads, [
      { status: "completed", report: "malformed ticket shape", ticketNumber: "not-a-ticket" },
      { status: "completed", report: "first legal", ticketNumber: 582 },
      { status: "completed", report: "later receipt", ticketNumber: 999 },
    ]);
    await assertDurableTicket(result.admitted!.runDirectory, 582);
  });
});

test("public fixer ignores a malformed ticket assertion without rejecting its receipt", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicInstructionSeat(
      ["apply", "Repair the regression on ticket #582."],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000fixer",
        role: "fixer",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        details: {
          status: "completed",
          report: "repaired",
          ticketNumber: "not-a-ticket",
          classResults: [{ name: "main", disposition: "completed", searchScope: "src", exceptions: [], commitSha: "abc1234" }],
        },
      }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    await assertDurableUnbound(result.admitted!.runDirectory);
  });
});

test("#1071 mid-ticket seats bind leading #N ticketNumber declarations and keep prose", async () => {
  await withSeatProject(async ({ home, project }) => {
    ensureTicketProvenanceVolume(1843, project, home);
    const judgeDetails = {
      status: "converged",
      note: "#1843 / PR #1876",
      ticketNumber: "#1843 / PR #1876",
    };
    for (const seat of [
      {
        role: "judge" as const,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        argv: ["Adjudicate #1843 on PR #1876."],
        details: judgeDetails,
        runId: "01a010710-0000-7000-8000-00000000judge",
        expectedOutcome: "accepted" as const,
      },
      {
        role: "fixer" as const,
        toolName: FIXER_OUTPUT_TOOL_NAME,
        argv: ["apply", "Repair #1843."],
        details: {
          status: "completed",
          report: "fixed #1843",
          ticketNumber: "#1843",
          classResults: [{ name: "main", disposition: "completed", searchScope: "src", exceptions: [], commitSha: "abc1234" }],
        },
        runId: "01a010710-0000-7000-8000-00000000fixer",
        expectedOutcome: "accepted" as const,
      },
      {
        // Judge self-escalation stays the original declaration (#1071).
        // The removed audit-escalation projection is not restored.
        role: "judge" as const,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        argv: ["Escalate adjudication of #1843."],
        details: {
          status: "escalate",
          note: "#1843 / PR #1876",
          ticketNumber: "#1843 / PR #1876",
        },
        runId: "01a010710-0000-7000-8000-0000000jesc",
        expectedOutcome: "accepted" as const,
      },
    ]) {
      const result = await runPublicInstructionSeat(
        seat.argv,
        baseEnv({
          home,
          project,
          runId: seat.runId,
          role: seat.role,
          toolName: seat.toolName,
          details: seat.details,
          ...("outputDetails" in seat && seat.outputDetails !== undefined
            ? { outputDetails: seat.outputDetails }
            : {}),
        }),
        captureIo().io,
        seat.role,
        (args) => parsePublicSeatArgv(seat.role, args),
      );
      assert.equal(result.exitCode, 0, `${seat.runId} exit`);
      assert.equal(result.admitted?.ticketNumber, 1843, `${seat.runId} bound ticket`);
      assert.equal(result.terminal?.roleOutcome.kind, seat.expectedOutcome, `${seat.runId} outcome`);
      assert.deepEqual(result.terminal?.roleOutcome.payloads, [seat.details]);
      await assertDurableTicket(result.admitted!.runDirectory, 1843);
      assert.match(result.admitted!.runDirectory, /[/\\]1843[/\\]runs[/\\]/);
      assert.equal(result.admitted!.runDirectory.includes(`${join("unbound", "runs")}`), false);
    }

    // Prose alone is never a ticket bind source (#1071 / 不从回执散文猜票).
    const proseOnly = await runPublicInstructionSeat(
      ["Adjudicate ticket mentioned only in note."],
      baseEnv({
        home,
        project,
        runId: "01a010710-0000-7000-8000-0000000prose",
        role: "judge",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "#1843 / PR #1876" },
      }),
      captureIo().io,
      "judge",
      (args) => parsePublicSeatArgv("judge", args),
    );
    assert.equal(proseOnly.exitCode, 0);
    assert.equal(proseOnly.admitted?.ticketNumber, undefined);
    await assertDurableUnbound(proseOnly.admitted!.runDirectory);

    // Decimal-looking field values are unidentifiable → stay unbound (#1071).
    for (const [label, ticketNumber] of [
      ["hash-decimal", "#1843.5"],
      ["bare-decimal", "1843.5"],
    ] as const) {
      const decimal = await runPublicInstructionSeat(
        ["Adjudicate a decimal-looking ticketNumber declaration."],
        baseEnv({
          home,
          project,
          runId: `01a010710-0000-7000-8000-0000000${label.slice(0, 5)}`,
          role: "judge",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          details: { status: "converged", note: "field only", ticketNumber },
        }),
        captureIo().io,
        "judge",
        (args) => parsePublicSeatArgv("judge", args),
      );
      assert.equal(decimal.exitCode, 0, `${label} exit`);
      assert.equal(decimal.admitted?.ticketNumber, undefined, `${label} unbound`);
      await assertDurableUnbound(decimal.admitted!.runDirectory);
    }
  });
});

test("public judge without --ticket: no mechanical bind from summons text", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicInstructionSeat(
      ["Adjudicate whether ticket #582 may proceed."],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000judge",
        role: "judge",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        details: { status: "converged" },
      }),
      captureIo().io,
      "judge",
      (args) => parsePublicSeatArgv("judge", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    await assertDurableUnbound(result.admitted!.runDirectory);
  });
});

test("public countersign without --ticket: binds only via 起居郎 typed handoff", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicInstructionSeat(
      ["裁：继续审票 #582 是否足以开工。"],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000csign",
        role: "countersign",
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "署" },
        // Court station face: 起居郎 asserted #582 (typed handoff, not prose match).
        runCourtDiaristStation: async (admitted) => {
          await bindAdmittedTicketNumber(
            admitted as Parameters<typeof bindAdmittedTicketNumber>[0],
            582,
          );
        },
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    // Topology relocate for 起居郎 is owned by the #859 public-entry tracer;
    // this seat file only proves typed bind from the diarist handoff.
    await assertDurableTicket(result.admitted!.runDirectory, 582);
  });
});

test("countersign and notary reject --ticket as unknown option (exit 2)", async () => {
  assert.throws(
    () => parsePublicSeatArgv("countersign", ["--ticket", "582", "裁"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /unknown countersign option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );
  assert.throws(
    () =>
      parsePublicSeatArgv("notary", [
        "--source-run",
        "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
        "--ticket",
        "582",
      ]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /unknown notary option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );

  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const countersign = await runPublicInstructionSeat(
      ["--ticket", "582", "裁"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: {
          async executeTurn(_request: RoleTurnRequest) {
            throw new Error("turn must not start on unknown option");
          },
        },
        createRunId: () => "01a063500-0000-7000-8000-00000000rej1",
      },
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(countersign.exitCode, 2);
    assert.equal(countersign.admitted, undefined);
  });
});

test("notary keeps its bound source-run ticket over a different receipt assertion", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    await writeFile(
      join(sourceRunPath, "admitted-request.json"),
      `${JSON.stringify({
        role: CANONICAL_SOURCE_ROLE,
        runId: CANONICAL_SOURCE_RUN_ID,
        ticketNumber: 582,
      })}\n`,
      "utf8",
    );

    const result = await runPublicInstructionSeat(
      ["--source-run", sourceRunPath],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [], ticketNumber: 999 },
          }),
        }),
        createRunId: () => "01a063500-0000-7000-8000-0000000notary",
      },
      captureIo().io,
      "notary",
      (args) => parsePublicSeatArgv("notary", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(result.admitted?.role, "notary");
    if (result.admitted?.role === "notary") {
      assert.equal(result.admitted.sourceRunPath, sourceRunPath);
    }
    await assertDurableTicket(result.admitted!.runDirectory, 582);
  });
});
