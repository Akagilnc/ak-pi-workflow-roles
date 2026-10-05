/**
 * #1168: fixer/coder/merger dispatch text is not copied into the run directory
 * or startup materials; --prerequisites is an opaque path like --attach.
 * Seam: public ak-role + in-repo fake host (prompt via prepareRoleEnvelope).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/fixer-output.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { buildInstructionTransportPrompt } from "../../src/public-cli/invocation.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { materializeConflictedRepo } from "../helpers/merger-conflict-fixture.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";

const SEAT = "test/caller-seat:high";
const CREDS = { "openai-codex": true, xai: true } as const;

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

async function assertAbsent(path: string): Promise<void> {
  await assert.rejects(
    () => access(path),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

type Captured = {
  readonly prompt: string;
  readonly systemBody: string;
  readonly activation: RoleTurnRequest["activation"];
};

async function captureEnvelope(request: RoleTurnRequest): Promise<Captured> {
  const prepared = await prepareRoleEnvelope({
    request: { ...request, host: request.host ?? "codex" },
    dependencies: createRoleRuntimeDependencies(packageRoot),
    socketPath: `/tmp/ak-1168-${randomUUID()}.sock`,
    sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
  });
  try {
    return {
      prompt: prepared.prompt,
      systemBody: prepared.systemPrompt.body,
      activation: request.activation,
    };
  } finally {
    await prepared.dispose?.();
  }
}

function firstCaptureHost(
  onCapture: (request: RoleTurnRequest) => Promise<Captured>,
): { host: RoleTurnHost; get(): Captured } {
  let captured: Captured | undefined;
  const host = createMinimalHost(async (request) => {
    if (captured === undefined) captured = await onCapture(request);
    return { code: 1, stderr: "stop after capture", timedOut: false };
  });
  return {
    host,
    get() {
      assert.ok(captured !== undefined, "fake host did not capture a turn");
      return captured;
    },
  };
}

test("#1168 fixer: dispatch once; no copies; opaque --prerequisites; unfinished 缺前置", async () => {
  await withTempRoot("ak-1168-fixer-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const instruction = "Repair the class under review.";
    const missingPrereq = join(home, "missing-prereqs.json");
    const badPrereq = join(home, "not-json.txt");
    await writeFile(badPrereq, "this is not json", "utf8");

    // Missing / non-JSON prerequisites: still admit and start.
    for (const [label, prereqPath, runId] of [
      ["missing", missingPrereq, "run-1168-fixer-missing-prereq"],
      ["non-json", badPrereq, "run-1168-fixer-bad-prereq"],
    ] as const) {
      let capturedArgs: string[] | undefined;
      const { io } = captureIo();
      const result = await runAkRole([
        "fixer", "--model", SEAT, "--project", project,
        "--prerequisites", prereqPath,
        instruction,
      ], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
        credentials: CREDS,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            capturedArgs = [...args];
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await writeFile(
              sessionFile,
              sessionToolResultLine(FIXER_OUTPUT_TOOL_NAME, {
                status: "planned",
                report: "plan ok",
              }),
            );
            return {
              code: 0,
              timedOut: false,
              stderr: "",
              args: [...args],
              sealedAcceptance: {
                role: "fixer" as const,
                details: { status: "planned", report: "plan ok" },
              },
            };
          },
        }),
      });
      assert.equal(result.exitCode, 0, `${label} must still start`);
      assert.ok(capturedArgs !== undefined);

      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@fixer`,
      );
      await assertAbsent(join(runDirectory, "fix-packet.md"));
      await assertAbsent(join(runDirectory, "prerequisites.json"));

      const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
        admitted: {
          instruction: string;
          prerequisitesPath?: string;
          packetPath?: string;
          prerequisites?: unknown;
        };
      };
      assert.equal(current.admitted.instruction, instruction);
      assert.equal(current.admitted.prerequisitesPath, prereqPath);
      assert.equal("packetPath" in current.admitted, false);
      assert.equal("prerequisites" in current.admitted, false);

      const transport = buildInstructionTransportPrompt({
        ...current.admitted,
        role: "fixer",
        attachments: [],
      } as Parameters<typeof buildInstructionTransportPrompt>[0]);
      assert.ok(transport.startsWith(instruction));
      assert.ok(transport.includes(`--prerequisites ${prereqPath}`));
      assert.equal(capturedArgs.includes("--ak-fix-packet"), false);
    }

    // Startup materials: no dispatch copy / leg-dir packet path.
    {
      const probe = firstCaptureHost(captureEnvelope);
      await runAkRole([
        "fixer", "--model", SEAT, "--project", project, instruction,
      ], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-1168-fixer-envelope",
        io: captureIo().io,
        credentials: CREDS,
        roleTurnHost: probe.host,
      });
      const captured = probe.get();
      assert.ok(captured.prompt.startsWith(instruction));
      assert.equal(captured.systemBody.includes(instruction), false);
      assert.equal(captured.systemBody.includes("fix_packet_path"), false);
      assert.equal(captured.systemBody.includes("fixer_prerequisites_path"), false);
      assert.equal("packetPath" in captured.activation, false);
    }

    // unfinished 缺前置: ledger + terminal present as usual.
    {
      const unfinished = {
        status: "unfinished" as const,
        report: "Blocked: owner choice not present.",
        remainingScope: "repair apply after owner chooses",
        reason: "缺前置",
      };
      const { io } = captureIo();
      const result = await runAkRole([
        "fixer", "--model", SEAT, "--project", project,
        "--prerequisites", badPrereq,
        instruction,
      ], {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-1168-fixer-unfinished",
        io,
        credentials: CREDS,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await writeFile(
              sessionFile,
              sessionToolResultLine(FIXER_OUTPUT_TOOL_NAME, unfinished),
            );
            return {
              code: 0,
              timedOut: false,
              stderr: "",
              args: [...args],
              sealedAcceptance: {
                role: "fixer" as const,
                details: unfinished,
              },
            };
          },
        }),
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.deepEqual(
        result.terminal?.roleOutcome.kind === "accepted"
          ? payloadStatusSequence(result.terminal.roleOutcome)
          : [],
        ["unfinished"],
      );
      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home, ".ak-roles", "books", bookKey, "unbound", "runs",
        "run-1168-fixer-unfinished@fixer",
      );
      const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
        terminal?: { face?: string };
        submission?: { latest?: { accepted?: { status?: string; reason?: string } } };
      };
      assert.equal(current.terminal?.face, "report");
      assert.equal(current.submission?.latest?.accepted?.status, "unfinished");
      assert.equal(current.submission?.latest?.accepted?.reason, "缺前置");
    }
  });
});

test("#1168 coder: dispatch once; no task.md; resume reaches host", async () => {
  await withTempRoot("ak-1168-coder-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const instruction = "Implement the approved slice.";

    const probe = firstCaptureHost(captureEnvelope);
    await runAkRole([
      "coder", "--model", SEAT, "--project", project, "plan", instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-1168-coder-envelope",
      io: captureIo().io,
      credentials: CREDS,
      roleTurnHost: probe.host,
    });
    const captured = probe.get();
    assert.ok(captured.prompt.startsWith(instruction));
    assert.equal(captured.systemBody.includes(instruction), false);
    assert.equal(captured.systemBody.includes("coder_task"), false);
    assert.equal("taskPath" in captured.activation, false);

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home, ".ak-roles", "books", bookKey, "unbound", "runs",
      "run-1168-coder-envelope@coder",
    );
    await assertAbsent(join(runDirectory, "task.md"));

    // Fresh admit + resume reaches host without ak-coder-task.
    const runId = "run-1168-coder-resume";
    await runAkRole([
      "coder", "--model", SEAT, "--project", project, "plan", instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => runId,
      io: captureIo().io,
      credentials: CREDS,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            sessionToolResultLine(CODER_OUTPUT_TOOL_NAME, {
              status: "planned",
              report: "first plan",
            }),
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
            sealedAcceptance: {
              role: "coder" as const,
              details: { status: "planned", report: "first plan" },
            },
          };
        },
      }),
    });

    let resumeReached = false;
    const resumed = await runAkRole(["resume", "--model", SEAT, runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: CREDS,
      io: captureIo().io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          resumeReached = true;
          assert.equal(args.includes("--ak-coder-task"), false);
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            sessionToolResultLine(CODER_OUTPUT_TOOL_NAME, {
              status: "planned",
              report: "resumed plan",
            }),
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
            sealedAcceptance: {
              role: "coder" as const,
              details: { status: "planned", report: "resumed plan" },
            },
          };
        },
      }),
    });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumeReached, true);
  });
});

test("#1168 merger: no task/authority copies; git facts remain; resume reaches host", async () => {
  await withTempRoot("ak-1168-merger-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    const fixture = await materializeConflictedRepo(project);
    const instruction = "Reconcile both intents.";

    const probe = firstCaptureHost(captureEnvelope);
    await runAkRole([
      "merger", "--model", SEAT, "--project", project, instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-1168-merger-envelope",
      io: captureIo().io,
      credentials: CREDS,
      roleTurnHost: probe.host,
    });
    const captured = probe.get();
    assert.ok(captured.prompt.startsWith(instruction));
    assert.equal(captured.systemBody.includes(instruction), false);

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home, ".ak-roles", "books", bookKey, "unbound", "runs",
      "run-1168-merger-envelope@merger",
    );
    const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
      admitted: {
        instruction: string;
        mergerInputPath: string;
        derived: {
          targetObjectId: string;
          sourceObjectId: string;
          expectedConflictPaths: string[];
        };
      };
    };
    assert.equal(current.admitted.instruction, instruction);
    assert.equal(current.admitted.derived.targetObjectId, fixture.target);
    assert.equal(current.admitted.derived.sourceObjectId, fixture.source);
    assert.deepEqual(current.admitted.derived.expectedConflictPaths, [fixture.conflictPath]);

    const mergerInput = JSON.parse(
      await readFile(current.admitted.mergerInputPath, "utf8"),
    ) as {
      materials?: {
        task?: unknown;
        authority?: unknown;
      };
      targetObjectId: string;
      sourceObjectId: string;
      expectedConflictPaths: string[];
    };
    assert.equal("task" in (mergerInput.materials ?? {}), false);
    assert.equal("authority" in (mergerInput.materials ?? {}), false);
    assert.equal(mergerInput.targetObjectId, fixture.target);
    assert.equal(mergerInput.sourceObjectId, fixture.source);
    assert.deepEqual(mergerInput.expectedConflictPaths, [fixture.conflictPath]);

    // Replay freeze source: admitted instruction is the dispatch text.
    const transport = buildInstructionTransportPrompt({
      ...current.admitted,
      role: "merger",
      attachments: [],
    } as Parameters<typeof buildInstructionTransportPrompt>[0]);
    assert.ok(transport.startsWith(instruction));

    const runId = "run-1168-merger-resume";
    await runAkRole([
      "merger", "--model", SEAT, "--project", project, instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => runId,
      io: captureIo().io,
      credentials: CREDS,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          const receipt = {
            status: "escalate" as const,
            attemptId: runId,
            diagnosis: "need owner",
            report: "escalate",
          };
          await writeFile(
            sessionFile,
            sessionToolResultLine(MERGER_OUTPUT_TOOL_NAME, receipt),
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
            sealedAcceptance: { role: "merger" as const, details: receipt },
          };
        },
      }),
    });

    let resumeReached = false;
    const resumed = await runAkRole(["resume", "--model", SEAT, runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: CREDS,
      io: captureIo().io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          resumeReached = true;
          assert.ok(args.includes("--ak-merger-input"));
          const sessionFile = args[args.indexOf("--session") + 1]!;
          const receipt = {
            status: "escalate" as const,
            attemptId: runId,
            diagnosis: "still need owner",
            report: "escalate again",
          };
          await writeFile(
            sessionFile,
            sessionToolResultLine(MERGER_OUTPUT_TOOL_NAME, receipt),
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
            sealedAcceptance: { role: "merger" as const, details: receipt },
          };
        },
      }),
    });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumeReached, true);
  });
});
