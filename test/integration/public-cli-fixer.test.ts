import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #110/#177 public Fixer path — common Invocation, structural prerequisites,
 * package diagnosing-bugs + tdd methods (available, not forced), shared Terminal.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { tryHomeFromAkRolesPath } from "../../src/activation-ledger-topology.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import {
  loadPackagedMethodSkillMaterial,
  observePackagedMethodSkillInvocation,
  resolvePackagedMethodSkillPath,
} from "../../src/package-resources/method-skill.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";

import { CliUsageError } from "../../src/public-cli/cli-errors.ts";

import {
  admitFixerInvocation as admitFixerInvocationRaw,
} from "../../src/public-cli/invocation.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import {
  extractFixerMethodInvocations,
  settleFixerTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  exitCodeForTerminalOutcome,
  isLawfulTypedTerminalOutcome,
} from "../../src/public-cli/terminal.ts";
import {
  packageRoot,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";
import { completed, refused, shaA } from "../helpers/fixer-fixtures.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { withHermesFixtureOnPath } from "../helpers/hermes-fixture.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-fixer-", (home) =>
    withHermesFixtureOnPath(home, () => scenario(home)),
  );
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixer@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixer Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}


async function admitFixerInvocation(
  options: Parameters<typeof admitFixerInvocationRaw>[0],
): ReturnType<typeof admitFixerInvocationRaw> {
  return admitFixerInvocationRaw(options);
}


test("admitFixerInvocation freezes prerequisites and rejects malformed grammar structurally", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    await assert.rejects(
      () =>
        admitFixerInvocationRaw({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          phase: "apply",
          instruction: "   ",
          attachmentPaths: [],
        }),
      (error: unknown) =>
        error instanceof CliUsageError && error.code === "AK_ROLE_USAGE",
    );

    const badPrereq = join(home, "bad-prereq.json");
    await writeFile(badPrereq, JSON.stringify([{ id: "bad/id", requirement: "x" }]), "utf8");
    await assert.rejects(
      () =>
        admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          phase: "apply",
          instruction: "Repair with bad prereq grammar.",
          attachmentPaths: [],
          prerequisitesPath: badPrereq,
        }),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.code === "AK_ROLE_USAGE" &&
        /prerequisite/i.test(error.message),
    );

    const goodPrereq = join(home, "good-prereq.json");
    await writeFile(
      goodPrereq,
      JSON.stringify([
        { id: "owner.choice", requirement: "Owner selects the public contract." },
      ]),
      "utf8",
    );
    const source = join(home, "notes.txt");
    await writeFile(source, "attachment-v1", "utf8");
    const admitted = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "plan",
      instruction: "Plan the class repair.",
      attachmentPaths: [source],
      prerequisitesPath: goodPrereq,
      createRunId: () => "run-fixer-plan-001",
    });
    assert.equal(admitted.role, "fixer");
    assert.equal(admitted.phase, "plan");
    assert.equal(admitted.instruction, "Plan the class repair.");
    assert.equal(await readFile(admitted.packetPath, "utf8"), "Plan the class repair.");
    assert.equal(admitted.prerequisites.length, 1);
    assert.equal(admitted.prerequisites[0]!.id, "owner.choice");
    assert.equal(typeof admitted.prerequisitesPath, "string");
    assert.equal(
      JSON.parse(await readFile(admitted.prerequisitesPath!, "utf8"))[0].id,
      "owner.choice",
    );
    assert.equal(admitted.attachments.length, 1);
    assert.equal(await readFile(admitted.attachments[0]!.frozenPath, "utf8"), "attachment-v1");

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "runs", "run-fixer-plan-001@fixer"),
    );
    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as { phase: string; role: string; prerequisites: unknown[] };
    assert.equal(persisted.role, "fixer");
    assert.equal(persisted.phase, "plan");
    assert.equal(persisted.prerequisites.length, 1);
  });
});


