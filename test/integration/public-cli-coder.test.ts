import { assertRunDirectoryHoldsOnlyDossier } from "../helpers/run-dossier-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  roleTurnHostFromStructuredOutputRounds,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { readCurrentSection, terminalBodyAt, submittedParams } from "../helpers/run-dossier-fixture.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
/**
 * #109 public Coder path — common Invocation, default apply / explicit plan,
 * package TDD provenance on shared success Terminal interface.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { findRunDirectoryById } from "../../src/public-cli/run-lifecycle.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-coder-", scenario);
}

test("public coder accepts an unreadable status before routing it back for re-submission", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // #1198: missing summary stays accepted; overlong summary kept as submitted.
    const unreadable = { status: { value: "unknown" }, report: { unvalidated: true } };
    const corrected = {
      status: "planned",
      report: { unvalidated: true },
      ticketNumber: 1171,
      summary: "x".repeat(200),
    };
    let handedSchema: unknown;
    const structuredHost = roleTurnHostFromStructuredOutputRounds({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      submissions: [unreadable, corrected],
      onPrepared: ({ jsonSchema }) => {
        handedSchema = jsonSchema;
      },
    });
    let runDirectory = "";
    const roleTurnHost = {
      executeTurn(request: Parameters<typeof structuredHost.executeTurn>[0]) {
        runDirectory = request.runDirectory;
        return structuredHost.executeTurn(request);
      },
    };

    const result = await runAkRole(
      ["coder", "--model", "test/caller-seat:high", "plan", "--project", project, "Propose a plan."],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-cli-coder-status-reask",
        io: captureIo().io,
        roleTurnHost,
      },
    );

    assert.equal(result.exitCode, 0);
    // Public entry hands the host a schema that declares optional summary (#1198).
    assert.ok(handedSchema !== null && typeof handedSchema === "object");
    const schema = handedSchema as {
      properties?: Record<string, { description?: unknown }>;
      required?: unknown;
    };
    const summaryProperty = schema.properties?.summary;
    assert.ok(summaryProperty !== undefined);
    assert.equal(typeof summaryProperty.description, "string");
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    assert.equal(required.includes("summary"), false);
    // A codex-style host leg through the public entry, two rounds: only the dossier at rest (#1161).
    // #1171: corrected seal carries ticketNumber → live path may leave the first-seen unbound dir.
    const liveDirectory =
      (await findRunDirectoryById(home, "run-cli-coder-status-reask")) ?? runDirectory;
    assertRunDirectoryHoldsOnlyDossier(liveDirectory);
    assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["planned"]);
    const submissions = await readRecordedSubmissionRows(project, "run-cli-coder-status-reask", home);
    assert.deepEqual(submissions.map(({ kind, accepted }) => ({ kind, accepted })), [
      { kind: "accepted", accepted: unreadable },
      { kind: "accepted", accepted: corrected },
    ]);
    assert.equal(Object.hasOwn(unreadable, "summary"), false);
    assert.equal((submissions[1]?.accepted as { summary?: unknown }).summary, corrected.summary);
  });
});

/**
 * Replaces direct buildPiTurnExtraArgs argv locks — verifies behavior through
 * the typed request contract, not argv string indexing.
 */

