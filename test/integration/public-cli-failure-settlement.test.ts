import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence } from "../helpers/terminal-payload.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "../helpers/role-turn-host-fixture.ts";
import { recordNonSealedSubmissionForSpawn } from "../helpers/submission-ledger-fixture.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
// #107 failure + human-decision settlement seam — typed API / classifier core.
// #420 整改拆分：公开入口与 provider-stop 家族分片并行（同根家族聚合，无新增机制）。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";

import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { ATTEMPT_HISTORY_ENTRY_TYPE, exitCodeForTerminalOutcome } from "../../src/public-cli/settlement.ts";
import { readSitianRecords, resolveSitianRecordPath } from "../../src/sitian-facade.ts";
import type { TerminalRoleOutcome } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";

// Admission matrix: structural rejects before model dispatch share one root —
// nonzero exit, zero dispatch, no Terminal. Two rows cover the grammar faces.
test("malformed CLI structure and empty --project= reject structurally before admission", async () => {
  const rows = [
    {
      label: "unknown flag",
      args: (project: string) => ["judge", "--model", "test/caller-seat:high", "--not-a-real-flag", "task", "--project", project],
    },
    {
      // Empty project must not resolve("") → cwd and complete admission/dispatch.
      label: "empty --project=",
      args: () => ["judge", "--project=", "task"],
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      let dispatched = 0;
      const result = await runAkRole(row.args(project), {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          dispatched += 1;
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      });
      assert.equal(result.exitCode, 2, row.label);
      assert.equal(dispatched, 0, row.label);
      assert.equal(stdout.length, 0, row.label);
      assert.equal(stderr.length >= 1, true, row.label);
      // Typed admission oracle: structural reject never produces a Terminal.
      assert.equal(result.terminal, undefined, row.label);
    });
  }
});
test("well-formed nonexistent domain facts are not semantically pre-rejected", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    const { io, stdout } = captureIo();
    let dispatchedPrompt: string | undefined;
    const domainProse =
      "Adjudicate missing issue #999999 and absent PR https://example.invalid/x/y/pull/404 with no local authority.";

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, domainProse],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-domain-001",
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
          dispatchedPrompt = readUserDialogueStdin(String(options.stdin ?? ""));
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
                details: { status: "converged", note: "domain remains role-owned" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            sealedAcceptance: { role: "judge" as const, details: { status: "converged", note: "domain remains role-owned" } },
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(dispatchedPrompt, domainProse);
    assert.equal(stdout.length, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.runId, "run-domain-001");
    assert.ok(result.terminal!.artifacts.some((a) => a.kind === "report"));
  });
});
test("JSONL tool_execution event flood keeps real diagnostic; oversized line is presentation-bounded", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Counterexample 1: Error then real-shaped JSONL tool_execution_end.
    {
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "jsonl flood"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-jsonl-flood-001",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stderr: realisticJsonlFloodStderr(),
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      const flood = realisticJsonlFloodStderr();
      // A bare nonzero exit names no cause; the real diagnostic is kept whole.
      const { terminal } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        diagnosticEquals: flood,
      });
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.diagnostic, flood);
      }
      assert.equal(stderr[0]!.includes("tool_execution_end"), true);
    }

    // Counterexample 2: oversized diagnostic is kept whole on durable + presentation.
    {
      const stderrText = oversizedDiagnosticStderr();
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "oversized diagnostic"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-oversize-diag-001",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stderr: stderrText,
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      // A bare nonzero exit keeps the real stderr diagnostic whole and claims
      // no cause of its own.
      const { terminal, errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        diagnosticEquals: stderrText,
      });
      const body = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        diagnostic: string;
      };
      assert.equal(body.diagnostic, stderrText);
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.diagnostic, stderrText);
      }
      assert.ok(stderr[0]!.includes("x".repeat(680)));
    }
  });
});
test("lawful judge escalate human-decision exits zero as accepted role outcome", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "needs owner decision"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-escalate-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
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
                details: {
                  status: "escalate",
                  decisionGate: {
                    question: "Ship or hold?",
                    options: ["ship", "hold"],
                  },
                },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            sealedAcceptance: {
              role: "judge" as const,
              details: {
                status: "escalate",
                decisionGate: {
                  question: "Ship or hold?",
                  options: ["ship", "hold"],
                },
              },
            },
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    if (result.terminal!.roleOutcome.kind !== "accepted") throw new Error("expected accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["escalate"]);
    assert.equal(exitCodeForTerminalOutcome(result.terminal!.roleOutcome), 0);
    assert.equal(result.terminal!.runId, "run-escalate-001");
  });
});
test("no lawful typed terminal result exits nonzero; unrecognized keeps identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "will throw"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-unrec-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
          const err = new Error("ECONNRESET from upstream");
          err.name = "RawSocketError";
          throw err;
        },
          }),
      },
    );

    await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      diagnosticEquals: "ECONNRESET from upstream",
      identityName: "RawSocketError",
    });
    // stderr: non-flood shape only — durable identity lives on Terminal/Error Artifact (AC6).
    assert.equal(stderr[0]!.includes("ak_judge_output"), false);
  });
});
test("post-admission throw undefined stays unrecognized (not activation/null-exit)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "runner throws undefined"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-throw-undefined-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
          throw undefined;
        },
          }),
      },
    );

    const { terminal } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      diagnosticEquals: "undefined",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      // Presence of thrown undefined must not wash into activation or null-exit output.
      assert.equal(terminal.roleOutcome.cause, undefined);
      assert.notEqual(terminal.roleOutcome.cause, "activation");
      assert.notEqual(terminal.roleOutcome.cause, "output");
    }
  });
});
test("timeout controlled failure settles with typed timeout cause and Error Artifact", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "slow"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-timeout-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: null,
            stderr: "still running\n",
            timedOut: true,
            args: [...args],
          };
        },
          }),
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "timeout",
    });
    // Typed timeout identity — not package presentation prose.
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "timeout");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      details?: { timedOut?: boolean };
    };
    assert.equal(errorBody.cause, "timeout");
    assert.equal(errorBody.details?.timedOut, true);
    // Empty session on this real failure: missing attendance stays unavailable.
    assert.equal(terminal.navigator.disposition, "unavailable");
    if (terminal.navigator.disposition === "unavailable") {
      assert.equal(terminal.navigator.source, "unknown");
    }
    // One-line stderr emission already asserted by helper; durable diagnostic stays full.
    assert.equal(stderr[0]!.includes("\n"), true);
  });
});


