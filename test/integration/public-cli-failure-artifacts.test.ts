import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
// #107/#373 public-CLI acceptance tracer — 公开入口因果身份家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  coalesceSubmissionRows,
  type TerminalResult,
} from "../../src/public-cli/terminal.ts";
import {
  formatFailureStderrDiagnostic,
  publishFailureArtifacts,
  publishJudgeArtifacts,
  settleHostEndedNoReceipt,
  withSubmissions,
} from "../../src/public-cli/settlement.ts";
import { readRunTerminalArtifact } from "../../src/run-terminal-artifacts.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";

// #107 公开入口——Error Artifact 耐久性与 provider 身份家族（#420 整改拆分第二片）。

/**
 * Occupy a face path as a directory write barrier. Resume-safe: a prior
 * settlement may have cleared a directory plant and written a file at the same
 * path (#953 face refresh); replace any existing face before replanting.
 */
async function plantDirectoryFace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

// Error Artifact directory-face collision matrix (#420 并一；#953 清面后 reader 可见)：
// 单碰撞与耗尽固定名同根「目录占位 → 发布前清面 → 耐久发布保原因，reader 见本次失败」。
test("Error Artifact publication collisions retain original cause and reader-visible failure at both depths", async () => {
  const rows = [
    {
      label: "single primary collision",
      runId: "run-error-artifact-collision-001",
      plant: async (runDir: string) => {
        // Primary Error Artifact path occupied as a directory → clear must remove it.
        await plantDirectoryFace(join(runDir, "artifacts", "error.json"));
      },
    },
    {
      label: "exhausted fixed names",
      runId: "run-error-artifact-exhausted-001",
      plant: async (runDir: string) => {
        // Occupy every fixed preferred Error Artifact candidate as a directory.
        // Clear drops them all; publish must still settle a durable failure face.
        await plantDirectoryFace(join(runDir, "artifacts", "error.json"));
        await plantDirectoryFace(join(runDir, "artifacts", "error.settlement.json"));
        await plantDirectoryFace(join(runDir, "error.settlement.json"));
      },
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      let runDir: string | undefined;
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, `activation then ${row.label}`],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => row.runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            runDir = join(sessionDir, "..");
            await row.plant(runDir);
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stderr: "Error: original activation boom\n",
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
        expectedCause: "activation",
        diagnosticEquals: "Error: original activation boom\n",
      });
      assert.equal(terminal.roleOutcome.kind, "failure", row.label);
      if (terminal.roleOutcome.kind === "failure") {
        // Original controlled failure must not be washed to the publication errno.
        assert.equal(terminal.roleOutcome.cause, "activation", row.label);
        assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR", row.label);
        assert.equal(terminal.roleOutcome.diagnostic, "Error: original activation boom\n", row.label);
      }
      const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        cause: string;
        diagnostic: string;
      };
      assert.equal(errorBody.cause, "activation", row.label);
      assert.equal(errorBody.diagnostic, "Error: original activation boom\n", row.label);
      // #953: public terminal face must reflect this failure, not stale directory EISDIR.
      assert.ok(runDir !== undefined, row.label);
      const read = await readRunTerminalArtifact(runDir!);
      assert.equal(read.status, "present", row.label);
      if (read.status === "present") {
        assert.equal(read.body.cause, "activation", row.label);
        assert.equal(read.body.diagnostic, "Error: original activation boom\n", row.label);
      }
      // One complete Terminal — must not escape to outer raw catch with zero stdout.
      assert.equal(stdout.length, 1, row.label);
      assert.equal(result.terminal !== undefined, true, row.label);
    });
  }
});

