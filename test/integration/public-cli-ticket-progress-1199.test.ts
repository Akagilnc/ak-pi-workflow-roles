/**
 * #1199 — ticket-level current.jsonl + receipts/ + sessions/ via public CLI
 * and in-repo fake hosts. Structured paths and field presence only.
 * Non-pi host original + identity resume live on report-ticket-adapter-exit-copy
 * and public-cli-report-ticket envelope cases (one adapter assembly authority).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import {
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { formatRunLeaf, sessionDirectoryOf, sessionFileOf } from "../../src/role-run-placement.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import {
  reportTicketSeatEnv as seatEnv,
  ticketLeaf,
  unboundLeaf,
  withReportTicketSeatProject as withSeatProject,
} from "../helpers/report-ticket-seat-project.ts";
import { withPassingReviewHost } from "../helpers/passing-review-host.ts";

const TICKET = 1199;

const FIXER_DONE = {
  status: "completed",
  report: "done",
  classResults: [{
    name: "main",
    disposition: "completed",
    searchScope: "src",
    exceptions: [],
    commitSha: "abc1234",
  }],
} as const;

function subjectDir(home: string, bookKey: string, ticket: number | "unbound"): string {
  return join(home, ".ak-roles", "books", bookKey, String(ticket));
}

function worktreeHead(project: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
}

/** Soft-reask twice without ticket so the leg seals on unbound with one progress row. */
function unboundSealedFixerHost(summary: string) {
  let turns = 0;
  return withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args, options) => {
      turns += 1;
      return scriptedTerminatingToolSession({
        role: "fixer",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        details: {
          ...FIXER_DONE,
          report: `unbound-${turns}`,
          summary,
        },
        toolCallId: `call_unbound_${turns}`,
        ...(turns === 1 ? {} : { sessionWriteMode: "append" as const }),
      })(args, options);
    },
  }));
}

test("#1199 bound seat writes current.jsonl receipt session with instruction and head", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011990-0000-7000-8000-00000000b001";
    const instruction = "first summons body for ticket progress";
    const summary = "bound first round short summary text here ok";
    const receiptDetails = { ...FIXER_DONE, summary, ticketNumber: TICKET };
    const headBefore = worktreeHead(project);
    let turnRequest: RoleTurnRequest | undefined;
    const observing = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: receiptDetails,
        })(args, options);
      },
    });
    const host: typeof observing = {
      async executeTurn(request) {
        turnRequest = request;
        return observing.executeTurn(request);
      },
    };

    const result = await runPublicInstructionSeat(
      ["apply", instruction],
      {
        ...seatEnv(home, project, runId, "pi", withPassingReviewHost(host)),
        boundTicketNumber: TICKET,
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
    assert.equal(turnRequest?.summonsInstruction, instruction);

    const ticketDir = subjectDir(home, bookKey, TICKET);
    const lines = readTicketProgressLines(ticketDir);
    assert.equal(lines.length, 1);
    const line = lines[0]!;
    assert.equal(line.seat, "fixer");
    assert.equal(line.round, "1");
    assert.equal(line.instruction, instruction);
    assert.equal(line.head, headBefore);
    assert.equal(line.status, "completed");
    assert.equal(line.summary, summary);
    assert.equal(line.receipt, "receipts/fixer#1.json");
    assert.ok(line.session.startsWith("sessions/"));
    assert.equal(Object.hasOwn(line, "model"), false);
    assert.equal(Object.hasOwn(line, "host"), false);
    assert.equal(Object.hasOwn(line, "thinking"), false);

    const receiptPath = join(ticketDir, line.receipt);
    assert.equal(existsSync(receiptPath), true);
    // Whole submitted receipt JSON equality (F7).
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    assert.deepEqual(receipt, receiptDetails);

    const sessionPath = join(ticketDir, line.session);
    assert.equal(existsSync(sessionPath), true);
    assert.equal(sessionPath, sessionFileOf(ticketLeaf(home, bookKey, TICKET, runId, "fixer")));

    const runDir = ticketLeaf(home, bookKey, TICKET, runId, "fixer");
    assert.equal(existsSync(runDir), true);
    assert.equal(
      sessionDirectoryOf(runDir),
      join(ticketDir, "sessions", formatRunLeaf(runId, "fixer")),
    );
  }, { ticket: TICKET, seatRoles: ["fixer"], prefix: "ak-1199-bound-" });
});

