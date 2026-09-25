/**
 * README main-flow P0 gates that were absent on main:
 *  1) first public judge with no --model and no seat fails before executeTurn
 *  2) escalate → resume "<ruling>" → same runId converged
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
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
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    const runId = "01a0esc471-0000-7000-8000-000000000001";
    const ruling = "owner ruling: accept the plan";
    const escalateDetails = {
      status: "escalate" as const,
      decisionGate: {
        question: "Ship or hold?",
        options: ["ship", "hold"],
      },
    };
    const convergedDetails = {
      status: "converged" as const,
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
    const officerHost = roleTurnHostFromLegacyPiRunner({
      packageRoot, principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        const role = args[args.indexOf("--ak-role") + 1];
        if (role !== "notary" && role !== "auditor") throw new Error("unexpected reviewer role");
        return scriptedTerminatingToolSession({
          role, toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : AUDITOR_OUTPUT_TOOL_NAME,
          details: { status: "converged" },
        })(args, options);
      },
    });
    const resumed = await runAkRole(
      ["resume", "--model", "test/caller-seat:high", runId, ruling],
      {
        packageRoot,
        home,
        cwd: project,
        io: resumeIo.io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          if (request.activation.role === "notary" || request.activation.role === "auditor") {
            return officerHost.executeTurn(request);
          }
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