test("lawful fixer Terminal records diagnosis provenance and optional invocation observation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const admitted = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "apply",
      instruction: "Repair the unsettled class.",
      attachmentPaths: [],
      createRunId: () => "run-fixer-settle-001",
    });
    await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "diagnosing-bugs",
    );
    const configuredPath = resolvePackagedMethodSkillPath(
      packageRoot,
      "diagnosing-bugs",
    );
    const skillBody = `References are relative to ${material.rootDirectory}.\n\n${material.body}`;
    const skillPrompt = `<skill name="diagnosing-bugs" location="${configuredPath}">\n${skillBody}\n</skill>\n\nDiagnose the root cause.`;
    assert.deepEqual(
      observePackagedMethodSkillInvocation(skillPrompt, {
        name: "diagnosing-bugs",
        allowedLocations: [configuredPath, material.skillPath],
      }),
      { name: "diagnosing-bugs", location: configuredPath },
    );
    // Ambient home path must not count as package invocation.
    assert.equal(
      observePackagedMethodSkillInvocation(
        `<skill name="diagnosing-bugs" location="/tmp/home/.agents/skills/diagnosing-bugs/SKILL.md">\n${skillBody}\n</skill>\n\nx`,
        { name: "diagnosing-bugs", allowedLocations: [configuredPath] },
      ),
      undefined,
    );

    const receipt = {
      status: "completed" as const,
      report: "Root cause repaired across the class; diagnosis was used once.",
      classResults: [
        {
          name: "ParserCase",
          disposition: "completed" as const,
          searchScope: "all parser entry points",
          exceptions: [],
          commitSha: "a".repeat(40),
        },
      ],
    };
    const sessionLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: skillPrompt }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "f1",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          isError: false,
          details: receipt,
        },
      }),
    ];
    await writeFile(piDurablePrincipalAuthority.decode(admitted.principal).sessionFile, `${sessionLines.join("\n")}\n`, "utf8");
    await sealAcceptedSubmission({
      runId: admitted.runId,
      cwd: project,
      home,
      runDirectory: admitted.runDirectory,
      role: "fixer",
      details: receipt,
      toolCallId: "f1",
    });

    const entries = sessionLines.map((line) => JSON.parse(line));
    const invocations = extractFixerMethodInvocations(entries, {
      allowedLocations: [configuredPath, material.skillPath],
    });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]!.name, "diagnosing-bugs");

    const terminal = await settleFixerTerminalResult(admitted, piDurablePrincipalAuthority, {
      methodProvenance: material.provenance,
      methodSkillPath: material.skillPath,
      methodSkillConfiguredPath: configuredPath,
    });
    assert.equal(terminal.roleOutcome.role, "fixer");
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.status, "completed");
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
    const report = terminal.artifacts.find((a) => a.kind === "report");
    assert.ok(report);
    assert.ok((await readFile(report.path, "utf8")).includes(receipt.report));

    const evidence = JSON.parse(
      await readFile(
        terminal.artifacts.find((a) => a.kind === "evidence")!.path,
        "utf8",
      ),
    ) as {
      methodProvenance: {
        name: string;
        packageAdaptation: string;
        upstream: { commit: string; attribution: string };
      };
      methodInvocationObserved: boolean;
      methodInvocations: Array<{ name: string; location: string }>;
    };
    assert.equal(evidence.methodProvenance.name, "diagnosing-bugs");
    assert.equal(
      evidence.methodProvenance.packageAdaptation,
      "fixer-boundary-no-external-skill-chain",
    );
    assert.equal(evidence.methodProvenance.upstream.attribution, "mattpocock/skills");
    assert.equal(evidence.methodInvocationObserved, true);
    assert.equal(evidence.methodInvocations.length, 1);
    assert.equal(JSON.stringify(evidence).includes(".agents/skills"), false);

    // Without skill expansion, provenance remains and invocation is not forced/observed.
    const noDiag = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "apply",
      instruction: "Repair without diagnosis.",
      attachmentPaths: [],
      createRunId: () => "run-fixer-settle-002",
    });
    await mkdir(piDurablePrincipalAuthority.decode(noDiag.principal).sessionDirectory, { recursive: true });
    await writeFile(
      piDurablePrincipalAuthority.decode(noDiag.principal).sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "f2",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          isError: false,
          details: receipt,
        },
      })}\n`,
      "utf8",
    );
    await sealAcceptedSubmission({
      runId: noDiag.runId,
      cwd: project,
      home,
      runDirectory: noDiag.runDirectory,
      role: "fixer",
      details: receipt,
      toolCallId: "f2",
    });
    const terminalNoDiag = await settleFixerTerminalResult(noDiag, piDurablePrincipalAuthority, {
      methodProvenance: material.provenance,
      methodSkillPath: material.skillPath,
      methodSkillConfiguredPath: configuredPath,
    });
    const evidenceNoDiag = JSON.parse(
      await readFile(
        terminalNoDiag.artifacts.find((a) => a.kind === "evidence")!.path,
        "utf8",
      ),
    ) as { methodInvocationObserved: boolean; methodInvocations: unknown[] };
    assert.equal(evidenceNoDiag.methodInvocationObserved, false);
    assert.equal(evidenceNoDiag.methodInvocations.length, 0);
  });
});

test("ak-role fixer defaults apply, preserves plan, rejects blank/malformed prerequisites", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["fixer", "plan", "   "], {
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

    {
      const bad = join(home, "bad.json");
      await writeFile(bad, "{", "utf8");
      const { io } = captureIo();
      const result = await runAkRole(
        ["fixer", "--project", project, "--prerequisites", bad, "Repair."],
        {
          packageRoot,
          home,
          cwd: project,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
            throw new Error("must not dispatch malformed prereq");
          },
          }),
        },
      );
      assert.equal(result.exitCode, 2);
    }

    {
      const { io, stdout } = captureIo();
      let captured: string[] | undefined;
      const result = await runAkRole(
        [
          "fixer",
          "plan",
          "--project",
          project,
          "Propose the first repair plan.",
        ],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-fixer-plan",
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
              report: "Plan: inspect root cause; diagnosis available if needed.",
            };
            await writeFile(
              sessionFile,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "p1",
                  toolName: FIXER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: receipt,
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              sealedAcceptance: { role: "fixer" as const, details: receipt, toolCallId: "p1" },
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "fixer plan failed");
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured![captured!.indexOf("--ak-fixer-phase") + 1], "plan");
      // Real Pi loader/invocation coverage is table-driven above; this CLI
      // row only keeps the public plan phase and settlement regression.

      assert.equal(result.terminal?.roleOutcome.role, "fixer");
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.status
          : undefined,
        "planned",
      );
      await access(
        join(
          home,
          ".ak-roles",
          "books",
          resolveBookKeyFromGit(project),
          "runs",
          "run-cli-fixer-plan@fixer",
          "admitted-request.json",
        ),
      );
    }

    {
      const { io } = captureIo();
      let captured: string[] | undefined;
      await runAkRole(
        ["fixer", "--project", project, "Settle the approved repair."],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-cli-fixer-apply",
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
      assert.equal(Array.isArray(captured), true);
      assert.equal(captured![captured!.indexOf("--ak-fixer-phase") + 1], "apply");
      // Real Pi loader/invocation coverage is table-driven above.
    }
  });
});

test("ak-role resume continues fixer with preserved plan phase and exact session", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-cli-fixer-resume-plan";
    const instruction = "Propose the first repair plan for resume.";

    {
      const { io } = captureIo();
      const first = await runAkRole(
        ["fixer", "plan", "--project", project, instruction],
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
      assert.ok(first.terminal?.resume, "fixer plan 429 must be resumable");
      assert.equal(first.terminal?.roleOutcome.role, "fixer");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@fixer`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { phase: string; role: string; packetPath: string; ticketNumber?: number };
    assert.equal(admitted.role, "fixer");
    assert.equal(admitted.phase, "plan");
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
        assert.equal(args[args.indexOf("--ak-role") + 1], "fixer");
        assert.equal(args[args.indexOf("--ak-fixer-phase") + 1], "plan");
        assert.equal(args[args.indexOf("--ak-fix-packet") + 1], admitted.packetPath);
        assert.equal(args.includes("--skill"), true);
        assert.equal(args.includes(instruction), false);
        assert.equal(args.includes(RESUME_TRANSPORT_ENVELOPE), true);
        assert.equal(args[args.indexOf("--session-dir") + 1], sessionDirectory);
        await writeFile(
          join(sessionDirectory, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "r1",
              toolName: FIXER_OUTPUT_TOOL_NAME,
              isError: false,
              details: {
                status: "planned",
                report: "Resumed plan remains plan phase.",
              },
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          sealedAcceptance: { role: "fixer" as const, details: {
                status: "planned",
                report: "Resumed plan remains plan phase.",
              }, toolCallId: "r1" },
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
          }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "fixer resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumed.terminal?.roleOutcome.role, "fixer");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "planned",
    );
  });
});