test("#1199 resume appends round with new instruction and head; same session path grows", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011990-0000-7000-8000-00000000r002";
    const firstInstruction = "round-one summons";
    const secondInstruction = "round-two resume summons";
    let fixerTurns = 0;
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        fixerTurns += 1;
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            ...FIXER_DONE,
            report: `done-${fixerTurns}`,
            summary: `summary for round ${fixerTurns} ends here`,
            ticketNumber: TICKET,
          },
          toolCallId: `call_fixer_${fixerTurns}`,
          ...(fixerTurns === 1 ? {} : { sessionWriteMode: "append" as const }),
        })(args, options);
      },
    });

    const first = await runPublicInstructionSeat(
      ["apply", firstInstruction],
      {
        ...seatEnv(home, project, runId, "pi", withPassingReviewHost(host)),
        boundTicketNumber: TICKET,
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(first.exitCode, 0, `${first.terminal?.roleOutcome.kind}`);
    const head1 = worktreeHead(project);
    const ticketDir = subjectDir(home, bookKey, TICKET);
    const sessionPath = join(ticketDir, readTicketProgressLines(ticketDir)[0]!.session);
    const beforeLines = (await readFile(sessionPath, "utf8")).trim().split("\n").filter(Boolean).length;

    await writeFile(join(project, "advance.txt"), "round-2\n", "utf8");
    execFileSync("git", ["add", "advance.txt"], { cwd: project });
    execFileSync("git", ["commit", "-m", "advance head"], { cwd: project });
    const head2 = worktreeHead(project);
    assert.notEqual(head1, head2);

    const second = await runPublicInstructionSeatResume(
      { runId, message: secondInstruction },
      seatEnv(home, project, runId, "pi", withPassingReviewHost(host)),
      captureIo().io,
    );
    assert.equal(second.exitCode, 0, `${second.terminal?.roleOutcome.kind}`);

    const lines = readTicketProgressLines(ticketDir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.round, "1");
    assert.equal(lines[0]!.instruction, firstInstruction);
    assert.equal(lines[0]!.head, head1);
    assert.equal(lines[1]!.round, "2");
    assert.equal(lines[1]!.instruction, secondInstruction);
    assert.equal(lines[1]!.head, head2);
    assert.equal(lines[0]!.session, lines[1]!.session);
    assert.equal(existsSync(join(ticketDir, lines[0]!.session)), true);
    assert.equal(existsSync(join(ticketDir, lines[0]!.receipt)), true);
    assert.equal(existsSync(join(ticketDir, lines[1]!.receipt)), true);
    // Same original gained host records (row count), not a peer copy.
    const afterLines = (await readFile(sessionPath, "utf8")).trim().split("\n").filter(Boolean).length;
    assert.ok(afterLines > beforeLines, "resume must append host records into the same original");
  }, { ticket: TICKET, seatRoles: ["fixer"], prefix: "ak-1199-resume-" });
});

// #1199 J5: unbound seal+ticketNumber progress relocate is asserted on the
// existing #1171 "submit with ticketNumber and no report tool" public entry case.