test("coder apply/plan/resume project typed RoleTurnRequest preserves phase and continuation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const captured: { current: RoleTurnRequest | undefined; first: RoleTurnRequest | undefined } = { current: undefined, first: undefined };

    // Apply phase selects the typed apply request.
    {
      await runAkRole(["coder", "--model", "test/caller-seat:high", "--project", project, "Apply the approved plan."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-coder-apply-typed",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: createMinimalHost((request) => {
            captured.first ??= request;
            captured.current = request;
            return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
          }),
        },
      );
      const req = captured.current!;
      assert.equal(req.activation.role, "coder");
      assert.equal(req.activation.phase, "apply");
      assert.equal(captured.first?.continuation.kind, "initial");
      assert.equal(req.continuation.kind, "resume");
      // Host-neutral transport: no Pi `/skill:` on the shared request face (#822).
      assert.equal(req.continuation.prompt.startsWith("/skill:"), false);
    }

    // Plan phase: no method bindings.
    {
      const result = await runAkRole(["coder", "--model", "test/caller-seat:high", "plan", "--project", project, "Plan only."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-coder-plan-typed",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: createMinimalHost((request) => {
            captured.current = request;
            return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
          }),
        },
      );
      assert.equal(result.exitCode, 1);
      const req = captured.current!;
      assert.equal(req.activation.role, "coder");
      assert.equal(req.activation.phase, "plan");
      assert.equal(req.methods.length, 0, "plan must omit method bindings");
    }

    // Resume phase: default envelope selects typed resume continuation.
    {
      // First seed an admitted apply run with accessible session principal coordinates
      await runAkRole(["coder", "--model", "test/caller-seat:high", "--project", project, "Apply the approved plan."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-coder-resume-typed",
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: createMinimalHost(async (request) => {
            const { sessionDirectory, sessionFile } =
              piDurablePrincipalAuthority.decode(request.principal);
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(sessionFile, "", "utf8");
            return { code: 1, stderr: "stop", timedOut: false };
          }),
        },
      );

      captured.current = undefined;
      const result = await runAkRole(["resume", "--model", "test/caller-seat:high", "run-coder-resume-typed"],
        {
          packageRoot,
          home,
          cwd: project,
          io: captureIo().io,
          credentials: { "openai-codex": true, xai: true },
          principalAuthority: piDurablePrincipalAuthority,
          roleTurnHost: createMinimalHost((request) => {
            captured.current = request;
            return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
          }),
        },
      );
      assert.equal(result.exitCode, 1);
      const req = captured.current!;
      assert.equal(req.activation.role, "coder");
      assert.equal(req.activation.phase, "apply");
      // The two-argument invocation above selects the no-explicit-message branch;
      // its structured request must still carry resume continuation semantics.
      assert.equal(req.continuation.kind, "resume");
    }
  });
});

test("alternate host seals accepted Terminal without Pi acceptance leaf", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await runAkRole(["config", "set", "inspector", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const inspectorHost = roleTurnHostFromLegacyPiRunner({
      packageRoot, principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "inspector", toolName: INSPECTOR_OUTPUT_TOOL_NAME,
        details: { status: "converged", ticketNumber: 1171},
      }),
    });
    const receipt = {
      status: "completed" as const,
      report: "Alternate host sealed through production ledger producer.",
      summary: "coder short conclusion",
      ticketNumber: 1171,
    };
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["coder", "--model", "test/caller-seat:high", "--project", project, "Finish without a Pi session leaf."],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-coder-alternate-host",
        io,
        roleTurnHost: createMinimalHost(async (request) => {
          if (request.activation.role === "inspector") return inspectorHost.executeTurn(request);
          const { sessionDirectory, sessionFile } =
            piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          // No Pi acceptance leaf — alternate host walks production ledger → sealed → Terminal.
          await writeFile(sessionFile, "", "utf8");
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home,
            runId: "run-coder-alternate-host",
            runDirectory: request.runDirectory,
            role: "coder",
            details: receipt,
            toolCallId: "alt-1",
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(result.exitCode, 0, stdout.join("") || stderr.join("") || "alternate host failed");
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.roleOutcome.role, "coder");
    assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["completed"]);
    assert.deepEqual(result.terminal!.submissions, [receipt]);
    const report = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(report);
    const reportBody = terminalBodyAt(report.path, "report") as {
      outcome?: { payloads?: unknown };
    };
    // The submitted words live in history.jsonl; the terminal carries only the verdict.
    assert.equal(reportBody.outcome !== undefined && "payloads" in reportBody.outcome, false);
    assert.deepEqual(submittedParams(dirname(report.path)), [receipt]);
  });
});