test("#419 failed attempt joins history and a later accepted attempt overwrites only pointer views", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    const { io } = captureIo();
    let calls = 0;
    let sessionFile = "";
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "failure then accepted across legs"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-419-pointer-overwrite-001",
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
          calls += 1;
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          sessionFile = join(sessionDir, "session.jsonl");
          await mkdir(sessionDir, { recursive: true });
          if (calls === 1) {
            await writeFile(sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`, "utf8");
            return { code: 1, stderr: "fail\n", timedOut: false, args: [...args] };
          }
          const prior = await readFile(sessionFile, "utf8");
          const details = { status: "converged", note: "resumed ok" };
          await writeFile(
            sessionFile,
            `${prior}${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details } })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge" as const, details },
          };
        },
          }),
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.autoResumeCount, 1);

    // Settlement must not append to the host's native session; both attempts
    // remain readable in the package-owned append-only volume after resume.
    const hostRows = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { customType?: string });
    assert.equal(hostRows.some((row) => row.customType === ATTEMPT_HISTORY_ENTRY_TYPE), false);
    const { recordFile } = resolveSitianRecordPath({ level: "event", kind: "attempt-history", sessionParent: sessionFile });
    const history = (await readSitianRecords(recordFile)).records.map((row) => row.payload as {
      type?: string; outcome?: { kind?: string; diagnostic?: string };
    });
    assert.equal(history.length, 2);
    assert.equal(history[0]?.type, ATTEMPT_HISTORY_ENTRY_TYPE);
    assert.equal(history[0]?.outcome?.kind, "failure", "failed leg's complete result is retained");
    assert.equal(typeof history[0]?.outcome?.diagnostic, "string");
    assert.equal(history[1]?.outcome?.kind, "accepted");

    // report/evidence stay last-write-wins views of the final accepted attempt.
    const runDirectory = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), "unbound", "runs", "run-419-pointer-overwrite-001@judge");
    const report = JSON.parse(await readFile(join(runDirectory, "artifacts", "report.json"), "utf8")) as { outcome?: TerminalRoleOutcome };
    assert.equal(report.outcome?.kind, "accepted");
    // #836: the persisted report carries the role's original payload, not an
    // invented top-level status.
    assert.deepEqual(report.outcome === undefined ? [] : payloadStatusSequence(report.outcome), ["converged"]);
    await readFile(join(runDirectory, "artifacts", "evidence.json"), "utf8");
  });
});

test("#881 non-sealed correctable-rejection and infrastructure params each appear once beside host failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const bounceParams = { status: "converged", report: "bounce-verdict" };
    const infraParams = { status: "converged", report: "infra-verdict" };

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "host aborts after non-sealed submissions"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-881-non-sealed",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, spawnOptions) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            await recordNonSealedSubmissionForSpawn({
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              role: "judge",
              details: bounceParams,
              toolCallId: "call-bounce",
              executeError: new GatekeeperDecisionError({
                status: "continue",
                officer: "inspector",
                receipt: { status: "continue", findings: ["x"] },
              }),
            });
            await recordNonSealedSubmissionForSpawn({
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              role: "judge",
              details: infraParams,
              toolCallId: "call-infra",
              executeError: new Error("This operation was aborted"),
            });
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            throw err;
          },
        }),
      },
    );

    const { terminal } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      diagnosticEquals: "This operation was aborted",
      identityName: "AbortError",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") throw new Error("expected failure");
    // Host failure stays failure; both original params ride on submissions (#953).
    assert.equal(
      terminal.roleOutcome.payloads === undefined
        || terminal.roleOutcome.payloads.length === 0,
      true,
    );
    assert.deepEqual(terminal.submissions, [bounceParams, infraParams]);
    assert.equal(result.exitCode, 1);
  });
});

function realisticJsonlFloodStderr(): string {
  return [
    "Error: provider rejected the request",
    JSON.stringify({
      event: "tool_execution_end",
      role: "judge",
      toolCallId: "t1",
      toolName: "bash",
      timestamp: "2026-01-01T00:00:00.000Z",
      isError: false,
    }),
  ].join("\n");
}
function oversizedDiagnosticStderr(): string {
  return `Error: ${"x".repeat(680)}\n`;
}
