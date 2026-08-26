/**
 * #478 Terminal menxia projection — real public settlement entry.
 *
 * Seam: settleJudgeTerminalResult (public Terminal aggregate owner).
 * Four shapes only:
 *   1. normal dispatch + officer findings
 *   2. seat reduction without written reason (officer present, reason absent)
 *   3. no-gate → menxia omitted (zero change)
 *   4. damaged auditor-roles → must not wash to "no gate"
 *
 * Oracles are typed TerminalResult.menxia fields only — never formatTerminalResult
 * wording / table labels (ADR 0052).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { settleJudgeTerminalResult } from "../../src/public-cli/settlement.ts";
import type { AdmittedJudgeInvocation } from "../../src/public-cli/invocation.ts";

const BASE_MS = Date.parse("2026-08-26T04:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function gateVolumeLines(input: {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): string {
  const header = {
    type: "session",
    version: 3,
    id: input.id,
    timestamp: input.startedAt,
    cwd: "/tmp/menxia-terminal",
  };
  const call = {
    type: "message",
    id: `${input.id}-call`,
    parentId: null,
    timestamp: input.endedAt,
    message: {
      role: "assistant",
      timestamp: input.endedAt,
      content: [
        {
          type: "toolCall",
          id: `call_${input.id}`,
          name: input.toolName,
          arguments: input.args,
        },
      ],
    },
  };
  const result = {
    type: "message",
    id: `${input.id}-result`,
    parentId: `${input.id}-call`,
    timestamp: input.endedAt,
    message: {
      role: "toolResult",
      toolCallId: `call_${input.id}`,
      toolName: input.toolName,
      timestamp: input.endedAt,
      isError: false,
      content: [{ type: "text", text: "ok" }],
    },
  };
  return [header, call, result].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function withTempHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-menxia-terminal-"));
  try {
    return await body(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function seedJudgeRun(input: {
  readonly home: string;
  readonly runId: string;
  readonly seedAuditorRoles?: (auditorDir: string) => Promise<void>;
}): Promise<AdmittedJudgeInvocation> {
  const runDirectory = join(
    input.home,
    ".ak-roles",
    "books",
    "menxia-book",
    "runs",
    `${input.runId}@judge`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionFile,
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
  await writeFile(join(runDirectory, "admitted-request.json"), "{}\n", "utf8");
  if (input.seedAuditorRoles !== undefined) {
    const auditorDir = join(sessionDirectory, "auditor-roles");
    await mkdir(auditorDir, { recursive: true });
    await input.seedAuditorRoles(auditorDir);
  }
  return {
    role: "judge",
    runId: input.runId,
    bookKey: "menxia-book",
    projectRoot: join(input.home, "proj"),
    instruction: "project menxia",
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    sessionDirectory,
    sessionFile,
    admittedRequestPath: join(runDirectory, "admitted-request.json"),
  };
}

test("settleJudgeTerminalResult projects normal menxia dispatch + officer findings", async () => {
  await withTempHome(async (home) => {
    const admitted = await seedJudgeRun({
      home,
      runId: "run-menxia-normal",
      seedAuditorRoles: async (auditorDir) => {
        await writeFile(
          join(auditorDir, "d01_gatekeeper.jsonl"),
          gateVolumeLines({
            id: "disp-1",
            startedAt: iso(0),
            endedAt: iso(1_000),
            toolName: "ak_gatekeeper_output",
            args: {
              status: "dispatch",
              officer: "notary",
              reason: "judge draft requires document fidelity",
            },
          }),
          "utf8",
        );
        await writeFile(
          join(auditorDir, "o02_notary.jsonl"),
          gateVolumeLines({
            id: "off-1",
            startedAt: iso(1_000),
            endedAt: iso(11_000),
            toolName: "ak_notary_output",
            args: {
              status: "pass",
              findings: ["quote matches source", "ticket axes aligned"],
            },
          }),
          "utf8",
        );
      },
    });

    const terminal = await settleJudgeTerminalResult(admitted);

    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "converged");
    assert.ok(terminal.menxia !== undefined, "menxia section must appear for gated run");
    assert.deepEqual(terminal.menxia.actualSeats, ["gatekeeper", "notary"]);
    assert.equal(terminal.menxia.rounds.length, 1);
    const round = terminal.menxia.rounds[0]!;
    assert.equal(round.roundIndex, 1);
    assert.deepEqual(round.dispatch, {
      status: "dispatch",
      officer: "notary",
      reason: "judge draft requires document fidelity",
    });
    assert.deepEqual(round.officer, {
      seat: "notary",
      status: "pass",
      findings: ["quote matches source", "ticket axes aligned"],
    });
  });
});

test("settleJudgeTerminalResult shows seat reduction without reason as reason-absent", async () => {
  await withTempHome(async (home) => {
    // 符宝郎缺席 shape: dispatched inspector (给事中) instead of notary, no reason written.
    const admitted = await seedJudgeRun({
      home,
      runId: "run-menxia-no-reason",
      seedAuditorRoles: async (auditorDir) => {
        await writeFile(
          join(auditorDir, "d01_gatekeeper.jsonl"),
          gateVolumeLines({
            id: "disp-reduced",
            startedAt: iso(0),
            endedAt: iso(1_000),
            toolName: "ak_gatekeeper_output",
            args: { status: "dispatch", officer: "inspector" },
          }),
          "utf8",
        );
        await writeFile(
          join(auditorDir, "o02_inspector.jsonl"),
          gateVolumeLines({
            id: "off-reduced",
            startedAt: iso(1_000),
            endedAt: iso(5_000),
            toolName: "ak_inspector_output",
            args: { status: "pass", findings: [] },
          }),
          "utf8",
        );
      },
    });

    const terminal = await settleJudgeTerminalResult(admitted);

    assert.ok(terminal.menxia !== undefined);
    // Actual seats show what ran — notary absence is visible without a missingOfficer judgment.
    assert.deepEqual(terminal.menxia.actualSeats, ["gatekeeper", "inspector"]);
    assert.equal(terminal.menxia.rounds.length, 1);
    const round = terminal.menxia.rounds[0]!;
    assert.equal(round.dispatch.status, "dispatch");
    assert.equal(round.dispatch.officer, "inspector");
    assert.equal(
      Object.prototype.hasOwnProperty.call(round.dispatch, "reason"),
      false,
      "reason must stay absent when dispatch wrote none",
    );
    assert.equal(round.officer.seat, "inspector");
    assert.equal(round.officer.status, "pass");
    assert.deepEqual(round.officer.findings, []);
  });
});

test("settleJudgeTerminalResult omits menxia when no auditor-roles gate ran", async () => {
  await withTempHome(async (home) => {
    const admitted = await seedJudgeRun({
      home,
      runId: "run-menxia-no-gate",
      // no seedAuditorRoles — directory absent
    });

    const terminal = await settleJudgeTerminalResult(admitted);

    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(
      Object.prototype.hasOwnProperty.call(terminal, "menxia"),
      false,
      "no-gate run must keep menxia omitted (zero change)",
    );
    assert.equal(terminal.menxia, undefined);
  });
});

test("settleJudgeTerminalResult does not wash damaged auditor-roles into no-gate", async () => {
  await withTempHome(async (home) => {
    const admitted = await seedJudgeRun({
      home,
      runId: "run-menxia-damaged",
      seedAuditorRoles: async (auditorDir) => {
        // Completed-by-terminator malformed line — sole reader must fail loud.
        await writeFile(join(auditorDir, "broken.jsonl"), "{bad}\n", "utf8");
      },
    });

    await assert.rejects(
      () => settleJudgeTerminalResult(admitted),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /malformed JSONL record/);
        return true;
      },
    );
  });
});
