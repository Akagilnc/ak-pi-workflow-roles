import { readCurrentSection, submittedParams, terminalBodyAt } from "../helpers/run-dossier-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #114 public Merger path — derive envelope from active merge, force package
 * merge-only method, settle completed|escalate on shared success interface.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { validateMergerInput } from "../../src/merger-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { payloadStatusSequence, objectPayloads } from "../helpers/terminal-payload.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitPublicRole,
  type AdmitMergerInvocationOptions,
  buildInstructionTransportPrompt,
  deriveMergerEnvelopeFromActiveMerge,
  parsePublicSeatArgv,
} from "../../src/public-cli/invocation.ts";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { materializeConflictedRepo } from "../helpers/merger-conflict-fixture.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-merger-", scenario);
}

function admitMergerInvocation(options: AdmitMergerInvocationOptions) {
  return admitPublicRole("merger", {
    instruction: options.instruction,
    attachmentPaths: options.attachmentPaths,
    ...(options.project === undefined ? {} : { project: options.project }),
  }, {
    home: options.home,
    principalAuthority: options.principalAuthority,
    cwd: options.cwd,
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.model === undefined ? {} : { model: options.model }),
  }, options.assertedTicketNumber === undefined
    ? undefined
    : { assertedTicketNumber: options.assertedTicketNumber });
}

test("parseMergerArgv accepts common Invocation flags and rejects unknown options", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parsePublicSeatArgv("merger", ["Resolve the active merge."]), {
    instruction: "Resolve the active merge.",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parsePublicSeatArgv("merger", [
      "--attach",
      "a.md",
      "--project",
      "/tmp/p",
      "Finish the merge.",
    ]),
    {
      instruction: "Finish the merge.",
      attachmentPaths: ["a.md"],
      project: "/tmp/p",
    },
  );
  assert.throws(() => parsePublicSeatArgv("merger", ["--unknown-flag"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("merger", ["--project", "", "task"]), isUsage);
  // No public packet fields for parents/conflicts/scope.
  assert.throws(() => parsePublicSeatArgv("merger", ["--targetObjectId", "abc"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("merger", ["--ak-merger-input", "x.json"]), isUsage);
});

test("deriveMergerEnvelopeFromActiveMerge reads parents and conflicts as materials", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "conflicted");
    await mkdir(project, { recursive: true });
    const fixture = await materializeConflictedRepo(project);
    const derived = await deriveMergerEnvelopeFromActiveMerge(project);
    assert.deepEqual(derived.targetObjectId, fixture.target);
    assert.deepEqual(derived.sourceObjectId, fixture.source);
    assert.deepEqual(derived.expectedConflictPaths, [fixture.conflictPath]);
    assert.deepEqual(derived.resolutionScope, [fixture.conflictPath]);

    // No active merge still yields materials (empty source/conflicts) — not an admission gate (#827).
    const clean = join(home, "clean");
    await mkdir(clean, { recursive: true });
    seedGitProject(clean);
    const cleanDerived = await deriveMergerEnvelopeFromActiveMerge(clean);
    assert.deepEqual(
      cleanDerived.sourceObjectId, "");
    assert.deepEqual(cleanDerived.expectedConflictPaths, []);
    assert.equal(cleanDerived.targetObjectId.length > 0, true);
  });
});

test("admitMergerInvocation derives envelope into internal input without public packet fields", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    const fixture = await materializeConflictedRepo(project);

    await assert.rejects(
      () =>
        admitMergerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          instruction: "   ",
          attachmentPaths: [],
        }),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    const admitted = await admitMergerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Reconcile the conflicted merge.",
      attachmentPaths: [],
      createRunId: () => "run-merger-admit-001",
    });
    assert.equal(admitted.role, "merger");
    assert.equal(admitted.instruction, "Reconcile the conflicted merge.");
    assert.equal(admitted.derived.targetObjectId, fixture.target);
    assert.equal(admitted.derived.sourceObjectId, fixture.source);
    assert.deepEqual(admitted.derived.expectedConflictPaths, [
      fixture.conflictPath,
    ]);
    assert.deepEqual(admitted.derived.resolutionScope, [fixture.conflictPath]);

    const raw = JSON.parse(await readFile(admitted.mergerInputPath, "utf8")) as {
      materials?: Record<string, unknown>;
    };
    // #1168: dispatch copies gone; only git-fact intents remain as materials keys.
    assert.deepEqual(Object.keys(raw.materials ?? {}).sort(), ["sourceIntent", "targetIntent"]);
    assert.equal("task" in (raw.materials ?? {}), false);
    assert.equal("authority" in (raw.materials ?? {}), false);
    const input = validateMergerInput(raw);
    assert.equal(input.targetObjectId, fixture.target);
    assert.equal(input.sourceObjectId, fixture.source);
    assert.deepEqual([...input.expectedConflictPaths], [fixture.conflictPath]);
    assert.deepEqual([...input.resolutionScope], [fixture.conflictPath]);
    assert.equal(input.attemptId, "run-merger-admit-001");
    // Durable admitted identity retains adapter-derived envelope facts (not caller packet fields).
    const persisted = readCurrentSection(admitted.runDirectory, "admitted") as {
      instruction: string;
      derived: { targetObjectId: string };
    };
    assert.equal(persisted.instruction, "Reconcile the conflicted merge.");
    assert.equal(persisted.derived.targetObjectId, fixture.target);
    assert.equal(Array.isArray(input.authorizedChecks), true);

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-merger-admit-001@merger"),
    );

    // Transport prompt is host-neutral; Pi `/skill:` is adapter-internal only (#822).
    const prompt = buildInstructionTransportPrompt(admitted);
    assert.equal(prompt.startsWith("/skill:"), false);
    assert.equal(prompt.includes(admitted.instruction), true);
  });
});