test("Coder submission remains recorded when the later Inspector transport fails", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await runAkRole(["config", "set", "inspector", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const receipt = { status: "completed" as const, report: "submitted before review", ticketNumber: 1171};
    const runId = "run-coder-inspector-transport-failure";
    const { io } = captureIo();
    const result = await runAkRole(
      ["coder", "--model", "test/caller-seat:high", "--project", project, "Complete the work."],
      {
        packageRoot, home, cwd: project, createRunId: () => runId, io,
        roleTurnHost: createMinimalHost(async (request) => {
          if (request.activation.role === "inspector") {
            const rows = await readRecordedSubmissionRows(project, runId, home);
            assert.equal(rows.at(-1)?.kind, "accepted", "the Coder tool has finished before Inspector dispatch");
            return { code: 1, stderr: "provider unavailable", timedOut: false };
          }
          const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(sessionFile, "", "utf8");
          await sealAcceptedSubmission({
            cwd: request.cwd, home, runId, runDirectory: request.runDirectory,
            role: "coder", details: receipt, toolCallId: "coder-finished",
            ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal((await readRecordedSubmissionRows(project, runId, home)).at(-1)?.kind, "accepted");
  });
});

test("ak-role coder defaults apply, preserves plan, and rejects blank task structurally", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Blank task → structural reject, no run.
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["coder", "--model", "test/caller-seat:high", "plan", "   "], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
          throw new Error("must not dispatch");
        },
          }),
      });
      assert.equal(result.exitCode, 2);
      assert.equal(stderr.join("").length > 0, true);
    }

    // Explicit plan preserved through admission; injectable runner observes phase.
    {
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole([
          "coder", "--model", "test/caller-seat:high",
          "plan",
          "--project",
          project,
          "Propose the first implementation plan.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-coder-plan",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            // Write a lawful planned receipt into the session the args reserved.
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const receipt = {
              status: "planned",
              report: "Plan: one vertical slice with package TDD on apply.",
            };
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "p1",
                  toolName: CODER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "coder" as const, details: receipt, toolCallId: "p1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "coder plan failed");
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured!.includes("--ak-coder-phase"), true);
      assert.equal(
        captured![captured!.indexOf("--ak-coder-phase") + 1],
        "plan",
      );
      assert.equal(captured!.includes("--skill"), false);
      assert.equal(result.terminal?.roleOutcome.role, "coder");
      assert.deepEqual(
        result.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(result.terminal.roleOutcome)
        : [],
      ["planned"],
    );
      await access(
        join(
          home,
          ".ak-roles",
          "books",
          resolveBookKeyFromGit(project),
          "unbound", "runs",
          "run-cli-coder-plan@coder",
          "current.json",
        ),
      );
    }

    // Default phase is apply and pins package skill path.
    {
      const { io } = captureIo();
      let captured: string[] | undefined;
      await runAkRole(["coder", "--model", "test/caller-seat:high", "--project", project, "Implement the approved slice."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-coder-apply",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            return {
              code: 1,
              stderr: "forced stop before model",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.deepEqual(
      Array.isArray(captured), true);
      assert.equal(
        captured![captured!.indexOf("--ak-coder-phase") + 1],
        "apply",
      );
    }
  });
});

