/**
 * #635 / #709 / #771 — seat ticket identity from the public CLI true entry
 * (no --ticket / no frontmatter). Mechanical layer never matches summons text
 * against book-known numbers. Typed identity arrives only from:
 * - 给事中交卷票号或起居郎交卷票号（各自独立调用）
 * - --source-run admitted form (notary / auditor)
 * - already-bound resume
 * Asserts typed ticketNumber on the current.json admitted + invocation sections only
 * when a typed source provided it.
 */
import { readCurrentSection, seedCurrentSection } from "../helpers/run-dossier-fixture.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { resolveTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import {
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { addRoleRepoOrigin, packageRoot } from "../helpers/pi-test-harness.ts";
import { ensureTicketProvenanceVolume } from "../helpers/ticket-provenance-fixture.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

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

async function withSeatProject(
  run: (ctx: { home: string; project: string }) => Promise<void>,
  options?: { readonly seedDiary?: boolean },
): Promise<void> {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    addRoleRepoOrigin(project);
    await installGhFixture(join(home, "bin"), {
      issues: {
        582: { body: "issue 582 body", comments: [] },
      },
    });
    // Volume may exist; seats must not mechanically bind from it + summons text.
    if (options?.seedDiary !== false) ensureTicketProvenanceVolume(582, project, home);
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
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
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
  };
}

async function assertDurableTicket(
  runDirectory: string,
  expected: number,
): Promise<void> {
  const admitted = readCurrentSection(runDirectory, "admitted") as { ticketNumber?: number };
  const invocation = readCurrentSection(runDirectory, "invocation") as { ticketNumber?: number };
  assert.equal(admitted.ticketNumber, expected);
  assert.equal(invocation.ticketNumber, expected);
}

async function assertDurableUnbound(runDirectory: string): Promise<void> {
  const admitted = readCurrentSection(runDirectory, "admitted") as { ticketNumber?: number };
  const invocation = readCurrentSection(runDirectory, "invocation") as { ticketNumber?: number };
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

test("public countersign without a diary binds its own typed receipt", async () => {
  await withSeatProject(async ({ home, project }) => {
    const diaryPath = resolveTicketProvenanceVolume(582, project, home).recordFile;
    assert.equal(existsSync(diaryPath), false);
    const result = await runPublicInstructionSeat(
      ["裁：继续审票 #582 是否足以开工。"],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000csign",
        role: "countersign",
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "署", ticketNumber: 582 },
      }),
      captureIo().io,
      "countersign", (args) => parsePublicSeatArgv("countersign", args),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    await assertDurableTicket(result.admitted!.runDirectory, 582);
    assert.equal(existsSync(diaryPath), false, "countersign does not create a diary");
  }, { seedDiary: false });
});

test("notary keeps its bound source-run ticket over a different receipt assertion", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    seedCurrentSection(sourceRunPath, "admitted", {
      role: CANONICAL_SOURCE_ROLE,
      runId: CANONICAL_SOURCE_RUN_ID,
      ticketNumber: 582,
    });

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
            details: { status: "converged", findings: [], ticketNumber: 999 },
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
