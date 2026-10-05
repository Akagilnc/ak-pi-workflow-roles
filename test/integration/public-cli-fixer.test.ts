import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "../helpers/role-turn-host-fixture.ts";
/**
 * #110/#177 public Fixer path — common Invocation, structural prerequisites,
 * package diagnosing-bugs + tdd methods (available, not forced), shared Terminal.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { FixerPacketValidationError } from "../../src/package-contracts/fixer-packet.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";

import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { payloadStatusSequence, objectPayloads } from "../helpers/terminal-payload.ts";

import {
  admitPublicRole,
  type AdmitFixerInvocationOptions,
} from "../../src/public-cli/invocation.ts";

import {
  isLawfulTypedTerminalOutcome,
} from "../../src/public-cli/terminal.ts";
import {
  packageRoot,
} from "../helpers/pi-test-harness.ts";
import { readCurrentSection, terminalBodyAt, submittedParams } from "../helpers/run-dossier-fixture.ts";
import { completed, refused, shaA } from "../helpers/fixer-fixtures.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-fixer-", scenario);
}


function admitFixerInvocation(options: AdmitFixerInvocationOptions) {
  return admitPublicRole("fixer", {
    phase: options.phase,
    instruction: options.instruction,
    attachmentPaths: options.attachmentPaths,
    ...(options.prerequisitesPath === undefined ? {} : { prerequisitesPath: options.prerequisitesPath }),
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


test("admitFixerInvocation freezes prerequisites and rejects malformed grammar structurally", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    await assert.rejects(
      () =>
        admitFixerInvocation({
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
      (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE" &&
        error.cause instanceof FixerPacketValidationError,
    );

    const goodPrereq = join(home, "good-prereq.json");
    await writeFile(
      goodPrereq,
      JSON.stringify([
        { id: "owner.choice", requirement: "Owner selects the public contract.", extra: true },
      ]),
      "utf8",
    );
    const admitted = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      phase: "plan",
      instruction: "Plan the class repair.",
      attachmentPaths: [],
      prerequisitesPath: goodPrereq,
      createRunId: () => "run-fixer-plan-001",
    });
    assert.deepEqual(
      admitted.role, "fixer");
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

    const bookKey = resolveBookKeyFromGit(project);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-fixer-plan-001@fixer"),
    );
    const persisted = readCurrentSection(admitted.runDirectory, "admitted") as {
      phase: string; role: string; prerequisites: unknown[];
    };
    assert.equal(persisted.role, "fixer");
    assert.equal(persisted.phase, "plan");
    assert.equal(persisted.prerequisites.length, 1);
  });
});


test("ak-role fixer defaults apply, preserves plan, rejects blank/malformed prerequisites", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["fixer", "--model", "test/caller-seat:high", "plan", "   "], {
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
      const result = await runAkRole(["fixer", "--model", "test/caller-seat:high", "--project", project, "--prerequisites", bad, "Repair."],
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
      const receipt = {
        status: "planned" as const,
        report: "Plan: inspect root cause; diagnosis available if needed.",
      };
      const result = await runAkRole([
          "fixer", "--model", "test/caller-seat:high",
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
      assert.deepEqual(
        result.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(result.terminal.roleOutcome)
        : [],
      ["planned"],
    );
      const report = result.terminal?.artifacts.find((a) => a.kind === "report");
      assert.ok(report);
      const reportBody = terminalBodyAt(report.path, "report") as {
        outcome?: { payloads?: unknown };
      };
      // The submitted words live in history.jsonl; the terminal carries only the verdict.
      assert.equal(reportBody.outcome !== undefined && "payloads" in reportBody.outcome, false);
      assert.deepEqual(submittedParams(dirname(report.path)), [receipt]);
      await access(
        join(
          home,
          ".ak-roles",
          "books",
          resolveBookKeyFromGit(project),
          "unbound", "runs",
          "run-cli-fixer-plan@fixer",
          "current.json",
        ),
      );
    }

    {
      const { io } = captureIo();
      let captured: string[] | undefined;
      await runAkRole(["fixer", "--model", "test/caller-seat:high", "--project", project, "Settle the approved repair."],
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
      assert.deepEqual(
      Array.isArray(captured), true);
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
      const first = await runAkRole(["fixer", "--model", "test/caller-seat:high", "plan", "--project", project, instruction],
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
      assert.equal(first.terminal?.roleOutcome.role, "fixer");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "unbound", "runs",
      `${runId}@fixer`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const admitted = readCurrentSection(runDirectory, "admitted") as {
      phase: string; role: string; packetPath: string; ticketNumber?: number;
    };
    assert.equal(admitted.role, "fixer");
    assert.equal(admitted.phase, "plan");
    assert.equal(admitted.ticketNumber, undefined);

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
        assert.equal(args[args.indexOf("--ak-role") + 1], "fixer");
        assert.equal(args[args.indexOf("--ak-fixer-phase") + 1], "plan");
        assert.equal(args[args.indexOf("--ak-fix-packet") + 1], admitted.packetPath);
        assert.equal(args.includes(instruction), false);
        assert.equal(args.includes("[ak-role:resume-continue]"), false);
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
    assert.deepEqual(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(resumed.terminal.roleOutcome)
        : [],
      ["planned"],
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

    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole([
        "fixer", "--model", "test/caller-seat:high",
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
    assert.deepEqual(result.exitCode, 0, stdout.join("") || "prereq_unmet refused failed");
    assert.equal(stderr.join("").length, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.deepEqual(
      result.terminal!.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(result.terminal!.roleOutcome)
        : [],
      ["refused"],
    );
    const publicBlocker = (objectPayloads(result.terminal!.roleOutcome)[0] ?? {}).blocker as {
      cause?: string;
      prerequisiteId?: string;
    } | undefined;
    assert.equal(publicBlocker?.cause, "prerequisite_unmet");
    assert.equal(publicBlocker?.prerequisiteId, "owner.choice");
    assert.equal(Object.hasOwn(result.terminal!.roleOutcome, "cause"), false);
  });
});

test("public Fixer unfinished/refused/partially_completed hand off via shared Terminal exit 0", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await runAkRole(["config", "set", "inspector", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });

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
        factKey: "status",
        factValue: "unfinished",
      },
      {
        runId: "run-fixer-status-refused",
        phase: "apply",
        details: applyRefusedReceipt,
        kind: "accepted",
        status: "refused",
        // #757: classResult blockers stay nested — no lifted blockerCauses array.
        factKey: "status",
        factValue: "refused",
      },
      {
        runId: "run-fixer-status-partial",
        phase: "apply",
        details: partialReceipt,
        kind: "accepted",
        status: "partially_completed",
        factKey: "status",
        factValue: "partially_completed",
      },
    ];

    for (const row of cases) {
      const { io, stdout } = captureIo();
      const cliArgs =
        row.phase === "plan"
          ? (["fixer", "--model", "test/caller-seat:high", "plan", "--project", project, `CLI ${row.status}`] as string[])
          : (["fixer", "--model", "test/caller-seat:high", "--project", project, `CLI ${row.status}`] as string[]);
      const result = await runAkRole(cliArgs, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => row.runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
          if (args[args.indexOf("--ak-role") + 1] === "inspector") {
            return scriptedTerminatingToolSession({
              role: "inspector", toolName: INSPECTOR_OUTPUT_TOOL_NAME,
              details: { status: "converged" },
            })(args, options);
          }
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
      assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), [row.status]);
      assert.deepEqual(
        (objectPayloads(result.terminal!.roleOutcome)[0] ?? {})[row.factKey],
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
