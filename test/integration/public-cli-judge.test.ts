import { submittedParams, terminalBodyAt } from "../helpers/run-dossier-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";

import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "../helpers/role-turn-host-fixture.ts";
/**
 * #106 public Judge path — admission, freeze, terminal settlement.
 * Seams: public argument validation / admission / Terminal /
 * runAkRole(judge) with injectable Pi runner.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { payloadStatusSequence, objectPayloads } from "../helpers/terminal-payload.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitPublicRole,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";
import {
  type TerminalRoleOutcome,
} from "../../src/public-cli/terminal.ts";
import {
  packageRoot,
} from "../helpers/pi-test-harness.ts";

import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

function sessionToolResultLine(toolName: string, details: unknown): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      isError: false,
      details,
    },
  })}\n`;
}

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-judge-", scenario);
}

test("S1: judge escalate public CLI keeps decisionGate options on typed payload in order", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const options = ["采纳既有法源", "改采审刑院意见"];
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "show escalation options"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-s1-judge-options",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const details = {
            status: "escalate",
            decisionGate: { question: "请二选一", options },
          };
          await writeFile(
            join(sessionDir, "session.jsonl"),
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, details),
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge" as const, details },
          };
        },
          }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), ["escalate"]);
    const payload = objectPayloads(result.terminal.roleOutcome)[0] ?? {};
    assert.deepEqual(payload.decisionGate, { question: "请二选一", options });
  });
});

test("parseJudgeArgv rejects public burden selectors and unknown flags", () => {
  // Typed structural reject only (AC6) — never freeze human diagnostic phrasing.
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
  // The burden-selector refusals are carried by the real CLI case below
  // ("runAkRole judge rejects burden selector before admission"); asserting
  // them here as well would restate the same conclusion.
  assert.throws(() => parsePublicSeatArgv("judge", ["--unknown-flag"]), isUsage);
  const parsed = parsePublicSeatArgv("judge", [
    "--attach",
    "a.md",
    "--project",
    "/tmp/p",
    "opaque",
    "instruction",
  ]);
  assert.equal(parsed.instruction, "opaque instruction");
  assert.deepEqual(parsed.attachmentPaths, ["a.md"]);
  assert.equal(parsed.project, "/tmp/p");
});

test("parseJudgeArgv rejects blank --project/--attach path values", () => {
  // Typed structural reject only (AC6) — path-flag prose is unfrozen presentation.
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
  assert.throws(() => parsePublicSeatArgv("judge", ["--project=", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--project", "", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--project", "   ", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("judge", ["--attach=", "task"]), isUsage);
});

test("admitJudgeInvocation freezes regular-file attachments against later mutation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const source = join(home, "evidence.txt");
    await writeFile(source, "admitted-bytes-v1", "utf8");

    const admitted = await admitPublicRole("judge", {
      instruction: "review the attachment",
      attachmentPaths: [source],
    }, {
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      createRunId: () => "run-freeze-001",
    });

    assert.equal(admitted.attachments.length, 1);
    const frozen = admitted.attachments[0]!;
    assert.equal(await readFile(frozen.frozenPath, "utf8"), "admitted-bytes-v1");
    const frozenSha = frozen.sha256;

    await writeFile(source, "mutated-after-admission", "utf8");
    assert.equal(await readFile(frozen.frozenPath, "utf8"), "admitted-bytes-v1");
    assert.equal(frozen.sha256, frozenSha);

    await unlink(source);
    assert.equal(await readFile(frozen.frozenPath, "utf8"), "admitted-bytes-v1");

    // #78 placement: run under book runs/, session reserved, no index content bytes.
    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(admitted.bookKey, bookKey);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-freeze-001@judge"),
    );
    assert.equal(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, join(admitted.runDirectory, "session"));
    await access(join(admitted.runDirectory, "current.json"));
    // #855: two-face waiting.jsonl deleted — admit must not create it.
    await assert.rejects(
      () => readFile(join(home, ".ak-roles", "books", bookKey, "waiting.jsonl"), "utf8"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});

test("runAkRole judge rejects burden selector before admission", async () => {
  await withTempHome(async (home) => {
    const { io, stderr } = captureIo();
    let ran = false;
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--burden", "heavy", "task"], {
      packageRoot,
      home,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        ran = true;
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(ran, false);
    // Emission happened; phrasing is unfrozen presentation (AC6).
    assert.equal(stderr.length >= 1, true);
    assert.equal(result.terminal, undefined);
    assert.equal(existsSync(join(home, ".ak-roles", "books")), false, "rejected flag must not admit a run");
  });
});

test("runAkRole Judge publishes accepted Terminal facts when its audit has no receipt", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    // ADR 0049 host correlation channel remains optional env; no lease mint.
    const attachment = join(home, "note.txt");
    const instruction = "Decide whether the attachment is sufficient.";
    await writeFile(attachment, "freeze-me", "utf8");

    const { io, stdout, stderr } = captureIo();
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedStdin: string | undefined;

    const result = await runAkRole([
        "judge", "--model", "test/caller-seat:high",
        "--attach",
        attachment,
        "--project",
        project,
        instruction,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        correlationId: "corr-106-unit",
        createRunId: () => "run-cli-judge-001",
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
          capturedArgs = [...args];
          capturedEnv = options.env;
          capturedStdin = options.stdin;
          const sessionDirIdx = args.indexOf("--session-dir");
          assert.ok(sessionDirIdx >= 0);
          const sessionDir = args[sessionDirIdx + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const sessionFile = join(sessionDir, "session.jsonl");
          const subjectKey = join(project, ".ak/work");
          const rows = [
            {
              type: "custom",
              customType: "ak-navigator-invocation",
              data: {
                invocationId: "019f8c2a-5555-7555-8555-555555555555",
                role: "judge",
                phase: null,
                subjectKey,
              },
            },
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: {
                  status: "converged",
                  note: "ok",
                  auditNoReceipt: {
                    status: "no-receipt",
                    terminalToolCalled: false,
                    rejectedReceipts: [],
                    deliveryTurns: 2,
                    sessionCompletion: "settled-without-accepted-receipt",
                    runPointer: "/audit/run",
                    attemptPointer: "audit-attempt",
                    acceptedReceipt: false,
                  },
                },
              },
            },
            {
              type: "custom",
              customType: "ak-role-submission-closure",
              data: { toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details: { status: "converged" }, navigator: { disposition: "advice", prose: "review next → reviewer" } },
            },
            {
              type: "custom_message",
              customType: "ak-navigator-attendance",
              message: {
                details: {
                  version: 1,
                  disposition: "advice",
                  invocationId: "019f8c2a-5555-7555-8555-555555555555",
                  role: "judge",
                  phase: null,
                  // Deliberately contradict the bound closure: this late delivery
                  // must not replace the result of the admitted invocation.
                  subjectKey: "/other/work",
                  prose: "late advice from another call",
                },
              },
            },
          ];
          await writeFile(
            sessionFile,
            `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: {
              role: "judge" as const,
              details: {
                status: "converged",
                note: "ok",
                auditNoReceipt: {
                  status: "no-receipt",
                  terminalToolCalled: false,
                  rejectedReceipts: [],
                  deliveryTurns: 2,
                  sessionCompletion: "settled-without-accepted-receipt",
                  runPointer: "/audit/run",
                  attemptPointer: "audit-attempt",
                  acceptedReceipt: false,
                },
              },
            },
          };
        },
          }),
      },
    );

    assert.equal(result.exitCode, 0, stderr.join(""));
    assert.equal(Array.isArray(capturedArgs), true);
    assert.equal(capturedArgs![0], "--no-extensions");
    assert.equal(capturedArgs!.includes("--ak-role"), true);
    assert.equal(capturedArgs!.includes("judge"), true);
    // No public burden selector on the Internal activation line.
    assert.equal(
      capturedArgs!.some((arg) => arg.includes("burden")),
      false,
    );

    assert.equal(
      typeof capturedEnv?.AK_ROLE_RUN_DIR === "string" &&
        capturedEnv.AK_ROLE_RUN_DIR.includes("run-cli-judge-001@judge"),
      true,
    );

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      "run-cli-judge-001@judge",
    );
    assert.ok(result.terminal);
    const terminal = result.terminal;
    assert.equal(stdout.length, 1);
    assert.notEqual(stdout[0]?.trim(), "");
    assert.equal(terminal.roleOutcome.role, "judge");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(terminal.roleOutcome), ["converged"]);
    assert.equal(
      ((objectPayloads(terminal.roleOutcome)[0] ?? {}).auditNoReceipt as { acceptedReceipt?: unknown })?.acceptedReceipt,
      false,
    );
    assert.equal(terminal.navigator.disposition, "advice");
    if (terminal.navigator.disposition === "advice") {
      assert.equal(terminal.navigator.prose, "review next → reviewer");
    }
    assert.equal(terminal.runId, "run-cli-judge-001");
    assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);

    // Artifacts are openable paths under the run directory.
    for (const artifact of terminal.artifacts) {
      await access(artifact.path);
    }
    const reportRef = terminal.artifacts.find((a) => a.kind === "report")!;
    const report = terminalBodyAt(reportRef.path, "report") as { role: string; runId: string; outcome: TerminalRoleOutcome };
    assert.equal(report.role, "judge");
    assert.equal(report.runId, "run-cli-judge-001");
    assert.equal(report.outcome.kind, "accepted");
    // #836: the role's original payload (not an invented top-level status) is what
    // history.jsonl kept; the persisted report carries only the verdict.
    assert.equal("payloads" in report.outcome, false);
    assert.deepEqual(
      submittedParams(dirname(reportRef.path)).map((params) => (params as { status?: string }).status),
      ["converged"],
    );

    // Source mutation after admission does not affect frozen snapshot.
    await writeFile(attachment, "changed", "utf8");
    const frozenPath = join(runDir, "attachments", "00-note.txt");
    const delivered = readUserDialogueStdin(capturedStdin ?? "");
    assert.ok(delivered.includes(instruction));
    assert.ok(delivered.includes(frozenPath));
    assert.equal(delivered.includes(attachment), false);
    assert.equal(await readFile(frozenPath, "utf8"), "freeze-me");
  });
});

test("runAkRole judge empty request does not invent semantic task content on the transport", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "empty-proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    const { io, stdout } = captureIo();
    let prompt: string | undefined;

    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-empty-001",
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
        prompt = readUserDialogueStdin(String(options.stdin ?? ""));
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        const details = { status: "converged" };
        await writeFile(
          join(sessionDir, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details,
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
          sealedAcceptance: { role: "judge" as const, details },
        };
      },
          }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(prompt, "");
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0]!.length > 0);

    assert.ok(result.terminal);
    const terminal = result.terminal;
    // Missing attendance is not successful no-advice — require affirmative typed fact.
    assert.equal(terminal.navigator.disposition, "unavailable");
    if (terminal.navigator.disposition === "unavailable") {
      assert.equal(terminal.navigator.source, "unknown");
      assert.equal(typeof terminal.navigator.reason, "string");
    }
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(terminal.roleOutcome), ["converged"]);
  });
});