test("ak-role merger dispatches and settles escalate without active merge and completed with active merge under mocked host", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });

    // Blank instruction → structural reject, no run.
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["merger", "--model", "test/caller-seat:high", "   "], {
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

    // No active merge → dispatches and settles escalate terminal leaf under mocked host (#827).
    {
      seedGitProject(project);
      const { io, stdout } = captureIo();
      let dispatched = false;
      const result = await runAkRole(["merger", "--model", "test/caller-seat:high", "Resolve whatever is open."],
        {
          packageRoot,
          home,
          cwd: project,
          io,
          createRunId: () => "run-merger-no-merge",
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            dispatched = true;
            const sessionFile = args[args.indexOf("--session") + 1]!;
            const inputPath = args[args.indexOf("--ak-merger-input") + 1]!;
            const input = validateMergerInput(
              JSON.parse(await readFile(inputPath, "utf8")),
            );
            assert.equal(input.sourceObjectId, "");
            assert.deepEqual([...input.expectedConflictPaths], []);
            const receipt = { status: "escalate", attemptId: input.attemptId, diagnosis: "no in-progress merge", report: "nothing to reconcile" };
            await mkdir(join(sessionFile, ".."), { recursive: true });
            await writeFile(sessionFile, [
              JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Resolve the merge." }] } }),
              JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "out", name: MERGER_OUTPUT_TOOL_NAME, arguments: receipt }] } }),
              JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "out", toolName: MERGER_OUTPUT_TOOL_NAME, isError: false, details: receipt } }),
            ].join("\n") + "\n", "utf8");
            return { code: 0, sealedAcceptance: { role: "merger" as const, details: receipt, toolCallId: "out" }, stderr: "", timedOut: false, args: [...args] };
          },
          }),
        },
      );
      assert.equal(dispatched, true);
      assert.equal(result.exitCode, 0, stdout.join(""));
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["escalate"]);
      assert.equal(
        (objectPayloads(result.terminal!.roleOutcome)[0] ?? {}).diagnosis,
        "no in-progress merge",
      );
    }

    // Active merge → derives materials from active merge and settles completed leaf under mocked host.
    {
      const conflicted = join(home, "conflicted-run");
      await mkdir(conflicted, { recursive: true });
      const fixture = await materializeConflictedRepo(conflicted);
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(["merger", "--model", "test/caller-seat:high", "--project", conflicted, "Reconcile both intents."],
        {
          packageRoot,
          home,
          cwd: home,
          io,
          createRunId: () => "run-merger-dispatch-001",
          timeoutMs: 5_000,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            // Simulate completed receipt under mocked host.
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            const inputIdx = args.indexOf("--ak-merger-input");
            const inputPath = args[inputIdx + 1]!;
            const input = validateMergerInput(
              JSON.parse(await readFile(inputPath, "utf8")),
            );
            assert.equal(input.targetObjectId, fixture.target);
            assert.equal(input.sourceObjectId, fixture.source);
            const receipt = { status: "completed", attemptId: input.attemptId, report: "resolved", mergeCommitId: "b".repeat(40) };
            await mkdir(join(sessionFile, ".."), { recursive: true });
            await writeFile(sessionFile, [
              JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Resolve the merge." }] } }),
              JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "out", name: MERGER_OUTPUT_TOOL_NAME, arguments: receipt }] } }),
              JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "out", toolName: MERGER_OUTPUT_TOOL_NAME, isError: false, details: receipt } }),
            ].join("\n") + "\n", "utf8");
            return { code: 0, sealedAcceptance: { role: "merger" as const, details: receipt, toolCallId: "out" }, stderr: "", timedOut: false, args: [...args] };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join(""));
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured!.includes("--ak-role"), true);
      assert.equal(captured![captured!.indexOf("--ak-role") + 1], "merger");
      assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["completed"]);
      assert.equal(result.terminal!.artifacts.some((a) => a.kind === "report"), true);
      assert.equal((objectPayloads(result.terminal!.roleOutcome)[0] ?? {}).report, "resolved");
      const reportRef = result.terminal!.artifacts.find((a) => a.kind === "report")!;
      const reportBody = terminalBodyAt(reportRef.path, "report") as { outcome?: { payloads?: unknown } };
      assert.equal(reportBody.outcome !== undefined && "payloads" in reportBody.outcome, false);
      const submitted = submittedParams(dirname(reportRef.path)) as ReadonlyArray<{ report?: string }>;
      assert.equal(submitted[0]?.report, "resolved");
      // The derived merge facts are the admitted section's own record.
      const evidence = readCurrentSection(dirname(reportRef.path), "admitted") as {
        derived: {
          targetObjectId: string;
          sourceObjectId: string;
          expectedConflictPaths: string[];
          resolutionScope: string[];
        };
      };
      assert.equal(evidence.derived.targetObjectId, fixture.target);
      assert.equal(evidence.derived.sourceObjectId, fixture.source);
      assert.deepEqual(evidence.derived.expectedConflictPaths, [fixture.conflictPath]);
      assert.deepEqual(evidence.derived.resolutionScope, [fixture.conflictPath]);
    }
  });
});

