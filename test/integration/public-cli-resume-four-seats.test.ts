/**
 * #633 abolish one-shot — collector/doctor/notary/inspector resume through the
 * public `ak-role resume <runId>` entry: same session principal reopened, and
 * each seat settles its own typed terminal. Replaces the old resume-rejection
 * negative case (transformed into these four positive tracers, one loop body).
 *
 * The failure tracers additionally pin the cross-attempt isolation contract:
 * a prior attempt's residual must not mask the current resume failure's cause
 * (#599 / #633).
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

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { writeRoleRunState, readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  admitCollectorInvocation,
  admitDoctorInvocation,
  admitInspectorInvocation,
  admitNotaryInvocation,
  type AdmittedRoleInvocation,
} from "../../src/public-cli/invocation.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { COLLECTOR_WAIT_TOOL } from "../../src/collector-ledger.ts";
import { COLLECTOR_OUTPUT_TOOL, type CollectorReceipt } from "../../src/package-contracts/collector-output.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
} from "../../src/doctor-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { sampleCompletedDoctorOutput, seedDoctorIssueRuns } from "../helpers/doctor-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-resume-four-seats-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "resume-four-seats@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Resume Four Seats"], {
    cwd: root,
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
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

const DOCTOR_ISSUE_NUMBER = 5;

const DOCTOR_ISSUE = { issueNumber: DOCTOR_ISSUE_NUMBER } as const;

type SeatTracerSpec = {
  readonly role: TerminalRoleName;
  readonly outputTool: string;
  /** Admit the interrupted run (no dispatch); returns the durable admitted record. */
  readonly admit: (ctx: {
    home: string;
    project: string;
    runId: string;
  }) => Promise<AdmittedRoleInvocation>;
  /**
   * Build the sealed typed terminal details from the persisted admitted
   * request record — proving the resumed seat settles on its own contract.
   */
  readonly sealedDetails: (admittedRequest: Record<string, unknown>) => unknown;
  /** Instruction bytes that must never ride the resume dispatch as a new prompt. */
  readonly originalInstruction?: string;
};

const SEAT_SPECS: readonly SeatTracerSpec[] = [
  {
    role: "collector",
    outputTool: COLLECTOR_OUTPUT_TOOL,
    admit: async ({ home, project, runId }) =>
      await admitCollectorInvocation({
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        prNumber: 42,
        instruction: "",
        repo: "acme/widgets",
        createRunId: () => runId,
      }),
    sealedDetails: (admitted) =>
      ({
        host: "github.com",
        repository: admitted.repository as string,
        prNumber: admitted.prNumber as number,
        manifestDigest: admitted.manifestDigest as string,
        activationTime: "2026-09-03T00:00:00.000Z",
        deadlineTime: "2026-09-03T00:05:00.000Z",
        finalObservationTime: "2026-09-03T00:04:00.000Z",
        finalSnapshotId: "snap-resume-001",
        targetHead: "abc123",
        groups: [],
        requestAttempts: [],
        snapshots: [],
        evidenceRecords: [],
      }) satisfies CollectorReceipt,
  },
  {
    role: "doctor",
    outputTool: DOCTOR_OUTPUT_TOOL_NAME,
    admit: async ({ home, project, runId }) => {
      const bookKey = resolveBookKeyFromGit(project);
      await seedDoctorIssueRuns(home, bookKey, DOCTOR_ISSUE_NUMBER);
      return await admitDoctorInvocation({
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        issueNumber: DOCTOR_ISSUE_NUMBER,
        instruction: "",
        createRunId: () => runId,
      });
    },
    sealedDetails: (admitted) => {
      const caseIdentity = admitted.caseIdentity as {
        issueNumber: number;
        runsPath: string;
      };
      return sampleCompletedDoctorOutput(caseIdentity);
    },
  },
  {
    role: "notary",
    outputTool: NOTARY_OUTPUT_TOOL_NAME,
    admit: async ({ home, project, runId }) => {
      const sourceRunPath = await seedCanonicalSourceRun(home, project);
      return await admitNotaryInvocation({
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        sourceRun: sourceRunPath,
        createRunId: () => runId,
      });
    },
    sealedDetails: () => ({ status: "pass", findings: [] }),
  },
  {
    role: "inspector",
    outputTool: INSPECTOR_OUTPUT_TOOL_NAME,
    admit: async ({ home, project, runId }) =>
      await admitInspectorInvocation({
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        instruction: "original admitted inspector instruction",
        attachmentPaths: [],
        createRunId: () => runId,
      }),
    sealedDetails: () => ({ status: "pass", findings: [] }),
    originalInstruction: "original admitted inspector instruction",
  },
];

