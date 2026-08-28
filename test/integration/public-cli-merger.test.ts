import { piDurablePrincipalAuthority, decodePiDurablePrincipal } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { engineSessionMaterialFromOptions } from "../../src/package-resources/engine-material.ts";
import { buildMergerTurnRequest } from "../../src/public-cli/merger-run.ts";
/**
 * #114 public Merger path — derive envelope from active merge, force package
 * merge-only method, settle completed|escalate on shared success interface.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { validateMergerInput } from "../../src/merger-contracts.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
} from "../../src/package-resources/method-skill.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  admitMergerInvocation as admitMergerInvocationRaw,
  buildMergerTransportPrompt,
  deriveMergerEnvelopeFromActiveMerge,
  parseMergerArgv,
} from "../../src/public-cli/invocation.ts";

import { RESUME_TRANSPORT_ENVELOPE, selectResumeContinuationPrompt } from "../../src/public-cli/run-lifecycle.ts";
import {
  extractMergerMethodInvocations,
  extractMergerRoleOutcome,
  settleMergerTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

function mergerActivationArgs(
  admitted: Parameters<typeof buildMergerTurnRequest>[0],
  kind: "initial" | "resume",
): string[] {
  return buildPiTurnExtraArgs(
    buildMergerTurnRequest(admitted, {
      packageRoot,
      home: admitted.projectRoot ?? "/tmp",
      agentDir: "/tmp/agent",
      continuation:
        kind === "initial"
          ? {
              kind: "initial",
              prompt: buildMergerTransportPrompt(
                admitted,
                engineSessionMaterialFromOptions({ packageRoot }),
              ),
            }
          : {
              kind: "resume",
              prompt: selectResumeContinuationPrompt(),
            },
    }),
    piDurablePrincipalAuthority,
  );
}

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-merger-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function git(cwd: string, args: string[], opts: { input?: string } = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.input === undefined ? {} : { input: opts.input }),
  }).trim();
}

function seedGitProject(root: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "merger@test.local"]);
  git(root, ["config", "user.name", "Merger Test"]);
  git(root, ["commit", "--allow-empty", "-m", "seed"]);
}

async function materializeConflictedRepo(root: string): Promise<{
  target: string;
  source: string;
  conflictPath: string;
}> {
  seedGitProject(root);
  await writeFile(join(root, "same.txt"), "base\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "source"]);
  await writeFile(join(root, "same.txt"), "source\n", "utf8");
  git(root, ["commit", "-am", "source"]);
  const source = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "main"]);
  await writeFile(join(root, "same.txt"), "target\n", "utf8");
  git(root, ["commit", "-am", "target"]);
  const target = git(root, ["rev-parse", "HEAD"]);
  try {
    git(root, ["merge", "--no-edit", "source"]);
    throw new Error("expected conflicting merge");
  } catch {
    // conflicted
  }
  return { target, source, conflictPath: "same.txt" };
}


async function admitMergerInvocation(
  options: Parameters<typeof admitMergerInvocationRaw>[0],
): ReturnType<typeof admitMergerInvocationRaw> {
  return admitMergerInvocationRaw(options);
}


test("parseMergerArgv accepts common Invocation flags and rejects unknown options", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parseMergerArgv(["Resolve the active merge."]), {
    instruction: "Resolve the active merge.",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parseMergerArgv([
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
  assert.throws(() => parseMergerArgv(["--unknown-flag"]), isUsage);
  assert.throws(() => parseMergerArgv(["--project", "", "task"]), isUsage);
  // No public packet fields for parents/conflicts/scope.
  assert.throws(() => parseMergerArgv(["--targetObjectId", "abc"]), isUsage);
  assert.throws(() => parseMergerArgv(["--ak-merger-input", "x.json"]), isUsage);
});

test("deriveMergerEnvelopeFromActiveMerge reads parents, AUTO_MERGE, conflicts, and scope", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "conflicted");
    await mkdir(project, { recursive: true });
    const fixture = await materializeConflictedRepo(project);
    const derived = await deriveMergerEnvelopeFromActiveMerge(project);
    assert.equal(derived.targetObjectId, fixture.target);
    assert.equal(derived.sourceObjectId, fixture.source);
    assert.deepEqual(derived.expectedConflictPaths, [fixture.conflictPath]);
    assert.deepEqual(derived.resolutionScope, [fixture.conflictPath]);
    assert.equal(/^[0-9a-f]{40}$/.test(derived.automaticMergeTreeId), true);
    assert.equal(
      derived.automaticMergeTreeId.length,
      derived.targetObjectId.length,
    );

    // No active merge fails honestly from the production git seam (not CLI parsing).
    const clean = join(home, "clean");
    await mkdir(clean, { recursive: true });
    seedGitProject(clean);
    await assert.rejects(
      () => deriveMergerEnvelopeFromActiveMerge(clean),
      /in-progress merge/i,
    );
  });
});

test("admitMergerInvocation derives envelope into internal input without public packet fields", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    const fixture = await materializeConflictedRepo(project);

    await assert.rejects(
      () =>
        admitMergerInvocationRaw({
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
    assert.equal(
      admitted.derived.automaticMergeTreeId,
      (await deriveMergerEnvelopeFromActiveMerge(project)).automaticMergeTreeId,
    );

    const raw = JSON.parse(await readFile(admitted.mergerInputPath, "utf8"));
    const input = validateMergerInput(raw);
    assert.equal(input.targetObjectId, fixture.target);
    assert.equal(input.sourceObjectId, fixture.source);
    assert.deepEqual([...input.expectedConflictPaths], [fixture.conflictPath]);
    assert.deepEqual([...input.resolutionScope], [fixture.conflictPath]);
    assert.equal(input.attemptId, "run-merger-admit-001");
    // Durable admitted identity retains adapter-derived envelope facts (not caller packet fields).
    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as { derived: { targetObjectId: string } };
    assert.equal(persisted.derived.targetObjectId, fixture.target);
    assert.equal(Array.isArray(input.authorizedChecks), true);

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "runs", "run-merger-admit-001@merger"),
    );

    // Forced method expansion is the first transport act.
    const prompt = buildMergerTransportPrompt(admitted);
    assert.equal(prompt.startsWith("/skill:resolving-merge-conflicts "), true);
    assert.equal(prompt.includes(admitted.instruction), true);
  });
});

test("buildMergerTurnRequest pins package merge-only method and internal input", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await materializeConflictedRepo(project);
    const admitted = await admitMergerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Resolve within scope.",
      attachmentPaths: [],
      createRunId: () => "run-merger-args-001",
    });
    const args = mergerActivationArgs(admitted, "initial");
    assert.equal(args.includes("--no-skills"), true);
    assert.equal(args.includes("--skill"), true);
    assert.equal(args.includes("--ak-role"), true);
    assert.equal(args[args.indexOf("--ak-role") + 1], "merger");
    assert.equal(args.includes("--ak-merger-input"), true);
    assert.equal(
      args[args.indexOf("--ak-merger-input") + 1],
      admitted.mergerInputPath,
    );
    assert.equal(
      args.some((a) => a.includes(".agents/skills")),
      false,
    );
    assert.equal(
      args.some((a) => a.startsWith("/skill:resolving-merge-conflicts")),
      true,
    );

    const resume = mergerActivationArgs(admitted, "resume");
    assert.equal(resume.includes("--skill"), true);
    assert.equal(resume.includes(RESUME_TRANSPORT_ENVELOPE), true);
    assert.equal(resume.includes(admitted.instruction), false);
  });
});

test("lawful merger Terminal settlement publishes report/evidence with method + derived envelope", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    const fixture = await materializeConflictedRepo(project);
    const admitted = await admitMergerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      instruction: "Complete the merge.",
      attachmentPaths: [],
      createRunId: () => "run-merger-settle-001",
    });
    await mkdir(decodePiDurablePrincipal(piDurablePrincipalAuthority, admitted.principal).sessionDirectory, { recursive: true });
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "resolving-merge-conflicts",
    );
    const configuredPath = resolvePackagedMethodSkillPath(
      packageRoot,
      "resolving-merge-conflicts",
    );
    const skillBody = material.body;
    const expectedContent = `References are relative to ${material.rootDirectory}.\n\n${skillBody}`;
    const expansionText = `<skill name="resolving-merge-conflicts" location="${material.skillPath}">\n${expectedContent}\n</skill>\n\nComplete the merge.`;
    const receipt = {
      status: "completed" as const,
      attemptId: "run-merger-settle-001",
      report: "Compatible intents reconciled into ordinary two-parent merge.",
      mergeCommitId: "a".repeat(40),
    };
    const escalateReceipt = {
      status: "escalate" as const,
      attemptId: "run-merger-settle-001",
      diagnosis: "New authority decision required on API surface.",
      report: "Incompatible intents cannot be merged without new intent.",
    };
    const sessionLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: expansionText }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "m1",
              name: MERGER_OUTPUT_TOOL_NAME,
              arguments: receipt,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "m1",
          toolName: MERGER_OUTPUT_TOOL_NAME,
          isError: false,
          details: receipt,
        },
      }),
    ];
    await writeFile(decodePiDurablePrincipal(piDurablePrincipalAuthority, admitted.principal).sessionFile, `${sessionLines.join("\n")}\n`, "utf8");

    const entries = sessionLines.map((line) => JSON.parse(line));
    const extracted = extractMergerRoleOutcome(entries);
    assert.equal(extracted?.outcome.role, "merger");
    assert.equal(extracted?.outcome.kind, "accepted");
    assert.equal(extracted?.outcome.status, "completed");
    assert.equal(
      extracted?.outcome.decisiveFacts.mergeCommitId,
      "a".repeat(40),
    );

    const methodInvocations = extractMergerMethodInvocations(entries, {
      allowedLocations: [material.skillPath, configuredPath],
    });
    assert.equal(methodInvocations.length, 1);
    assert.equal(methodInvocations[0]!.name, "resolving-merge-conflicts");

    const terminal = await settleMergerTerminalResult(admitted, piDurablePrincipalAuthority, {
      methodProvenance: material.provenance,
      methodSkillPath: material.skillPath,
      methodSkillConfiguredPath: configuredPath,
    });
    assert.equal(terminal.roleOutcome.role, "merger");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(
      terminal.roleOutcome.kind === "accepted"
        ? terminal.roleOutcome.status
        : undefined,
      "completed",
    );
    assert.equal(terminal.artifacts.some((a) => a.kind === "report"), true);
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
    // #177 S2: merger report is legally withheld from decisiveFacts; receipt holds it.
    assert.equal(
      Object.hasOwn(terminal.roleOutcome.decisiveFacts, "report"),
      false,
    );
    const mergerReportBody = await readFile(
      terminal.artifacts.find((a) => a.kind === "report")!.path,
      "utf8",
    );
    assert.ok(
      mergerReportBody.includes(receipt.report),
      "merger report text must live in artifact receipt",
    );

    const evidence = JSON.parse(
      await readFile(
        terminal.artifacts.find((a) => a.kind === "evidence")!.path,
        "utf8",
      ),
    ) as {
      methodProvenance: { packageAdaptation: string; upstream: { path: string } };
      methodInvocationObserved: boolean;
      derived: {
        targetObjectId: string;
        sourceObjectId: string;
        automaticMergeTreeId: string;
        expectedConflictPaths: string[];
        resolutionScope: string[];
      };
    };
    assert.equal(
      evidence.methodProvenance.packageAdaptation,
      "merger-merge-only-escalate-new-intent",
    );
    assert.equal(
      evidence.methodProvenance.upstream.path,
      "skills/engineering/resolving-merge-conflicts",
    );
    assert.equal(evidence.methodInvocationObserved, true);
    assert.equal(evidence.derived.targetObjectId, fixture.target);
    assert.equal(evidence.derived.sourceObjectId, fixture.source);
    assert.deepEqual(evidence.derived.expectedConflictPaths, [
      fixture.conflictPath,
    ]);
    assert.deepEqual(evidence.derived.resolutionScope, [fixture.conflictPath]);
    assert.equal(
      evidence.derived.automaticMergeTreeId,
      admitted.derived.automaticMergeTreeId,
    );
    assert.equal(JSON.stringify(evidence).includes(".agents/skills"), false);

    // escalate leaf is also a lawful accepted Terminal status.
    const escalateLines = [
      sessionLines[0]!,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "m2",
              name: MERGER_OUTPUT_TOOL_NAME,
              arguments: escalateReceipt,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "m2",
          toolName: MERGER_OUTPUT_TOOL_NAME,
          isError: false,
          details: escalateReceipt,
        },
      }),
    ];
    await writeFile(
      decodePiDurablePrincipal(piDurablePrincipalAuthority, admitted.principal).sessionFile,
      `${escalateLines.join("\n")}\n`,
      "utf8",
    );
    const escalateTerminal = await settleMergerTerminalResult(admitted, piDurablePrincipalAuthority, {
      methodProvenance: material.provenance,
      methodSkillPath: material.skillPath,
      methodSkillConfiguredPath: configuredPath,
    });
    assert.equal(escalateTerminal.roleOutcome.kind, "accepted");
    assert.equal(
      escalateTerminal.roleOutcome.kind === "accepted"
        ? escalateTerminal.roleOutcome.status
        : undefined,
      "escalate",
    );
    assert.equal(
      escalateTerminal.roleOutcome.decisiveFacts.diagnosis,
      "New authority decision required on API surface.",
    );
  });
});

test("ak-role merger derives envelope, pins method, and fails activation honestly without merge", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });

    // Blank instruction → structural reject, no run.
    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["merger", "   "], {
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

    // No active merge → activation-class controlled failure (not CLI semantic guess).
    {
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["merger", "Resolve whatever is open."],
        {
          packageRoot,
          home,
          cwd: project,
          io,
          createRunId: () => "run-merger-no-merge",
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
            throw new Error("must not dispatch without active merge");
          },
          }),
        },
      );
      assert.equal(result.exitCode, 1);
      const out = stdout.join("");
      assert.match(out, /merger\tfailure\t/);
      assert.match(out, /activation/);
      assert.equal(stderr.join("").length > 0, true);
    }

    // Active merge → dispatch with package method + derived internal input.
    {
      const conflicted = join(home, "conflicted-run");
      await mkdir(conflicted, { recursive: true });
      const fixture = await materializeConflictedRepo(conflicted);
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const material = await loadPackagedMethodSkillMaterial(
        packageRoot,
        "resolving-merge-conflicts",
      );
      const result = await runAkRole(
        ["merger", "--project", conflicted, "Reconcile both intents."],
        {
          packageRoot,
          home,
          cwd: home,
          io,
          createRunId: () => "run-merger-dispatch-001",
          mergerTimeoutMs: 5_000,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            captured = [...args];
            // Simulate forced expansion + completed leaf without real model.
            const sessionIdx = args.indexOf("--session");
            const sessionFile = args[sessionIdx + 1]!;
            const inputIdx = args.indexOf("--ak-merger-input");
            const inputPath = args[inputIdx + 1]!;
            const input = validateMergerInput(
              JSON.parse(await readFile(inputPath, "utf8")),
            );
            assert.equal(input.targetObjectId, fixture.target);
            assert.equal(input.sourceObjectId, fixture.source);
            const expansion = `<skill name="resolving-merge-conflicts" location="${material.skillPath}">\nReferences are relative to ${material.rootDirectory}.\n\n${material.body}\n</skill>\n\nReconcile both intents.`;
            const receipt = {
              status: "completed",
              attemptId: input.attemptId,
              report: "resolved",
              mergeCommitId: "b".repeat(40),
            };
            await mkdir(join(sessionFile, ".."), { recursive: true });
            await writeFile(
              sessionFile,
              [
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: expansion }],
                  },
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "toolCall",
                        id: "out",
                        name: MERGER_OUTPUT_TOOL_NAME,
                        arguments: receipt,
                      },
                    ],
                  },
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "toolResult",
                    toolCallId: "out",
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
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join(""));
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured!.includes("--ak-role"), true);
      assert.equal(captured![captured!.indexOf("--ak-role") + 1], "merger");
      assert.equal(captured!.includes("--skill"), true);
      assert.equal(
        captured![captured!.indexOf("--skill") + 1]?.includes(
          "resolving-merge-conflicts",
        ),
        true,
      );
      assert.equal(
        captured!.some((a) => a.startsWith("/skill:resolving-merge-conflicts")),
        true,
      );
      assert.match(stdout.join(""), /merger\taccepted\t/);
      assert.match(stdout.join(""), /completed/);
    }
  });
});

test("ak-role resume continues merger with package method and exact session", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await materializeConflictedRepo(project);
    const runId = "run-cli-merger-resume-001";
    const instruction = "Start merge resolution for resume.";
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "resolving-merge-conflicts",
    );

    {
      const { io } = captureIo();
      const first = await runAkRole(
        ["merger", "--project", project, instruction],
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
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDir, ".."),
              provider: "xai",
            });
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
      assert.ok(first.terminal?.resume, "merger 429 must be resumable");
      assert.equal(first.terminal?.roleOutcome.role, "merger");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@merger`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { role: string; mergerInputPath: string; ticketNumber?: number };
    assert.equal(admitted.role, "merger");
    assert.equal(admitted.ticketNumber, undefined);

    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", runId], {
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
        assert.equal(args[args.indexOf("--ak-role") + 1], "merger");
        assert.equal(
          args[args.indexOf("--ak-merger-input") + 1],
          admitted.mergerInputPath,
        );
        assert.equal(args.includes("--skill"), true);
        assert.equal(args.includes(instruction), false);
        assert.equal(args.includes(RESUME_TRANSPORT_ENVELOPE), true);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        const expansion = `<skill name="resolving-merge-conflicts" location="${material.skillPath}">\nReferences are relative to ${material.rootDirectory}.\n\n${material.body}\n</skill>\n\n${instruction}`;
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
                content: [{ type: "text", text: expansion }],
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
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "escalate",
    );
  });
});

test("public Merger retains malformed output candidate as typed incomplete", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await materializeConflictedRepo(project);
    const candidate = { status: "unknown-shape", attemptId: "run-merger-residual-182", report: 7 };
    const result = await runAkRole(["merger", "--project", project, "merge"], {
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
    assert.equal(result.terminal?.roleOutcome.kind, "incomplete");
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts.candidate, candidate);
    assert.equal(result.terminal?.roleOutcome.decisiveFacts.acceptedReceipt, false);
    assert.match(String(result.terminal?.roleOutcome.decisiveFacts.diagnostic), /unrecognized/);
  });
});