test("ak-role resume continues merger with exact session", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await materializeConflictedRepo(project);
    const runId = "run-cli-merger-resume-001";
    const instruction = "Start merge resolution for resume.";

    {
      const { io } = captureIo();
      const first = await runAkRole(["merger", "--model", "test/caller-seat:high", "--project", project, instruction],
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
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stderr: "quota",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(first.terminal?.roleOutcome.role, "merger");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@merger`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = readCurrentSection(runDirectory, "admitted") as { role: string; mergerInputPath: string; ticketNumber?: number };
    assert.equal(admitted.role, "merger");
    assert.equal(admitted.ticketNumber, undefined);

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    let resumeStdin: string | undefined;
    const resumed = await runAkRole(["resume", "--model", "test/caller-seat:high", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
        resumeArgs = [...args];
        resumeStdin = options.stdin;
        assert.equal(args[args.indexOf("--ak-role") + 1], "merger");
        assert.equal(
          args[args.indexOf("--ak-merger-input") + 1],
          admitted.mergerInputPath,
        );
        assert.equal(args.includes(instruction), false);
        assert.equal(
          args.some((a) => a.includes("[ak-role:resume-continue]")),
          false,
        );
        assert.equal(readUserDialogueStdin(resumeStdin ?? ""), "");
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        const receipt = {
          status: "escalate",
          attemptId: runId,
          diagnosis: "Authority choice required after resume.",
          report: "Resumed merge still needs a decision.",
        };
        await writeFile(
          join(sessionDirectory, "session.jsonl"),
          [
            JSON.stringify({
              type: "message",
              message: {
                role: "user",
                content: [{ type: "text", text: "Resolve the merge." }],
              },
            }),
            JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: "r1",
                toolName: MERGER_OUTPUT_TOOL_NAME,
                isError: false,
                details: receipt,
              },
            }),
          ].join("\n") + "\n",
          "utf8",
        );
        return {
          code: 0,
              sealedAcceptance: { role: "merger" as const, details: receipt, toolCallId: "r1" },
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "merger resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "merger");
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["escalate"],
    );
  });
});

test("public Merger retains malformed output candidate as typed incomplete", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await materializeConflictedRepo(project);
    const candidate = { status: "unknown-shape", attemptId: "run-merger-residual-182", report: 7 };
    const result = await runAkRole(["merger", "--model", "test/caller-seat:high", "--project", project, "merge"], {
      packageRoot, home, cwd: project,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => "run-merger-residual-182",
      io: captureIo().io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        const sessionFile = args[args.indexOf("--session") + 1]!;
        await mkdir(join(sessionFile, ".."), { recursive: true });
        await writeFile(sessionFile, [
          { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: MERGER_OUTPUT_TOOL_NAME, arguments: candidate }] } },
          { type: "message", message: { role: "toolResult", toolCallId: "bad", toolName: MERGER_OUTPUT_TOOL_NAME, isError: true, content: [{ type: "text", text: "Merger status is unrecognized" }] } },
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
        return { code: 1, stderr: "aborted", timedOut: false, args: [...args] };
      },
          }),
    });
    assert.equal(result.exitCode, 1);
    assert.notEqual(result.terminal?.roleOutcome.kind, "accepted");
  });
});
