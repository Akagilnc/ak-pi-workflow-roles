/**
 * README main-flow P0 gates that were absent on main:
 *  1) first public judge with no --model and no seat fails before executeTurn
 *  2) escalate → resume "<ruling>" → same runId converged
 *  3) coder completed → inspector bounce → same-session resubmit pass
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  sessionToolExchangeRows,
  sessionUserMessageRow,
  writeSessionJsonl,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";

const CREDENTIALS = { "openai-codex": true, xai: true } as const;

function countingHost(turns: { count: number }): RoleTurnHost {
  return {
    executeTurn: async () => {
      turns.count += 1;
      throw new Error("role turn must not start");
    },
  };
}

test("publicCliJudgeWithoutModelOrSeatFailsBeforeTurn", async () => {
  await withTempHome(async (home) => {
    const turns = { count: 0 };
    const host = countingHost(turns);
    const { io } = captureIo();
    const result = await runAkRole(["judge", "Review this plan."], {
      packageRoot,
      home,
      io,
      credentials: CREDENTIALS,
      roleTurnHost: host,
      hostAdapters: [{ name: "pi", create: () => ({ ok: true, host }) }],
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.terminal, undefined);
    assert.equal(turns.count, 0);
  }, { prefix: "ak-p0-no-model-" });
});

test("judgeEscalateThenResumeOwnerRulingSettlesConverged", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0esc471-0000-7000-8000-000000000001";
    const ruling = "owner ruling: accept the plan";
    const escalateDetails = {
      judgeStatus: "escalate" as const,
      decisionGate: {
        question: "Ship or hold?",
        options: ["ship", "hold"],
      },
    };
    const convergedDetails = {
      judgeStatus: "converged" as const,
      note: "owner ruling applied on same session",
    };

    const firstIo = captureIo();
    const first = await runAkRole(
      ["judge", "--model", "test/caller-seat:high", "--project", project, "needs owner decision"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io: firstIo.io,
        credentials: CREDENTIALS,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
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
                  details: escalateDetails,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
              sealedAcceptance: { role: "judge" as const, details: escalateDetails },
            };
          },
        }),
      },
    );
    assert.equal(first.exitCode, 0, firstIo.stderr.join(""));
    assert.ok(first.terminal);
    assert.equal(first.terminal.runId, runId);
    assert.equal(first.terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(first.terminal.roleOutcome), ["escalate"]);

    let resumeKind: string | undefined;
    let resumePrompt: string | undefined;
    let resumePrincipal: string | undefined;
    const resumeIo = captureIo();
    const resumed = await runAkRole(
      ["resume", "--model", "test/caller-seat:high", runId, ruling],
      {
        packageRoot,
        home,
        cwd: project,
        io: resumeIo.io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          resumeKind = request.continuation.kind;
          resumePrompt = request.continuation.prompt;
          resumePrincipal = JSON.stringify(request.principal);
          const { sessionDirectory, sessionFile } =
            piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: convergedDetails,
              },
            })}\n`,
            "utf8",
          );
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home,
            runId,
            runDirectory: request.runDirectory,
            role: "judge",
            details: convergedDetails,
            toolCallId: "call_judge_ruling",
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(resumed.exitCode, 0, resumeIo.stderr.join(""));
    assert.ok(resumed.terminal);
    assert.equal(resumed.terminal.runId, runId);
    assert.equal(resumed.terminal.roleOutcome.kind, "accepted");
    const statuses = payloadStatusSequence(resumed.terminal.roleOutcome);
    assert.equal(statuses.at(-1), "converged");
    assert.equal(resumeKind, "resume");
    assert.equal(resumePrompt?.startsWith(ruling), true);
    assert.ok(resumePrincipal?.includes(runId), "resume must reopen the same run principal");
  }, { prefix: "ak-p0-escalate-resume-" });
});

test("publicCliCoderCompletedInspectorBounceThenPassSameSession", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0cod753-0000-7000-8000-000000000001";
    const bounceFindings = ["missing red/green evidence"] as const;
    const completed = {
      status: "completed" as const,
      report: "TDD red/green evidence after inspector bounce.",
    };
    let sessionFileSeen: string | undefined;
    const { io } = captureIo();
    const result = await runAkRole(
      [
        "coder",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "Implement the approved slice.",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          const { sessionDirectory, sessionFile } =
            piDurablePrincipalAuthority.decode(request.principal);
          sessionFileSeen = sessionFile;
          await mkdir(sessionDirectory, { recursive: true });
          await writeSessionJsonl(sessionFile, [
            sessionUserMessageRow("user-1", "Implement the approved slice.", 1),
            ...sessionToolExchangeRows({
              stem: "bounce",
              parentId: "user-1",
              callId: "call_coder_bounce",
              toolName: CODER_OUTPUT_TOOL_NAME,
              details: { status: "completed", report: "first completed, bounced" },
              body: "inspector bounce — rewrite and resubmit",
              isError: true,
              n: 2,
            }),
            ...sessionToolExchangeRows({
              stem: "pass",
              parentId: "result-bounce",
              callId: "call_coder_pass",
              toolName: CODER_OUTPUT_TOOL_NAME,
              details: completed,
              body: "coder output accepted",
              isError: false,
              n: 4,
            }),
          ]);
          const auditorDir = join(dirname(sessionFile), "auditor-roles");
          await mkdir(auditorDir, { recursive: true });
          await writeFile(
            join(auditorDir, "o01_inspector.jsonl"),
            gateToolSessionJsonl({
              id: "inspector-bounce",
              startedAt: "2026-09-16T00:00:00.000Z",
              endedAt: "2026-09-16T00:00:10.000Z",
              toolName: "ak_inspector_output",
              args: { status: "bounce", findings: [...bounceFindings] },
            }),
            "utf8",
          );
          await writeFile(
            join(auditorDir, "o02_inspector.jsonl"),
            gateToolSessionJsonl({
              id: "inspector-pass",
              startedAt: "2026-09-16T00:00:20.000Z",
              endedAt: "2026-09-16T00:00:30.000Z",
              toolName: "ak_inspector_output",
              args: { status: "pass", findings: [] },
            }),
            "utf8",
          );
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home,
            runId,
            runDirectory: request.runDirectory,
            role: "coder",
            details: completed,
            toolCallId: "call_coder_pass",
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(result.exitCode, 0, io.stderr.join(""));
    assert.ok(result.terminal);
    assert.equal(result.terminal.runId, runId);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.equal(result.terminal.roleOutcome.role, "coder");
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), ["completed"]);
    assert.ok(result.terminal.gate);
    assert.deepEqual(result.terminal.gate.actualSeats, ["inspector"]);
    assert.equal(result.terminal.gate.rounds.length, 2);
    assert.equal(result.terminal.gate.rounds[0]!.officer.status, "bounce");
    assert.deepEqual(result.terminal.gate.rounds[0]!.officer.findings, [...bounceFindings]);
    assert.equal(result.terminal.gate.rounds[1]!.officer.status, "pass");
    assert.ok(sessionFileSeen?.includes(runId), "bounce and pass must share the coder session");
  }, { prefix: "ak-p0-coder-inspector-" });
});