test("malformed session JSONL settles as typed session failure retaining SyntaxError identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "malformed session transcript"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-malformed-session-jsonl-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          // Invalid JSONL must not wash into cause=output generic absence.
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

    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "session",
      identityName: "SyntaxError",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "session");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "SyntaxError");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string };
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "session");
    assert.equal(errorBody.identity?.name, "SyntaxError");
    assert.equal(errorBody.diagnostic, terminal.roleOutcome.diagnostic);
    assert.equal(stdout.length, 1);
    assert.equal(
      stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
      1,
    );
  });
});
test("unwritable run directory retains activation cause with durable Error Artifact and Terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    let runDir: string | undefined;
    try {
      const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "activation boom then unwritable run"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-unwritable-run-dir-001",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            runDir = join(sessionDir, "..");
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            // Lock the entire run tree after the child failure is observed.
            // Settlement must escape to the ledger runs/ parent, keep boom primary,
            // and still emit one Terminal — not outer-catch EACCES alone.
            await chmod(runDir, 0o555);
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

      const { terminal, errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "activation",
        diagnosticEquals: "Error: boom\n",
      });
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.cause, "activation");
        assert.equal(terminal.roleOutcome.diagnostic, "Error: boom\n");
        assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EACCES");
      }
      const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        cause: string;
        diagnostic: string;
        publicationIssues?: Array<{ identity?: { code?: string | number } }>;
      };
      assert.equal(errorBody.cause, "activation");
      assert.equal(errorBody.diagnostic, "Error: boom\n");
      assert.ok(Array.isArray(errorBody.publicationIssues));
      assert.ok(
        errorBody.publicationIssues!.some(
          (issue) => issue.identity?.code === "EACCES",
        ),
        "publication trouble must remain secondary on the durable Error Artifact",
      );
      assert.equal(stdout.length, 1);
      assert.equal(result.terminal !== undefined, true);
    } finally {
      if (runDir !== undefined) {
        try {
          await chmod(runDir, 0o755);
        } catch {
          // cleanup best-effort
        }
      }
    }
  });
});
test("post-admission stderr.log EISDIR keeps child primary and still settles Terminal + Error Artifact; an accepted turn does not silently outrun it", async () => {
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
          // stderr.log as a directory makes the post-admission writeFile raise EISDIR.
          // Mirror IO is best-effort — must not wash the already-observed child cause.
          await mkdir(join(runDir, "stderr.log"), { recursive: true });
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
      expectedCause: "activation",
      diagnosticEquals: "Error: child failed after admission\n",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "activation");
      assert.equal(terminal.roleOutcome.diagnostic, "Error: child failed after admission\n");
      // Auxiliary stderr.log errno must not become the primary identity.
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "activation");
    assert.equal(errorBody.diagnostic, "Error: child failed after admission\n");
    // Must not bypass to outer raw catch (no Terminal / no Error Artifact).
    assert.equal(stdout.length, 1);
    assert.equal(result.terminal !== undefined, true);
  });

  // A turn that DID seal an accepted submission must not silently outrun a
  // real durable-write infrastructure failure — the stderr.log mirror is not
  // "best-effort noise" here; it is a real IO failure and must be presented
  // loudly, with the already-accepted payload riding beside it (never lost,
  // never presented as if nothing went wrong).
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const acceptedDetails = { judgeStatus: "converged", note: "ok" };
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "accepted then stderr.log blocked"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-stderr-log-eisdir-accepted-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            const runDir = join(sessionDir, "..");
            // stderr.log as a directory makes the post-admission writeFile
            // raise EISDIR — even though the child accepted a lawful verdict.
            await mkdir(join(runDir, "stderr.log"), { recursive: true });
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
        }),
      },
    );
    // Not accepted — the durable-write failure is a real problem, not noise.
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    if (result.terminal?.roleOutcome.kind === "failure") {
      // The already-sealed payload rides beside the failure, never lost.
      assert.ok(
        result.terminal.submissions?.some(
          (row) =>
            typeof row === "object" && row !== null &&
            (row as { judgeStatus?: unknown }).judgeStatus === "converged",
        ),
        JSON.stringify(result.terminal.submissions),
      );
    }
    assert.equal(stdout.length, 1);
  });
});
test("multiline thrown diagnostic keeps full artifact identity and one stderr line", async () => {
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
      assert.equal(terminal.roleOutcome.diagnostic.includes("\n"), true);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      diagnostic: string;
    };
    assert.equal(errorBody.diagnostic, multiline);
    // stderr presentation is exactly one nonblank line, no stack/event/token flood.
    // Do not assert selected diagnostic prose on stderr (AC6) — durable identity is above.
    const presented = stderr[0]!;
    assert.ok(presented.includes(multiline));
    const helper = formatFailureStderrDiagnostic({
      diagnostic: multiline,
    });
    assert.ok(helper.includes(multiline));
  });
});
test("public Judge settles failed typed output evidence before nonzero stderr fallback", async () => {
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
    // Host infrastructure terminating-tool failure keeps activation cause — not shape-output (#675).
    assert.equal(result.terminal!.roleOutcome.cause, "activation");
    assert.equal(result.terminal!.roleOutcome.diagnostic, "pi host could not load its runtime");
    assert.equal(JSON.stringify(result.terminal).includes("VARIABLE DECOY"), false);
    const errorRef = result.terminal!.artifacts.find((artifact) => artifact.kind === "error");
    assert.ok(errorRef);
    const durable = JSON.parse(await readFile(errorRef.path, "utf8"));
    assert.equal(durable.diagnostic, "pi host could not load its runtime");
    assert.deepEqual(durable.identity, { name: "ak_judge_output", code: "host-failed-output" });
    assert.deepEqual(durable.details, {
      kind: "role_infrastructure_failure",
      source: "shared-role-lifecycle",
      reasonCode: "host_failure",
      exitCode: 1,
    });
    assert.equal(JSON.stringify(durable).includes("VARIABLE DECOY"), false);
    assert.equal(stdout.length, 1);
    assert.ok(stderr.length > 0);
  });
});
test("real Coder/Fixer runs settle on the recorded status, or honestly no_receipt when unsealed", async () => {
  await withTempHome(async (home) => {
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
            roleTurnHost: roleTurnHostFromLegacyPiRunner({
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
          }),
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
    const { io, stdout, stderr } = captureIo();
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

// --- #953 absorbed from issue-953-summons-receipt (no parallel seedJudgeRun) ---

test("#953 empty failure payloads do not shadow recorded submissions", () => {
  const history = [{ judgeStatus: "continue" }] as const;
  assert.deepEqual(coalesceSubmissionRows([], history), [...history]);
  assert.deepEqual(coalesceSubmissionRows(undefined, history), [...history]);
  assert.deepEqual(
    coalesceSubmissionRows([{ judgeStatus: "pass" }], history),
    [{ judgeStatus: "pass" }],
  );

  const failureTerminal: TerminalResult = {
    roleOutcome: {
      kind: "failure",
      role: "judge",
      diagnostic: "boom",
      cause: "provider",
      payloads: [],
      decisiveFacts: { diagnostic: "boom", cause: "provider" },
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "01a0-953-empty-payloads",
  };
  const attached = withSubmissions(failureTerminal, history);
  assert.equal(attached.roleOutcome.kind, "failure");
  if (attached.roleOutcome.kind === "failure") {
    assert.deepEqual(attached.roleOutcome.payloads, [...history]);
  }
  assert.deepEqual(attached.submissions, [...history]);
});

test("#953 reader adopts current failure after success; success after failure", async () => {
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
    const artifactsDir = join(runDirectory, "artifacts");
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(sessionDirectory, "session.jsonl"), "", "utf8");
    const admitted = fixtureJudgeAdmitted({
      runId,
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    const authority = piDurablePrincipalAuthority;

    await writeFile(
      join(artifactsDir, "error.json"),
      `${JSON.stringify({ kind: "error", role: "judge", runId, diagnostic: "old boom" })}\n`,
      "utf8",
    );
    await publishJudgeArtifacts(
      admitted,
      {
        kind: "accepted",
        role: "judge",
        payloads: [{ judgeStatus: "pass" }],
      },
      authority.decode(admitted.principal),
    );
    const afterSuccess = await readRunTerminalArtifact(runDirectory);
    assert.equal(afterSuccess.status, "present");
    if (afterSuccess.status === "present") {
      assert.equal(
        (afterSuccess.body.outcome as { kind?: string } | undefined)?.kind,
        "accepted",
      );
    }

    await publishFailureArtifacts(
      admitted,
      { diagnostic: "new boom", cause: "provider" },
      authority,
    );
    const afterFailure = await readRunTerminalArtifact(runDirectory);
    assert.equal(afterFailure.status, "present");
    if (afterFailure.status === "present") {
      assert.equal(afterFailure.body.diagnostic, "new boom");
    }
  });
});

test("#953 clear-fail leaves residual success face but reader still adopts current failure", async () => {
  await withTempHome(async (home) => {
    const runId = "01a0-953-shadow";
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
    const artifactsDir = join(runDirectory, "artifacts");
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(sessionDirectory, "session.jsonl"), "", "utf8");
    const admitted = fixtureJudgeAdmitted({
      runId,
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    const residualReportPath = join(artifactsDir, "report.json");
    await writeFile(
      residualReportPath,
      `${JSON.stringify({
        role: "judge",
        runId,
        outcome: {
          kind: "accepted",
          role: "judge",
          payloads: [{ judgeStatus: "continue" }],
        },
      })}\n`,
      "utf8",
    );
    await chmod(artifactsDir, 0o555);
    try {
      const refs = await publishFailureArtifacts(
        admitted,
        { diagnostic: "CURRENT FAILURE", cause: "provider" },
        piDurablePrincipalAuthority,
      );
      assert.ok(refs.some((ref) => ref.kind === "error"));
      // Prove the clear seam actually failed: prior success face must remain.
      await access(residualReportPath);
      const residual = JSON.parse(
        await readFile(residualReportPath, "utf8"),
      ) as {
        outcome?: { kind?: string; payloads?: ReadonlyArray<{ judgeStatus?: string }> };
      };
      assert.equal(residual.outcome?.kind, "accepted");
      assert.equal(residual.outcome?.payloads?.[0]?.judgeStatus, "continue");
      const read = await readRunTerminalArtifact(runDirectory);
      assert.equal(read.status, "present");
      if (read.status === "present") {
        assert.equal(read.body.diagnostic, "CURRENT FAILURE");
        assert.notEqual(
          (read.body.outcome as { kind?: string } | undefined)?.kind,
          "accepted",
        );
      }
    } finally {
      await chmod(artifactsDir, 0o755);
    }
  });
});

/**
 * #953: settleHostEndedNoReceipt clears every reader-adoptable owned face and
 * leaves sibling / unbound parent unique, evidence, ledger, and attempt history.
 * Does not mint a no_receipt-shaped public artifact.
 */
test("#953 no_receipt clear matrix: owned faces gone; sibling/evidence/history retained", async () => {
  await withTempHome(async (home) => {
    const runId = "01a0-953-noreceipt";
    const siblingRunId = "01a0-953-sibling";
    const runsRoot = join(home, ".ak-roles", "books", "proj", "unbound", "runs");
    const runDirectory = join(runsRoot, `${runId}@judge`);
    const siblingDirectory = join(runsRoot, `${siblingRunId}@judge`);
    const sessionDirectory = join(runDirectory, "session");
    const artifactsDir = join(runDirectory, "artifacts");
    const ledgerDir = join(runDirectory, "session", "submission-ledger");
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(ledgerDir, { recursive: true });
    await mkdir(join(siblingDirectory, "artifacts"), { recursive: true });

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
    const evidencePath = join(artifactsDir, "evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify({ runId, role: "judge", note: "keep-me" })}\n`,
      "utf8",
    );
    const ledgerPath = join(ledgerDir, "records.jsonl");
    await writeFile(
      ledgerPath,
      `${JSON.stringify({ kind: "submission", runId, payload: { judgeStatus: "continue" } })}\n`,
      "utf8",
    );

    const faceBody = (kind: string, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ role: "judge", runId, kind, ...extra })}\n`;

    // Conventional faces
    await writeFile(
      join(artifactsDir, "report.json"),
      `${JSON.stringify({
        role: "judge",
        runId,
        outcome: { kind: "accepted", role: "judge", payloads: [] },
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactsDir, "error.json"),
      faceBody("error", { diagnostic: "conventional" }),
      "utf8",
    );
    await writeFile(
      join(artifactsDir, "audit-incomplete.json"),
      faceBody("audit-incomplete", { diagnostic: "audit" }),
      "utf8",
    );
    // Fixed fallbacks
    await writeFile(
      join(artifactsDir, "error.settlement.json"),
      faceBody("error", { diagnostic: "fixed-artifacts" }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "error.settlement.json"),
      faceBody("error", { diagnostic: "fixed-run" }),
      "utf8",
    );
    // Same-run unique
    const sameRunUnique = join(
      artifactsDir,
      "error.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json",
    );
    await writeFile(
      sameRunUnique,
      faceBody("error", { diagnostic: "same-run-unique" }),
      "utf8",
    );
    // Parent unique bound to this runId — must clear
    const ownedParentUnique = join(
      runsRoot,
      "error.11111111-2222-3333-4444-555555555555.json",
    );
    await writeFile(
      ownedParentUnique,
      `${JSON.stringify({
        role: "judge",
        runId,
        kind: "error",
        diagnostic: "owned-parent",
      })}\n`,
      "utf8",
    );
    // Sibling-bound parent unique — must retain
    const siblingParentUnique = join(
      runsRoot,
      "error.66666666-7777-8888-9999-aaaaaaaaaaaa.json",
    );
    await writeFile(
      siblingParentUnique,
      `${JSON.stringify({
        role: "judge",
        runId: siblingRunId,
        kind: "error",
        diagnostic: "sibling-owned",
      })}\n`,
      "utf8",
    );
    // Unbound / no runId parent unique — must retain
    const unboundParentUnique = join(
      runsRoot,
      "error.bbbbbbbb-cccc-dddd-eeee-ffffffffffff.json",
    );
    await writeFile(
      unboundParentUnique,
      `${JSON.stringify({
        role: "judge",
        kind: "error",
        diagnostic: "unbound-parent",
      })}\n`,
      "utf8",
    );

    const admitted = fixtureJudgeAdmitted({
      runId,
      runDirectory,
      projectRoot: join(home, "proj"),
      bookKey: "proj",
    });
    const hostEnded = await settleHostEndedNoReceipt(
      admitted,
      piDurablePrincipalAuthority,
    );
    assert.equal(hostEnded.roleOutcome.kind, "no_receipt");
    assert.deepEqual(hostEnded.artifacts, []);

    const after = await readRunTerminalArtifact(runDirectory);
    assert.equal(after.status, "absent");

    // Owned faces cleared
    for (const path of [
      join(artifactsDir, "report.json"),
      join(artifactsDir, "error.json"),
      join(artifactsDir, "audit-incomplete.json"),
      join(artifactsDir, "error.settlement.json"),
      join(runDirectory, "error.settlement.json"),
      sameRunUnique,
      ownedParentUnique,
    ]) {
      await assert.rejects(() => access(path), { code: "ENOENT" }, path);
    }

    // Retained: sibling / unbound parent unique, evidence, ledger, attempt history
    for (const path of [
      siblingParentUnique,
      unboundParentUnique,
      evidencePath,
      ledgerPath,
      sessionFile,
    ]) {
      await access(path);
    }
    const historyRaw = await readFile(sessionFile, "utf8");
    assert.ok(historyRaw.includes("ak_attempt_history"));
    assert.ok(historyRaw.includes("prior attempt"));
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      note?: string;
    };
    assert.equal(evidence.note, "keep-me");

    // No no_receipt-shaped public artifact minted
    const artifactsNames = await readdir(artifactsDir).catch(() => [] as string[]);
    assert.equal(
      artifactsNames.some((name) => name.includes("no_receipt") || name === "no-receipt.json"),
      false,
    );
  });
});
