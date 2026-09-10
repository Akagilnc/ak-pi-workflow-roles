import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { payloadFacts, payloadStatus } from "../helpers/terminal-payload.ts";
// #107/#373 public-CLI acceptance tracer — 公开入口因果身份家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { formatFailureStderrDiagnostic } from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";

// #107 公开入口——Error Artifact 耐久性与 provider 身份家族（#420 整改拆分第二片）。

// Error Artifact durable-fallback depth matrix (#420 整改并一)：单碰撞与耗尽三名
// 同根「发布碰撞 → 耐久回退保原因」，收成一条两深度场景案。
test("Error Artifact publication collisions retain original cause via durable fallback at both depths", async () => {
  const rows = [
    {
      label: "single primary collision",
      runId: "run-error-artifact-collision-001",
      plant: async (runDir: string) => {
        // Primary Error Artifact path occupied as a directory → writeFile EISDIR.
        await mkdir(join(runDir, "artifacts", "error.json"), { recursive: true });
      },
    },
    {
      label: "exhausted fixed names",
      runId: "run-error-artifact-exhausted-001",
      plant: async (runDir: string) => {
        // Occupy every fixed preferred Error Artifact candidate as a directory.
        // Settlement must not escape to outer catch with only the last EISDIR.
        await mkdir(join(runDir, "artifacts", "error.json"), { recursive: true });
        await mkdir(join(runDir, "artifacts", "error.settlement.json"), { recursive: true });
        await mkdir(join(runDir, "error.settlement.json"), { recursive: true });
      },
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, `activation then ${row.label}`],
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
            const runDir = join(sessionDir, "..");
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
        publicationIssues?: Array<{ identity?: { code?: string | number } }>;
      };
      assert.equal(errorBody.cause, "activation", row.label);
      assert.equal(errorBody.diagnostic, "Error: original activation boom\n", row.label);
      assert.ok(Array.isArray(errorBody.publicationIssues), row.label);
      assert.ok(
        errorBody.publicationIssues!.some((issue) => issue.identity?.code === "EISDIR"),
        `${row.label}: durable fallback must retain the primary publication collision identity`,
      );
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
    const result = await runAkRole(
      ["judge", "--project", project, "malformed session transcript"],
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
      const result = await runAkRole(
        ["judge", "--project", project, "activation boom then unwritable run"],
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
test("post-admission stderr.log EISDIR keeps child primary and still settles Terminal + Error Artifact", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "stderr log blocked"],
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
    const result = await runAkRole(
      ["judge", "--project", project, "multiline throw"],
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
      expectedCause: "unrecognized",
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
      cause: "unrecognized",
      diagnostic: multiline,
    });
    assert.ok(helper.includes(multiline));
  });
});
test("public Reviewer no-task dispatch retains evidence-child provider identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "openai-codex/gpt-5.6-sol:medium",
        "reviewer",
        "--project",
        project,
        "--base",
        "HEAD",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-reviewer-evidence-child-provider-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const sessionFile = args[args.indexOf("--session") + 1]!;
          const childDir = join(sessionDir, "evidence-children");
          await mkdir(childDir, { recursive: true });
          await writeFile(
            sessionFile,
            [
              JSON.stringify({ type: "session", id: "parent-session" }),
              JSON.stringify({
                type: "custom",
                customType: "ak-navigator-invocation",
                data: { role: "reviewer" },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          await writeFile(
            join(childDir, "leg-standards.jsonl"),
            [
              JSON.stringify({
                type: "session",
                id: "standards-session",
                parentSession: sessionFile,
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "Codex error: The usage limit has been reached",
                  provider: "openai-codex",
                  model: "gpt-5.6-sol",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          return {
            code: 1,
            // Generic extension wash — identity must come from evidence-children, not stderr.
            stderr:
              "Extension error (.../extensions/role-runtime.ts): Reviewer dispatch execution failed\n",
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
      expectedCause: "unrecognized",
      diagnosticEquals: "Codex error: The usage limit has been reached",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "unrecognized");
      assert.equal(
        terminal.roleOutcome.diagnostic,
        "Codex error: The usage limit has been reached",
      );
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      details?: { errorMessage?: string };
    };
    assert.equal(errorBody.cause, "unrecognized");
    assert.equal(errorBody.diagnostic, "Codex error: The usage limit has been reached");
    assert.equal(errorBody.details?.errorMessage, "Codex error: The usage limit has been reached");
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
          [row.role, row.phase, "--project", project, `${row.role} ${status} discriminator`],
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
          assert.equal(payloadStatus(result.terminal!.roleOutcome), status, `${row.role}:${status}`);
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