test("#1199 reviewer dual-lens rounds on same ticket", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    await writeFile(join(project, "AUTH.md"), "# auth\n", "utf8");
    const auth = join(project, "AUTH.md");

    const summonsByLens = {
      completeness: "review this branch as completeness",
      correctness: "review this branch as correctness",
    } as const;
    for (const lens of ["completeness", "correctness"] as const) {
      const runId = `01a011990-0000-7000-8000-0000000l${lens.slice(0, 3)}`;
      const host = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => scriptedTerminatingToolSession({
          role: "reviewer",
          toolName: REVIEWER_OUTPUT_TOOL_NAME,
          details: {
            status: "converged",
            findings: [],
            summary: `lens round summary for ${lens} axis`,
            ticketNumber: TICKET,
          },
        })(args, options),
      });
      const result = await runPublicInstructionSeat(
        [
          "--base", "HEAD",
          "--lens", lens,
          "--authority-ref", auth,
          summonsByLens[lens],
        ],
        {
          ...seatEnv(home, project, runId, "pi", host),
          boundTicketNumber: TICKET,
        },
        captureIo().io,
        "reviewer",
        (args) => parsePublicSeatArgv("reviewer", args),
      );
      assert.equal(result.exitCode, 0, `${lens}: ${result.terminal?.roleOutcome.kind}`);
    }

    const lines = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
      .filter((line) => line.seat === "reviewer");
    assert.equal(lines.length, 2);
    const rounds = lines.map((line) => line.round).sort();
    // Dual-lens series are independent — each lens starts at 1.<lens>.
    assert.deepEqual(rounds, ["1.completeness", "1.correctness"]);
    for (const line of lines) {
      const lens = line.round.includes(".")
        ? line.round.slice(line.round.indexOf(".") + 1)
        : "";
      assert.ok(lens === "completeness" || lens === "correctness", line.round);
      assert.equal(line.instruction, summonsByLens[lens]);
      const receipt = JSON.parse(
        await readFile(join(subjectDir(home, bookKey, TICKET), line.receipt), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(receipt.status, "converged");
      assert.equal(Array.isArray(receipt.findings), true);
    }
  }, {
    ticket: TICKET,
    seatRoles: ["reviewer", "fixer"],
    prefix: "ak-1199-dual-lens-",
  });
});

test("#1199 new session same seat accumulates rounds on ticket", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const summons = ["session 1 summons", "session 2 summons"] as const;
    for (const [idx, runId] of [
      "01a011990-0000-7000-8000-00000000s001",
      "01a011990-0000-7000-8000-00000000s002",
    ].entries()) {
      const host = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            ...FIXER_DONE,
            summary: `session ${idx + 1} summary text goes here now`,
            ticketNumber: TICKET,
            report: `session-${idx + 1}`,
          },
        })(args, options),
      });
      const result = await runPublicInstructionSeat(
        ["apply", summons[idx]!],
        {
          ...seatEnv(home, project, runId, "pi", withPassingReviewHost(host)),
          boundTicketNumber: TICKET,
        },
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(result.exitCode, 0, `${runId}: ${result.terminal?.roleOutcome.kind}`);
    }
    const lines = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
      .filter((line) => line.seat === "fixer");
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.round, "1");
    assert.equal(lines[1]!.round, "2");
    assert.equal(lines[0]!.instruction, summons[0]);
    assert.equal(lines[1]!.instruction, summons[1]);
    assert.notEqual(lines[0]!.session, lines[1]!.session);
  }, { ticket: TICKET, seatRoles: ["fixer"], prefix: "ak-1199-accum-" });
});