test("ak-role resume continues relocated coder plan phase without a gate nest", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await runAkRole(["config", "set", "inspector", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const runId = "run-cli-coder-resume-plan";
    const instruction = "Propose the first implementation plan for resume.";
    const { existsSync } = await import("node:fs");

    {
      const { io } = captureIo();
      const first = await runAkRole(["coder", "--model", "test/caller-seat:high", "plan", "--project", project, instruction],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
            if (args[args.indexOf("--ak-role") + 1] === "inspector") {
              return scriptedTerminatingToolSession({
                role: "inspector", toolName: INSPECTOR_OUTPUT_TOOL_NAME,
                details: { status: "converged", ticketNumber: 1171},
              })(args, options);
            }
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            const sessionFile = join(sessionDir, "session.jsonl");
            const details = {
              status: "partially_completed",
              report: "Initial turn binds the ticket before resume.",
              remainingScope: "Resume the same gate session.",
              ticketNumber: 1003,
            };
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "first",
                  toolName: CODER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "coder" as const, details, toolCallId: "first" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(first.terminal?.roleOutcome.role, "coder");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "1003", "runs",
      `${runId}@coder`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = readCurrentSection(runDirectory, "admitted") as {
      phase: string; role: string; ticketNumber?: number;
    };
    assert.equal(admitted.role, "coder");
    assert.equal(admitted.phase, "plan");
    assert.equal(admitted.ticketNumber, 1003);
    assert.equal("taskPath" in admitted, false);
    // #1178: ticket relocate must not materialize a worker-submission-gate nest.
    assert.equal(existsSync(join(sessionDirectory, "worker-submission-gate")), false);

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        resumeArgs = [...args];
        assert.equal(args[args.indexOf("--ak-role") + 1], "coder");
        assert.equal(args[args.indexOf("--ak-coder-phase") + 1], "plan");
        assert.equal(args.includes("--ak-coder-task"), false);
        assert.equal(args.includes("--skill"), false);
        assert.equal(args.includes(instruction), false);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        const details = {
                status: "planned",
                report: "Resumed plan remains plan phase.",
              };
        await writeFile(
          join(sessionDirectory, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "r1",
              toolName: CODER_OUTPUT_TOOL_NAME,
              isError: false,
              details,
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          sealedAcceptance: { role: "coder" as const, details, toolCallId: "r1" },
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "coder resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "coder");
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["partially_completed", "planned"],
    );
    assert.equal(existsSync(join(sessionDirectory, "worker-submission-gate")), false);
  });
});

// #346: bare --model provider/model dispatches without inventing --thinking.
test("bare --model provider/model dispatches without --thinking; suffix still passes thinking", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Bare model: legal, passes provider/model, omits --thinking entirely.
    {
      const { io, stdout, stderr } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "--model",
          "kimi-coding/k3-256k",
          "coder",
          "plan",
          "--project",
          project,
          "Propose with bare model override.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          // Non-catalog provider (kimi-coding) skips credential fail-closed; still pin facts.
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-cli-coder-bare-model",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            const receipt = {
              status: "planned",
              report: "Plan under bare model override.",
            };
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "bare1",
                  toolName: CODER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "coder" as const, details: receipt, toolCallId: "bare1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.deepEqual(
      result.exitCode,
        0,
        stderr.join("") || stdout.join("") || "bare model dispatch failed",
      );
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured![captured!.indexOf("--provider") + 1], "kimi-coding");
      assert.equal(captured![captured!.indexOf("--model") + 1], "k3-256k");
      assert.equal(captured!.includes("--thinking"), false);
      // invocation evidence: model identity is the override; thinking stays absent.
      const bookKey = resolveBookKeyFromGit(project);
      const invocation = readCurrentSection(
        join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "unbound", "runs",
          "run-cli-coder-bare-model@coder",
        ),
        "invocation",
      );
      // invocation evidence records the effective provider/model; thinking stays absent for bare model.
      assert.equal(invocation.provider, "kimi-coding");
      assert.equal(invocation.model, "k3-256k");
      assert.equal("thinking" in invocation, false);
      assert.deepEqual(
        result.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(result.terminal.roleOutcome)
        : [],
      ["planned"],
    );
    }

    // Suffix override: --thinking still forwarded unchanged.
    {
      const { io, stderr } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "--model",
          "openai-codex/gpt-5.6-luna:high",
          "coder",
          "plan",
          "--project",
          project,
          "Propose with thinking suffix.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-cli-coder-thinking-suffix",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            return {
              code: 1,
              stderr: "stop after args capture",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(Array.isArray(captured), true, stderr.join("") || "suffix dispatch missing args");
      assert.equal(captured![captured!.indexOf("--provider") + 1], "openai-codex");
      assert.equal(captured![captured!.indexOf("--model") + 1], "gpt-5.6-luna");
      assert.equal(captured!.includes("--thinking"), true);
      assert.equal(captured![captured!.indexOf("--thinking") + 1], "high");
      // invocation evidence records provider/model and the supplied thinking level.
      const bookKey = resolveBookKeyFromGit(project);
      const invocation = readCurrentSection(
        join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "unbound", "runs",
          "run-cli-coder-thinking-suffix@coder",
        ),
        "invocation",
      );
      assert.equal(invocation.provider, "openai-codex");
      assert.equal(invocation.model, "gpt-5.6-luna");
      assert.equal(invocation.thinking, "high");
      // Failure after dispatch is fine — we only assert model/thinking pass-through.
      assert.notEqual(result.exitCode, 2);
    }
  });
});

