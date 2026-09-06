import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #633 abolish one-shot — collector/doctor/notary/inspector resume through the
 * public resume entry: same session principal reopened, each seat settles its
 * own typed terminal. Shortest deterministic four-seat dispatch-table coverage.
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
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { writeRoleRunState, readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  admitCollectorInvocation,
  admitDoctorInvocation,
  admitGatekeeperInvocation,
  admitInspectorInvocation,
  admitNotaryInvocation,
  admitNavigatorInvocation,
  type AdmittedRoleInvocation,
} from "../../src/public-cli/invocation.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import {
  COLLECTOR_OUTPUT_TOOL,
  type CollectorReceipt,
} from "../../src/package-contracts/collector-output.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
} from "../../src/doctor-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/gatekeeper-output.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { sampleCompletedDoctorOutput, seedDoctorIssueRuns } from "../helpers/doctor-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { withHermesFixtureOnPath } from "../helpers/hermes-fixture.ts";
async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-resume-four-seats-", (home) =>
    withHermesFixtureOnPath(home, () => scenario(home)),
  );
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
    role: "gatekeeper",
    outputTool: GATEKEEPER_OUTPUT_TOOL_NAME,
    admit: async ({ home, project, runId }) => await admitGatekeeperInvocation({
      home, principalAuthority: piDurablePrincipalAuthority, cwd: project,
      instruction: "original admitted gatekeeper instruction", attachmentPaths: [], createRunId: () => runId,
    }),
    originalInstruction: "original admitted gatekeeper instruction",
    sealedDetails: () => ({ status: "pass", findings: [] }),
  },
  {
    role: "navigator",
    outputTool: NAVIGATOR_OUTPUT_TOOL_NAME,
    admit: async ({ home, project, runId }) => await admitNavigatorInvocation({
      home, principalAuthority: piDurablePrincipalAuthority, cwd: project,
      instruction: "original admitted navigator instruction", attachmentPaths: [], createRunId: () => runId,
    }),
    originalInstruction: "original admitted navigator instruction",
    sealedDetails: () => ({ status: "advice", candidates: [] }),
  },
  {
    role: "collector",
    outputTool: COLLECTOR_OUTPUT_TOOL,
    admit: async ({ home, project, runId }) =>
      await admitCollectorInvocation({
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        prNumber: 42,
        instruction: "original admitted collector instruction",
        repo: "acme/widgets",
        createRunId: () => runId,
      }),
    originalInstruction: "original admitted collector instruction",
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
        instruction: "original admitted doctor instruction",
        createRunId: () => runId,
      });
    },
    originalInstruction: "original admitted doctor instruction",
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

      const { io, stderr } = captureIo();
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
      assert.equal(resumed.terminal!.roleOutcome.role, spec.role);
      assert.equal(resumed.terminal!.runId, runId);
      assert.equal(resumed.terminal!.resume, undefined);

      // Durable run-state reaches terminal for the resumed run.
      const durable = await readRoleRunState(admitted.runDirectory, piDurablePrincipalAuthority);
      assert.equal(durable?.state, "terminal");
      assert.equal(durable?.sessionFile, sessionFile);
    });
  });
}