test("#1199 auto-resume continues the same session original", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011990-0000-7000-8000-00000000a001";
    let turns = 0;
    let autoInstruction: string | undefined;
    let sessionPathAtFail: string | undefined;
    let sessionBytesAtFail = 0;
    const base = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        turns += 1;
        if (turns === 1) {
          // Fail after the host has a durable session leaf so auto-resume can append it.
          const sessionFile = args.includes("--session")
            ? args[args.indexOf("--session") + 1]
            : undefined;
          if (typeof sessionFile === "string") {
            const { writeFile: wf, mkdir: md } = await import("node:fs/promises");
            const { dirname: dn } = await import("node:path");
            await md(dn(sessionFile), { recursive: true });
            await wf(
              sessionFile,
              `${JSON.stringify({ type: "message", role: "user", content: "pre-fail" })}\n`,
              "utf8",
            );
            sessionPathAtFail = sessionFile;
            sessionBytesAtFail = (await readFile(sessionFile, "utf8"))
              .trim().split("\n").filter(Boolean).length;
          }
          return { code: 1, timedOut: false, stderr: "quota", args: [...args] };
        }
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            ...FIXER_DONE,
            summary: "auto resume sealed summary text here ok",
            ticketNumber: TICKET,
          },
          sessionWriteMode: "append",
        })(args, options);
      },
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        if (request.continuation.kind === "resume") {
          autoInstruction = request.summonsInstruction ?? request.continuation.prompt;
        }
        return withPassingReviewHost(base).executeTurn(request);
      },
    };
    const result = await runPublicInstructionSeat(
      ["apply", "initial before auto resume"],
      {
        ...seatEnv(home, project, runId, "pi", host, { autoResumeLimit: 1 }),
        boundTicketNumber: TICKET,
      },
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.exitCode, 0, `${result.terminal?.roleOutcome.kind}`);
    assert.ok(turns >= 2, `auto-resume must run; turns=${turns}`);
    const ticketDir = subjectDir(home, bookKey, TICKET);
    const lines = readTicketProgressLines(ticketDir).filter((l) => l.seat === "fixer");
    // Only the sealed accepted turn lands a progress row.
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.status, "completed");
    // Auto-resume progress instruction is the continuation prompt, not first mint.
    assert.notEqual(lines[0]!.instruction, "initial before auto resume");
    assert.ok(lines[0]!.instruction.length > 0);
    if (autoInstruction !== undefined) {
      assert.equal(lines[0]!.instruction, autoInstruction);
    }
    const sessionPath = join(ticketDir, lines[0]!.session);
    assert.equal(existsSync(sessionPath), true);
    if (sessionPathAtFail !== undefined) {
      assert.equal(sessionPath, sessionPathAtFail, "auto-resume must keep the same original path");
      const afterCount = (await readFile(sessionPath, "utf8")).trim().split("\n").filter(Boolean).length;
      assert.ok(
        afterCount > sessionBytesAtFail,
        "auto-resume must append host records into the pre-fail original",
      );
    }
  }, { ticket: TICKET, seatRoles: ["fixer"], prefix: "ak-1199-auto-" });
});

test("#1199 relocate one unbound leg leaves sibling unbound progress untouched", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const stayId = "01a011990-0000-7000-8000-00000000k001";
    const moveId = "01a011990-0000-7000-8000-00000000k002";

    // Both legs seal on unbound (soft-reask spends missing-ticket budget).
    const stay = await runPublicInstructionSeat(
      ["apply", "stay leg summons body text"],
      seatEnv(home, project, stayId, "pi", unboundSealedFixerHost("stay unbound sealed summary text")),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(stay.exitCode, 0, `${stay.terminal?.roleOutcome.kind}`);
    assert.equal(existsSync(unboundLeaf(home, bookKey, stayId, "fixer")), true);

    const moveSeed = await runPublicInstructionSeat(
      ["apply", "move leg summons body text"],
      seatEnv(home, project, moveId, "pi", unboundSealedFixerHost("move unbound sealed summary text")),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(moveSeed.exitCode, 0, `${moveSeed.terminal?.roleOutcome.kind}`);
    assert.equal(existsSync(unboundLeaf(home, bookKey, moveId, "fixer")), true);

    const unboundBefore = readTicketProgressLines(subjectDir(home, bookKey, "unbound"));
    assert.ok(
      unboundBefore.some((l) => l.session.includes(stayId)),
      "stay leg must have unbound progress before relocate",
    );
    assert.ok(
      unboundBefore.some((l) => l.session.includes(moveId)),
      "move leg must have unbound progress before relocate",
    );
    const stayRowsBefore = unboundBefore.filter((l) => l.session.includes(stayId));

    // Only move leg resumes with ticketNumber → relocates; stay remains on unbound.
    let moveTurns = 0;
    const moveHost = withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        moveTurns += 1;
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            ...FIXER_DONE,
            summary: "move leg seals onto ticket 1199 here",
            ticketNumber: TICKET,
            report: `move-bound-${moveTurns}`,
          },
          toolCallId: `call_move_${moveTurns}`,
          sessionWriteMode: "append",
        })(args, options);
      },
    }));
    const moved = await runPublicInstructionSeatResume(
      { runId: moveId, message: "bind move leg to ticket" },
      seatEnv(home, project, moveId, "pi", moveHost),
      captureIo().io,
    );
    assert.equal(moved.exitCode, 0, `${moved.terminal?.roleOutcome.kind}`);
    assert.equal(existsSync(unboundLeaf(home, bookKey, moveId, "fixer")), false);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, moveId, "fixer")), true);
    assert.equal(existsSync(unboundLeaf(home, bookKey, stayId, "fixer")), true);

    const unboundAfter = readTicketProgressLines(subjectDir(home, bookKey, "unbound"));
    const stayRowsAfter = unboundAfter.filter((l) => l.session.includes(stayId));
    assert.equal(stayRowsAfter.length, stayRowsBefore.length);
    for (const row of stayRowsAfter) {
      assert.equal(existsSync(join(subjectDir(home, bookKey, "unbound"), row.receipt)), true);
      assert.equal(existsSync(join(subjectDir(home, bookKey, "unbound"), row.session)), true);
    }
    assert.equal(unboundAfter.some((l) => l.session.includes(moveId)), false);

    const t1199 = readTicketProgressLines(subjectDir(home, bookKey, TICKET));
    assert.ok(t1199.every((l) => l.session.includes(moveId)));
    assert.equal(t1199.some((l) => l.session.includes(stayId)), false);
    for (const row of t1199) {
      assert.equal(existsSync(join(subjectDir(home, bookKey, TICKET), row.receipt)), true);
      assert.equal(existsSync(join(subjectDir(home, bookKey, TICKET), row.session)), true);
    }
  }, {
    ticket: TICKET,
    seatRoles: ["fixer"],
    prefix: "ak-1199-iso-",
  });
});