test("syntactically valid unknown provider/model is not rejected at thinking parse", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stderr } = captureIo();
    let dispatched = false;
    let captured: string[] | undefined;
    const result = await runAkRole(
      [
        "--model",
        "no-such-provider/no-such-model",
        "coder",
        "plan",
        "--project",
        project,
        "Unknown model must reach resolution, not thinking parse.",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-cli-coder-unknown-model",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          dispatched = true;
          captured = [...args];
          // Simulate existing typed model-resolution refusal from the host runtime.
          return {
            code: 1,
            stderr: "Unknown model: no-such-provider/no-such-model",
            timedOut: false,
            args: [...args],
          };
        },
          }),
      },
    );
    assert.equal(dispatched, true, stderr.join("") || "unknown model must reach pi dispatch");
    assert.equal(captured![captured!.indexOf("--provider") + 1], "no-such-provider");
    assert.equal(captured![captured!.indexOf("--model") + 1], "no-such-model");
    assert.equal(captured!.includes("--thinking"), false);
    assert.notEqual(result.exitCode, 0);
  });
});

// #346/#683: structural model-spec rejects stay; thinking suffix is opaque pass-through.
test("structurally malformed --model is rejected; opaque thinking suffix still dispatches", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Leading colon leaves empty provider/model — still a format reject.
    {
      const badSpec = ":provider/model";
      const { io } = captureIo();
      let dispatched = false;
      const result = await runAkRole(
        [
          "--model",
          badSpec,
          "coder",
          "plan",
          "--project",
          project,
          "Malformed structure must not dispatch.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-cli-coder-bad-thinking-leading",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              dispatched = true;
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
      assert.equal(dispatched, false, `${badSpec} must not reach pi dispatch`);
      assert.notEqual(result.exitCode, 0, `${badSpec} must be rejected`);
    }

    // Opaque suffix (including former whitelist rejects) reaches dispatch as-is.
    for (const spec of [
      "openai-codex/gpt-5.6-luna:bogus",
      "openai-codex/gpt-5.6-luna:xhigh",
    ] as const) {
      const { io } = captureIo();
      let captured: string[] | undefined;
      await runAkRole(
        [
          "--model",
          spec,
          "coder",
          "plan",
          "--project",
          project,
          "Opaque thinking suffix must dispatch.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () =>
            `run-cli-coder-opaque-thinking-${spec.endsWith(":bogus") ? "bogus" : "xhigh"}`,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              captured = [...args];
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
      assert.ok(captured !== undefined, `${spec} must reach pi dispatch`);
      const thinking = spec.slice(spec.lastIndexOf(":") + 1);
      assert.equal(captured!.includes("--thinking"), true, `${spec} must forward --thinking`);
      assert.equal(captured![captured!.indexOf("--thinking") + 1], thinking);
    }
  });
});
