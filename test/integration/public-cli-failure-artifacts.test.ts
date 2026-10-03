import { historyPayloads, statePayloads, readHistoryRows, runLogPayloads, seedTerminal, terminalBodyAt, lockCurrentJson, unlockCurrentJson } from "../helpers/run-dossier-fixture.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
// #107/#373 public-CLI acceptance tracer — 公开入口因果身份家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE } from "../../src/public-cli/post-admission.ts";
import {
  publishFailureTerminal,
  settleHostEndedNoReceipt,
  trySettlePublicSeat,
} from "../../src/public-cli/settlement.ts";
import { readRunTerminal } from "../../src/run-terminal-artifacts.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
} from "../helpers/failure-settlement-kit.ts";

// #107 公开入口——Error Artifact 耐久性与 provider 身份家族（#420 整改拆分第二片）。

test("malformed session JSONL stays no_receipt and notes the read; it does not invent a session failure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-malformed-session-jsonl-001";
    const { io, stdout } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "malformed session transcript"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "{not-json\n", "utf8");
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts, {});
    assert.equal(stdout.length, 1);
    const runDirectory = join(
      home, ".ak-roles", "books", resolveBookKeyFromGit(project), "unbound", "runs", `${runId}@judge`,
    );
    const artifactNote = runLogPayloads<{ diagnostic?: unknown }>(runDirectory, "post-admission-diagnostic")
      .some((body) => typeof body.diagnostic === "string");
    const sessionText = await readFile(join(runDirectory, "session", "session.jsonl"), "utf8");
    const sessionNote = sessionText.split("\n").some((line) => {
      if (!line.includes(POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE)) return false;
      const entry = JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } };
      return entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE
        && typeof entry.data?.diagnostic === "string";
    });
    assert.equal(artifactNote || sessionNote, true);
  });
});
test("terminal write failure is noted beside the host failure terminal and does not replace it", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    let currentJson: string | undefined;
    const runId = "run-unwritable-run-dir-001";
    // No auto-resume: a retry would meet the same refused dossier. Temp-home config only.
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: {}, autoResumeLimit: 0 })}\n`,
      "utf8",
    );
    try {
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "activation boom then unwritable run"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            const runDir = join(sessionDir, "..");
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            // Refuse every later write to the dossier's current.json after the child
            // failure is observed (an in-place rewrite fails on the file's own mode).
            // Settlement must keep boom primary and still emit one Terminal — not
            // outer-catch EACCES alone.
            currentJson = join(runDir, "current.json");
            lockCurrentJson(dirname(currentJson));
            return {
              code: 1,
              stderr: "Error: boom\n",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );

      assert.equal(result.exitCode, 1);
      assert.equal(stdout.length, 1, "one complete Terminal");
      const terminal = result.terminal;
      assert.ok(terminal, "the failure still settles a Terminal");
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        // A bare nonzero exit names no cause; the child's own diagnostic stays
        // primary and is not washed to the EACCES below.
        assert.equal(terminal.roleOutcome.cause, undefined);
        assert.equal(terminal.roleOutcome.diagnostic, "Error: boom\n");
        assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EACCES");
      }
      // The write was refused: no error terminal exists to point at, and the dossier
      // carries no failure face.
      assert.deepEqual(terminal.artifacts, []);
      const runDirectory = join(
        home, ".ak-roles", "books", resolveBookKeyFromGit(project), "unbound", "runs", `${runId}@judge`,
      );
      // The terminal FACT is recorded as a history row; only its rendering into
      // current.json was refused (the name is still the planted directory).
      const recorded = statePayloads<{ face?: string }>(runDirectory, "terminal");
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]!.face, "error");
      assert.equal(statSync(join(runDirectory, "current.json")).isDirectory(), true);
      // The refused write is a note beside the host terminal, in the run's session.
      const noteText = (await readFile(join(runDirectory, "session", "session.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } })
        .find((entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE)
        ?.data?.diagnostic;
      assert.equal(typeof noteText, "string");
    } finally {
      if (currentJson !== undefined) {
        try {
          unlockCurrentJson(dirname(currentJson));
        } catch {
          // cleanup best-effort
        }
      }
    }
  });
});
/** The run's log.jsonl takes no more appends (it stays readable, as a permission fault leaves it). */
async function blockLogAppends(runDirectory: string): Promise<void> {
  const log = join(runDirectory, "log.jsonl");
  await mkdir(runDirectory, { recursive: true });
  // A resumed dispatch finds it already blocked.
  await writeFile(log, "", { flag: "a" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EACCES") throw error;
  });
  await chmod(log, 0o400);
}

test("post-admission log.jsonl unwritable keeps the host terminal and notes the stderr log write", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "stderr log blocked"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-stderr-log-eisdir-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          // A read-only log.jsonl makes the post-admission stderr log line append raise EACCES.
          // The log line is best-effort — must not wash the already-observed child cause.
          await blockLogAppends(runDir);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stderr: "Error: child failed after admission\n",
            timedOut: false,
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
      diagnosticEquals: "Error: child failed after admission\n",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      // A bare nonzero exit names no cause; the child's diagnostic is primary
      // and the auxiliary log-write errno must not become the identity.
      assert.equal(terminal.roleOutcome.cause, undefined);
      assert.equal(terminal.roleOutcome.diagnostic, "Error: child failed after admission\n");
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR");
    }
    const errorBody = terminalBodyAt(errorRef!.path, "error") as {
      cause?: string;
      diagnostic: string;
    };
    assert.equal(errorBody.cause, undefined);
    assert.equal(errorBody.diagnostic, "Error: child failed after admission\n");
    // Must not bypass to outer raw catch (no Terminal / no Error Artifact).
    assert.equal(stdout.length, 1);
    assert.equal(result.terminal !== undefined, true);
  });

  // A sealed acceptance stays accepted. The stderr log-line failure is a
  // note beside that terminal, and the sealed payload remains on submissions.
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const acceptedDetails = { status: "converged", note: "ok" };
    await configurePassingReviewSeats(home);
    let sealedSessionFile = "";
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "accepted then log.jsonl blocked"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-stderr-log-eisdir-accepted-001",
        io,
        roleTurnHost: withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            const runDir = join(sessionDir, "..");
            sealedSessionFile = join(sessionDir, "session.jsonl");
            // A read-only log.jsonl makes the post-admission stderr log line
            // append raise EACCES — even though the child accepted a lawful verdict.
            await blockLogAppends(runDir);
            await mkdir(sessionDir, { recursive: true });
            await writeFile(
              join(sessionDir, "session.jsonl"),
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: JUDGE_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: acceptedDetails,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
              sealedAcceptance: { role: "judge" as const, details: acceptedDetails },
            };
          },
        })),
      },
    );
    // The host accepted. The stderr log line is secondary; its write failure is a note.
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.ok(
      result.terminal?.submissions?.some(
        (row) =>
          typeof row === "object" && row !== null &&
          (row as { status?: unknown }).status === "converged",
      ),
      JSON.stringify(result.terminal?.submissions),
    );
    assert.equal(stdout.length, 1);
    // One sealed attempt: one accepted attempt-history row, and the accepted terminal stands.
    const sealedRunDirectory = join(sealedSessionFile, "..", "..");
    const outcomes = readHistoryRows(sealedRunDirectory)
      .filter((row) => row.kind === "attempt-history")
      .map((row) => (row.payload as { outcome?: { kind?: string } }).outcome?.kind);
    assert.deepEqual(outcomes, ["accepted"]);
    const sealedTerminal = readRunTerminal(sealedRunDirectory);
    assert.equal(sealedTerminal.status, "present");
    if (sealedTerminal.status === "present") assert.equal(sealedTerminal.face, "report");
    const noteText = (await readFile(sealedSessionFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } })
      .find((entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE)
      ?.data?.diagnostic;
    assert.equal(typeof noteText, "string");
  });
});
test("multiline thrown diagnostic keeps full artifact identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const multiline = [
      "provider boom with details",
      "    at Object.fn (vendor/stack.js:1:1)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "event: tool_call continuation",
      "tokens=999 tool_calls=3",
    ].join("\n");
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "multiline throw"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-multiline-throw-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
          const error = new Error(multiline);
          error.name = "UpstreamProviderError";
          throw error;
        },
          }),
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      diagnosticEquals: multiline,
      identityName: "UpstreamProviderError",
    });
    // Durable Terminal/Artifact keep the full original diagnostic (newlines intact).
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.diagnostic, multiline);
    }
    const errorBody = terminalBodyAt(errorRef!.path, "error") as {
      diagnostic: string;
    };
    assert.equal(errorBody.diagnostic, multiline);
  });
});
test("a Judge turn that sealed no receipt reports the host CLI's own nonzero exit", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["--model", "xai/grok-4:off", "judge", "--project", project, "typed output host failure"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-typed-output-host-failure-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(sessionFile, [
            { type: "session", id: "parent-session" },
            { type: "message", id: "current-user", message: { role: "user" } },
            { type: "custom", customType: "business-evidence", data: { observed: true } },
            { type: "message", id: "output-call", message: { role: "assistant", content: [{ type: "toolCall", id: "host-failed-output", name: "ak_judge_output", arguments: { judgeStatus: "converged" } }] } },
            { type: "message", id: "output-result", parentId: "output-call", message: {
              role: "toolResult",
              toolCallId: "host-failed-output",
              toolName: "ak_judge_output",
              isError: true,
              content: [{ type: "text", text: "pi host could not load its runtime" }],
              details: { kind: "role_infrastructure_failure", source: "shared-role-lifecycle", reasonCode: "host_failure" },
            } },
          ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
          return { code: 1, stderr: "VARIABLE DECOY service tier switched successfully\n", timedOut: false, args: [...args] };
        },
          }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind !== "failure") return;
    // A bare nonzero exit names no cause, and the diagnostic is the host's own
    // stderr for this call — not a message read out of the transcript
    // (owner ea321c6d: 不是本轮cli报告的什么就是什么吗？).
    assert.equal(result.terminal!.roleOutcome.cause, undefined);
    assert.equal(result.terminal!.roleOutcome.diagnostic, "VARIABLE DECOY service tier switched successfully\n");
    const errorRef = result.terminal!.artifacts.find((artifact) => artifact.kind === "error");
    assert.ok(errorRef);
    const durable = terminalBodyAt(errorRef!.path, "error") as {
      diagnostic?: string;
      identity?: { name?: string; code?: string | number };
      details?: Record<string, unknown>;
    };
    // The durable artifact carries the same host report the Terminal did; no
    // cause or identity is taken from the transcript.
    assert.equal(durable.diagnostic, "VARIABLE DECOY service tier switched successfully\n");
    assert.equal(durable.identity, undefined);
    assert.deepEqual(durable.details, {
      exitCode: 1,
    });
    assert.equal(stdout.length, 1);
    assert.ok(stderr.length > 0);
  });
});
test("real Coder/Fixer runs settle on the recorded status, or honestly no_receipt when unsealed", async () => {
  await withTempHome(async (home) => {
    await configurePassingReviewSeats(home);
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const rows = [
      { role: "coder", phase: "plan", tool: CODER_OUTPUT_TOOL_NAME, statuses: ["planned", "completed", "refused", "unfinished"] },
      { role: "fixer", phase: "plan", tool: FIXER_OUTPUT_TOOL_NAME, statuses: ["planned", "completed", "refused", "partially_completed", "unfinished"] },
    ] as const;

    for (const row of rows) {
      for (const details of [{}, ...row.statuses.map((status) => ({ status }))]) {
        const status = "status" in details ? details.status : "missing";
        const { io } = captureIo();
        const result = await runAkRole(
          [row.role, "--model", "test/caller-seat:high", row.phase, "--project", project, `${row.role} ${status} discriminator`],
          {
            packageRoot,
            home,
            cwd: project,
            createRunId: () => `run-${row.role}-discriminator-${status}`,
            io,
            roleTurnHost: withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              const sessionFile = args[args.indexOf("--session") + 1]!;
              await mkdir(join(sessionFile, ".."), { recursive: true });
              const toolCallId = `${row.role}-terminal`;
              // Status-bearing details need a report for worker contracts; missing stays unsealed.
              const sealDetails =
                status === "missing"
                  ? details
                  : row.role === "fixer" && (status === "completed" || status === "partially_completed")
                    ? {
                        ...details,
                        report: `${row.role} ${status}`,
                        classResults: [{
                          name: "discriminator",
                          disposition: "completed" as const,
                          searchScope: "discriminator",
                          exceptions: [],
                          commitSha: "0".repeat(40),
                        }],
                      }
                    : row.role === "fixer" && status === "refused"
                      ? {
                          ...details,
                          report: `${row.role} ${status}`,
                          remainingScope: "blocked",
                          blocker: { cause: "authority_violation" as const, evidence: "fixture" },
                        }
                      : row.role === "fixer" && status === "unfinished"
                        ? {
                            ...details,
                            report: `${row.role} ${status}`,
                            remainingScope: "left",
                            reason: "prerequisite_unmet",
                          }
                        : { ...details, report: `${row.role} ${status}` };
              await writeFile(sessionFile, `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId,
                  toolName: row.tool,
                  isError: false,
                  details: sealDetails,
                },
              })}\n`, "utf8");
              return {
                code: 0,
                stderr: "",
                timedOut: false,
                args: [...args],
                ...(status === "missing"
                  ? {}
                  : {
                      sealedAcceptance: {
                        role: row.role,
                        details: sealDetails,
                        toolCallId,
                      },
                    }),
              };
            },
          })),
          },
        );

        assert.ok(result.terminal, `${row.role}:${status} terminal`);
        if (status === "missing") {
          // #836: an unsealed toolResult in the raw session is not a code-side
          // rejection — the submission ledger has no accepted row for this
          // role, and the host ended cleanly, so this settles as an honest
          // no_receipt (lawful, exit 0) — never an invented "output" failure.
          assert.equal(result.exitCode, 0, `${row.role}: missing status`);
          assert.equal(result.terminal!.roleOutcome.kind, "no_receipt", row.role);
        } else {
          assert.equal(result.exitCode, 0, `${row.role}:${status}`);
          assert.equal(result.terminal!.roleOutcome.kind, "accepted", `${row.role}:${status}`);
          assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), [status], `${row.role}:${status}`);
        }
      }
    }
  });
});
test("no lawful output after an older provider error settles honestly as no_receipt, not a revived stale error (#288)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "xai/grok-4:off",
        "judge",
        "--project",
        project,
        "recovered after provider error without lawful output",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-stale-provider-error-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "older provider boom",
                  provider: "xai",
                  model: "grok-4",
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "retry" }],
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "end_turn",
                  content: [{ type: "text", text: "could not call the tool" }],
                  provider: "xai",
                  model: "grok-4",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      },
    );
    // #836: no accepted ledger row and no typed host/runner failure signal —
    // the host ended cleanly, so this settles as an honest no_receipt.
    // The older, superseded provider error is not revived as the failure
    // (that was #288's point) — and code does not invent an "output" failure
    // for it either. No_receipt is itself the answer: nothing was accepted.
    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1, "exactly one Terminal emission");
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
  });
});

// --- #953: real publish/read/settlement entries; structured reader contract only ---

test("#953 a later success replaces an earlier failure terminal, and a later failure replaces the success", async () => {
  await withTempHome(async (home) => {
    const runId = "01a0-953-switch";
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      "proj",
      "unbound",
      "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "session.jsonl"), "", "utf8");
    const admitted = fixtureJudgeAdmitted({
      runId,
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    const authority = piDurablePrincipalAuthority;

    seedTerminal(runDirectory, "error", { kind: "error", role: "judge", runId, diagnostic: "old boom" });
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await sealAcceptedSubmission({
      cwd: project, home, runId, runDirectory, role: "judge",
      details: { judgeStatus: "pass" },
    });
    const settled = await trySettlePublicSeat(admitted, authority, undefined);
    assert.equal(settled?.roleOutcome.kind, "accepted");
    const afterSuccess = readRunTerminal(runDirectory);
    assert.equal(afterSuccess.status, "present");
    if (afterSuccess.status === "present") {
      assert.equal(afterSuccess.face, "report");
      assert.equal(
        (afterSuccess.body.outcome as { kind?: string } | undefined)?.kind,
        "accepted",
      );
      assert.equal(afterSuccess.body.diagnostic, undefined, "the old failure's body is gone, not merged");
    }

    await publishFailureTerminal(admitted, { diagnostic: "new boom", cause: "provider" }, {
      sessionDirectory,
      sessionFile: join(sessionDirectory, "session.jsonl"),
    });
    const afterFailure = readRunTerminal(runDirectory);
    assert.equal(afterFailure.status, "present");
    if (afterFailure.status === "present") {
      assert.equal(afterFailure.face, "error");
      assert.equal(afterFailure.body.diagnostic, "new boom");
      assert.equal(afterFailure.body.outcome, undefined, "the success's body is gone, not merged");
    }
  });
});

/**
 * #953: settleHostEndedNoReceipt replaces the leg's terminal with the no_receipt
 * face (last write wins); the sibling run, the submission history and the
 * session stay. Reader contract only.
 */
test("#953 no_receipt replaces the owned terminal; sibling, history and session retained", async () => {
  await withTempHome(async (home) => {
    const runId = "01a0-953-noreceipt";
    const siblingRunId = "01a0-953-sibling";
    const runsRoot = join(home, ".ak-roles", "books", "proj", "unbound", "runs");
    const runDirectory = join(runsRoot, `${runId}@judge`);
    const siblingDirectory = join(runsRoot, `${siblingRunId}@judge`);
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(siblingDirectory, { recursive: true });

    const sessionFile = join(sessionDirectory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "custom",
        customType: "ak_attempt_history",
        data: { sequence: 1, role: "judge", runId, note: "prior attempt" },
        id: "hist-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const ledgerPath = join(runDirectory, "history.jsonl");
    await writeFile(
      ledgerPath,
      `${JSON.stringify({ kind: "submission", runId, payload: { judgeStatus: "continue" } })}\n`,
      "utf8",
    );

    const admitted = fixtureJudgeAdmitted({
      runId,
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    seedTerminal(runDirectory, "report", {
      role: "judge", runId, outcome: { kind: "accepted", role: "judge" },
    });
    // Sibling terminal the shared reader must keep after the target's no_receipt.
    seedTerminal(siblingDirectory, "error", {
      kind: "error",
      role: "judge",
      runId: siblingRunId,
      diagnostic: "sibling-owned",
    });

    const before = readRunTerminal(runDirectory);
    assert.equal(before.status, "present");
    if (before.status === "present") assert.equal(before.face, "report");

    const hostEnded = await settleHostEndedNoReceipt(
      admitted,
      piDurablePrincipalAuthority,
    );
    assert.equal(hostEnded.roleOutcome.kind, "no_receipt");
    assert.deepEqual(hostEnded.artifacts, []);

    // The earlier success is replaced, not kept beside: the reader sees the
    // no_receipt face (which the analyst reads as "no accepted receipt").
    const after = readRunTerminal(runDirectory);
    assert.equal(after.status, "present");
    if (after.status === "present") {
      assert.equal(after.face, "no_receipt");
      assert.equal((after.body.outcome as { kind?: string } | undefined)?.kind, "no_receipt");
    }

    const sibling = readRunTerminal(siblingDirectory);
    assert.equal(sibling.status, "present");
    if (sibling.status === "present") {
      assert.equal(sibling.face, "error");
      assert.equal(sibling.body.diagnostic, "sibling-owned");
    }

    // history.jsonl also carries the facts settlement appends; the planted row is
    // the one non-sitian line, and it must survive byte-for-byte in meaning.
    const ledgerEntry = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { kind?: string })
      .find((row) => row.kind === "submission") as {
      kind?: string;
      runId?: string;
      payload?: { judgeStatus?: string };
    };
    assert.equal(ledgerEntry.kind, "submission");
    assert.equal(ledgerEntry.runId, runId);
    assert.equal(ledgerEntry.payload?.judgeStatus, "continue");

    const historyEntries = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            customType?: string;
            data?: { sequence?: number; role?: string; runId?: string };
          },
      );
    const history = historyEntries.find(
      (entry) => entry.customType === "ak_attempt_history",
    );
    assert.ok(history, "attempt history custom entry must remain");
    assert.equal(history?.data?.sequence, 1);
    assert.equal(history?.data?.role, "judge");
    assert.equal(history?.data?.runId, runId);
  });
});