for (const spec of SEAT_SPECS) {
  test(`resume continues the exact ${spec.role} session and settles its typed terminal`, async () => {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const runId = `run-resume-${spec.role}-001`;

      const admitted = await spec.admit({ home, project, runId });
      const coordinates = piDurablePrincipalAuthority.decode(admitted.principal);
      const sessionFile = coordinates.sessionFile;
      const sessionDirectory = coordinates.sessionDirectory;

      // Interrupted run-state so the public resume entry can find and reopen it.
      await writeRoleRunState(admitted.runDirectory, {
        runId: admitted.runId,
        role: spec.role,
        state: "resumable",
        bookKey: admitted.bookKey,
        projectRoot: admitted.projectRoot,
        sessionDirectory,
        sessionFile,
        admittedRequestPath: admitted.admittedRequestPath,
      });
      // An interrupted run has an opened session principal — seed its first row.
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: "message", message: { role: "user", content: "kickoff" } })}\n`,
        "utf8",
      );

      const admittedRequest = JSON.parse(
        await readFile(admitted.admittedRequestPath, "utf8"),
      ) as Record<string, unknown>;

      const baseRunner: LegacyFauxPiRunner = scriptedTerminatingToolSession({
        role: spec.role,
        toolName: spec.outputTool,
        details: spec.sealedDetails(admittedRequest),
      });
      const openedPrincipals = new Set<string>();
      let resumeSessionFile: string | undefined;

      const { io, stdout, stderr } = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
            resumeSessionFile = args[args.indexOf("--session") + 1]!;
            openedPrincipals.add(resumeSessionFile);
            if (spec.originalInstruction !== undefined) {
              assert.equal(args.includes(spec.originalInstruction), false);
            }
            return await baseRunner(args, options);
          },
        }),
      });

      assert.ok(resumeSessionFile, stderr.join(""));
      // Exact principal reopen — same session, never directory-latest.
      assert.equal(resumeSessionFile, sessionFile);
      assert.deepEqual([...openedPrincipals], [sessionFile]);

      assert.equal(resumed.exitCode, 0);
      assert.ok(resumed.terminal);
      assert.equal(resumed.terminal!.roleOutcome.kind, "accepted");
      assert.equal(resumed.terminal!.runId, runId);
      assert.equal(resumed.terminal!.resume, undefined);
      assert.equal(stdout.length, 1);

      // Durable run-state reaches terminal for the resumed run.
      const durable = await readRoleRunState(admitted.runDirectory, piDurablePrincipalAuthority);
      assert.equal(durable?.state, "terminal");
      assert.equal(durable?.sessionFile, sessionFile);
    });
  });
}

type SeatFailureSpec = {
  readonly role: TerminalRoleName;
  readonly firstArgv: (project: string, sourceRunPath: string) => readonly string[];
  /**
   * First attempt through the public entry leaves a prior-attempt residual on
   * the session principal. The public settle projects it — this pins the shape
   * so the precondition (a live residual) is proven before the resume.
   */
  readonly firstOutcome: {
    readonly kind: string;
    readonly cause?: string;
  };
};

/** Errored collector wait residual whose duration is far beyond the wait cap. */
const collectorPriorResidualRunner: LegacyFauxPiRunner = async (args) => {
  const sessionFile = args[args.indexOf("--session") + 1]!;
  const rows = [
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-08-30T00:00:00.000Z", message: { role: "user", content: "kickoff", timestamp: 1 } },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-08-30T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "wait-1", name: COLLECTOR_WAIT_TOOL, arguments: { durationMs: 2_000_000 } }],
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "result-1",
      parentId: "assistant-1",
      timestamp: "2026-08-30T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "wait-1",
        toolName: COLLECTOR_WAIT_TOOL,
        content: [{ type: "text", text: "PRIOR-attempt-residual-error" }],
        isError: true,
        timestamp: 3,
      },
    },
  ];
  await mkdir(join(sessionFile, ".."), { recursive: true });
  await writeFile(sessionFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return { code: 0, timedOut: false, stderr: "", args: [...args] };
};

const failureRunnerFor = (role: TerminalRoleName): LegacyFauxPiRunner => {
  if (role === "collector") return collectorPriorResidualRunner;
  if (role === "doctor") {
    return scriptedTerminatingToolSession({
      role,
      toolName: DOCTOR_OUTPUT_TOOL_NAME,
      details: { status: "completed", findings: [] },
      isError: true,
      acceptedText: "PRIOR-attempt-residual-error",
    });
  }
  return scriptedTerminatingToolSession({
    role,
    toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : INSPECTOR_OUTPUT_TOOL_NAME,
    details: { status: "pass", findings: [] },
    isError: true,
    acceptedText: "PRIOR-attempt-residual-error",
  });
};

const FAILURE_SEAT_SPECS: readonly SeatFailureSpec[] = [
  {
    role: "collector",
    firstArgv: (project) => ["collector", "--pr", "42", "--repo", "acme/widgets", "--project", project],
    // The wait residual's duration is beyond the wait cap — the settle scan
    // projects it as a residual-incomplete terminal for that first attempt.
    firstOutcome: { kind: "incomplete" },
  },
  {
    role: "doctor",
    firstArgv: (project) => ["doctor", "--issue", String(DOCTOR_ISSUE_NUMBER), "--project", project],
    firstOutcome: { kind: "failure", cause: "output" },
  },
  {
    role: "notary",
    firstArgv: (project, sourceRunPath) => ["notary", "--source-run", sourceRunPath, "--project", project],
    firstOutcome: { kind: "failure", cause: "output" },
  },
  {
    role: "inspector",
    firstArgv: (project) => ["inspector", "--project", project, "PRIOR residual material"],
    firstOutcome: { kind: "failure", cause: "output" },
  },
];

test("resume failure keeps the current provider cause instead of a prior-attempt residual", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);

    for (const spec of FAILURE_SEAT_SPECS) {
      const runId = `run-fail-resume-${spec.role}-001`;
      if (spec.role === "doctor") {
        await seedDoctorIssueRuns(home, resolveBookKeyFromGit(project), DOCTOR_ISSUE_NUMBER);
      }

      const firstIo = captureIo();
      const first = await runAkRole(spec.firstArgv(project, sourceRunPath) as string[], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => runId,
        io: firstIo.io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: failureRunnerFor(spec.role),
        }),
      });

      // Precondition: the first attempt genuinely settled on the prior residual
      // (it belonged to that attempt), leaving it on the session principal.
      assert.equal(first.exitCode, 1, `${spec.role} first attempt must fail loudly`);
      assert.ok(first.terminal);
      assert.equal(first.terminal!.roleOutcome.kind, spec.firstOutcome.kind);
      if (spec.firstOutcome.cause !== undefined) {
        assert.equal(
          (first.terminal!.roleOutcome as { cause?: string }).cause,
          spec.firstOutcome.cause,
          `${spec.role}: first-attempt residual belongs to that attempt`,
        );
      }

      // Resume: the prior residual stays on the session (production resume
      // appends, never wipes); the current attempt times out with no output.
      const resumeIo = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io: resumeIo.io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            const prior = await readFile(sessionFile, "utf8");
            const resumeUser = {
              type: "message",
              id: "user-resume",
              parentId: null,
              timestamp: "2026-08-30T00:01:00.000Z",
              message: { role: "user", content: "resume kickoff", timestamp: 10 },
            };
            await writeFile(
              sessionFile,
              `${prior}${JSON.stringify(resumeUser)}\n`,
              "utf8",
            );
            return { code: 1, stderr: "upstream timeout\n", timedOut: true, args: [...args] };
          },
        }),
      });

      assert.equal(resumed.exitCode, 1, resumeIo.stdout.join("") || `${spec.role} resume timeout path failed`);
      assert.ok(resumed.terminal);
      assert.equal(resumed.terminal!.roleOutcome.kind, "failure");
      assert.equal(
        (resumed.terminal!.roleOutcome as { cause?: string }).cause,
        "timeout",
        `${spec.role}: prior-attempt residual must not mask the current resume timeout`,
      );
    }
  });
});