test("#1199 head is the seat worktree HEAD across distinct linked worktrees", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runA = "01a011990-0000-7000-8000-00000000h001";
    const runB = "01a011990-0000-7000-8000-00000000h002";

    // Linked git worktree: same book key (common-dir), different actual cwd HEAD.
    // Not the same project advanced twice between rounds.
    const projectB = join(home, "project-b");
    execFileSync("git", ["branch", "work-b"], { cwd: project });
    execFileSync("git", ["worktree", "add", projectB, "work-b"], { cwd: project });
    await writeFile(join(projectB, "other.txt"), "b-side\n", "utf8");
    execFileSync("git", ["add", "other.txt"], { cwd: projectB });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "project-b head"], {
      cwd: projectB,
    });

    const headA = worktreeHead(project);
    const headB = worktreeHead(projectB);
    assert.notEqual(headA, headB, "fixtures must be distinct worktree HEADs");

    for (const row of [
      { runId: runA, projectRoot: project, head: headA, summary: "worktree A summary text here ok" },
      { runId: runB, projectRoot: projectB, head: headB, summary: "worktree B summary text here ok" },
    ] as const) {
      const host = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: {
            ...FIXER_DONE,
            summary: row.summary,
            ticketNumber: TICKET,
            report: row.runId,
          },
        })(args, options),
      });
      const result = await runPublicInstructionSeat(
        ["apply", `summons for ${row.runId}`],
        {
          ...seatEnv(home, row.projectRoot, row.runId, "pi", withPassingReviewHost(host)),
          boundTicketNumber: TICKET,
        },
        captureIo().io,
        "fixer",
        (args) => parsePublicSeatArgv("fixer", args),
      );
      assert.equal(result.exitCode, 0, `${row.runId}: ${result.terminal?.roleOutcome.kind}`);
    }

    const lines = readTicketProgressLines(subjectDir(home, bookKey, TICKET))
      .filter((line) => line.seat === "fixer");
    assert.equal(lines.length, 2);
    const bySession = Object.fromEntries(
      lines.map((line) => [line.session.includes(runA) ? "A" : "B", line.head]),
    );
    assert.equal(bySession.A, headA);
    assert.equal(bySession.B, headB);
  }, { ticket: TICKET, seatRoles: ["fixer"], prefix: "ak-1199-heads-" });
});