function fixerSessionLine(details: unknown): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "f-out",
      toolName: FIXER_OUTPUT_TOOL_NAME,
      isError: false,
      details,
    },
  })}\n`;
}

async function settleFixerSession(
  admitted: Awaited<ReturnType<typeof admitFixerInvocation>>,
  details: unknown,
) {
  await mkdir(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, { recursive: true });
  await writeFile(piDurablePrincipalAuthority.decode(admitted.principal).sessionFile, fixerSessionLine(details), "utf8");
  const home = tryHomeFromAkRolesPath(admitted.runDirectory);
  await sealAcceptedSubmission({
    runId: admitted.runId,
    cwd: admitted.projectRoot,
    ...(home === undefined ? {} : { home }),
    runDirectory: admitted.runDirectory,
    role: "fixer",
    details,
    toolCallId: "f-out",
  });
  const material = await loadPackagedMethodSkillMaterial(
    packageRoot,
    "diagnosing-bugs",
  );
  return settleFixerTerminalResult(admitted, piDurablePrincipalAuthority, {
    methodProvenance: material.provenance,
    methodSkillPath: material.skillPath,
    methodSkillConfiguredPath: resolvePackagedMethodSkillPath(
      packageRoot,
      "diagnosing-bugs",
    ),
  });
}

test("public CLI retains declared prerequisite_unmet judgment as accepted Terminal (not usage/failure)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const prereqPath = join(home, "prereq.json");
    await writeFile(
      prereqPath,
      JSON.stringify([
        {
          id: "owner.choice",
          requirement: "Owner selects the public contract surface.",
        },
      ]),
      "utf8",
    );

    // Production seam: admit valid prerequisites, then settle a phase-legal plan refusal
    // that judges the declared prerequisite unmet — must stay accepted Terminal exit 0.
    const admitted = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "plan",
      instruction: "Plan only after owner choice is present.",
      attachmentPaths: [],
      prerequisitesPath: prereqPath,
      createRunId: () => "run-fixer-prereq-unmet",
    });
    assert.equal(admitted.prerequisites[0]!.id, "owner.choice");

    const receipt = {
      status: "refused" as const,
      report: "Cannot plan: declared owner choice is absent.",
      remainingScope: "the entire plan assignment",
      blocker: {
        cause: "prerequisite_unmet" as const,
        prerequisiteId: "owner.choice",
        evidence: "No owner decision is recorded in the packet attachments.",
      },
    };

    const terminal = await settleFixerSession(admitted, receipt);
    assert.equal(terminal.roleOutcome.kind, "accepted");
    assert.equal(terminal.roleOutcome.role, "fixer");
    assert.equal(
      terminal.roleOutcome.kind === "accepted"
        ? terminal.roleOutcome.status
        : undefined,
      "refused",
    );
    assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), true);
    assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 0);
    assert.equal(terminal.roleOutcome.decisiveFacts.fixerStatus, "refused");
    assert.equal(
      terminal.roleOutcome.decisiveFacts.blockerCause,
      "prerequisite_unmet",
    );
    assert.equal(
      terminal.roleOutcome.decisiveFacts.prerequisiteId,
      "owner.choice",
    );
    assert.equal(
      terminal.roleOutcome.decisiveFacts.remainingScope,
      "the entire plan assignment",
    );
    // Not a controlled-failure face.
    assert.equal(
      Object.hasOwn(terminal.roleOutcome, "cause"),
      false,
    );

    // Full public CLI path: same judgment exits 0 with retained blocker facts.
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "fixer",
        "plan",
        "--project",
        project,
        "--prerequisites",
        prereqPath,
        "Plan only after owner choice is present.",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-cli-fixer-prereq-unmet",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(sessionFile, fixerSessionLine(receipt), "utf8");
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "fixer" as const, details: receipt, toolCallId: "f-out" },
          };
        },
          }),
      },
    );
    assert.equal(result.exitCode, 0, stdout.join("") || "prereq_unmet refused failed");
    assert.equal(stderr.join("").length, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(
      result.terminal!.roleOutcome.kind === "accepted"
        ? result.terminal!.roleOutcome.status
        : undefined,
      "refused",
    );
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.blockerCause,
      "prerequisite_unmet",
    );
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.prerequisiteId,
      "owner.choice",
    );
    assert.equal(Object.hasOwn(result.terminal!.roleOutcome, "cause"), false);
  });
});

test("public Fixer unfinished/refused/partially_completed hand off via shared Terminal exit 0", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const unfinishedReceipt = {
      status: "unfinished" as const,
      report: "Stopped mid-class; remaining work is typed.",
      remainingScope: "TransportCase remaining assertions",
      reason: "prerequisite_missing: owner decision on TransportCase still pending",
      classResults: [completed("ParserCase", shaA)],
    };
    const applyRefusedReceipt = {
      status: "refused" as const,
      report: "All classes blocked by authority boundary.",
      classResults: [
        {
          name: "PolicyCase",
          disposition: "refused" as const,
          remainingScope: "policy surface",
          blocker: {
            cause: "authority_violation" as const,
            evidence: "Packet forbids editing policy files.",
          },
        },
      ],
    };
    const partialReceipt = {
      status: "partially_completed" as const,
      report: "One class repaired; one refused.",
      classResults: [completed("ParserCase", shaA), refused("TransportCase")],
    };
    // settle + runAkRole production path for each lawful status → exit 0.
    const cases: Array<{
      runId: string;
      phase: "plan" | "apply";
      details: unknown;
      kind: "accepted";
      status: string;
      factKey: string;
      factValue: unknown;
    }> = [
      {
        runId: "run-fixer-status-unfinished",
        phase: "apply",
        details: unfinishedReceipt,
        kind: "accepted",
        status: "unfinished",
        factKey: "fixerStatus",
        factValue: "unfinished",
      },
      {
        runId: "run-fixer-status-refused",
        phase: "apply",
        details: applyRefusedReceipt,
        kind: "accepted",
        status: "refused",
        factKey: "blockerCauses",
        factValue: ["authority_violation"],
      },
      {
        runId: "run-fixer-status-partial",
        phase: "apply",
        details: partialReceipt,
        kind: "accepted",
        status: "partially_completed",
        factKey: "fixerStatus",
        factValue: "partially_completed",
      },
    ];

    for (const row of cases) {
      const admitted = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
        home,
        cwd: project,
        phase: row.phase,
        instruction: `Exercise ${row.status} settlement.`,
        attachmentPaths: [],
        createRunId: () => `${row.runId}-settle`,
      });
      const settled = await settleFixerSession(admitted, row.details);
      assert.equal(settled.roleOutcome.kind, row.kind, row.status);
      assert.equal(settled.roleOutcome.role, "fixer", row.status);
      if (settled.roleOutcome.kind !== "accepted") throw new Error("expected accepted Fixer outcome");
      assert.equal(settled.roleOutcome.status, row.status);
      assert.deepEqual(
        settled.roleOutcome.decisiveFacts[row.factKey],
        row.factValue,
        row.status,
      );
      assert.equal(isLawfulTypedTerminalOutcome(settled.roleOutcome), true);
      assert.equal(exitCodeForTerminalOutcome(settled.roleOutcome), 0);

      const { io, stdout } = captureIo();
      const cliArgs =
        row.phase === "plan"
          ? (["fixer", "plan", "--project", project, `CLI ${row.status}`] as string[])
          : (["fixer", "--project", project, `CLI ${row.status}`] as string[]);
      const result = await runAkRole(cliArgs, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => row.runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(sessionFile, fixerSessionLine(row.details), "utf8");
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "fixer" as const, details: row.details, toolCallId: "f-out" },
          };
        },
          }),
      });
      assert.equal(
        result.exitCode,
        0,
        `${row.status}: ${stdout.join("") || "nonzero exit"}`,
      );
      assert.ok(result.terminal, row.status);
      assert.equal(result.terminal!.roleOutcome.kind, row.kind, row.status);
      if (result.terminal!.roleOutcome.kind !== "accepted") throw new Error("expected accepted Fixer outcome");
      assert.equal(result.terminal!.roleOutcome.status, row.status);
      assert.deepEqual(
        result.terminal!.roleOutcome.decisiveFacts[row.factKey],
        row.factValue,
        row.status,
      );
      assert.equal(
        isLawfulTypedTerminalOutcome(result.terminal!.roleOutcome),
        true,
        row.status,
      );
    }
  });
});
