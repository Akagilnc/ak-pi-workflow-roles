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
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import {
  savePublicCliConfig,
  setPersistentSeatConfig,
  setPersistentSeatHost,
} from "../../src/public-cli/config.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "../../src/collector-ledger.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import {
  createGrokRoleTurnHost,
  type GrokPreparedTurn,
} from "../../src/grok/role-turn-host.ts";
import { prepareGrokRoleEnvelope } from "../../src/grok/role-envelope.ts";
import { createGrokRoleRuntimeDependencies } from "../../src/grok/production-host.ts";
import { createGrokSessionIdentityAuthority } from "../../src/grok/session-identity.ts";
import { callThroughMcp, type GrokMcpServer } from "../helpers/grok-mcp-harness.ts";
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

test("public resume reopens the Collector principal through real activation and settles its typed terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    const agentDir = join(home, ".pi", "agent");
    const binDir = join(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedGitProject(project);

    const gh = join(binDir, "gh");
    await writeFile(
      gh,
      `#!/usr/bin/env node
const args=process.argv.slice(2); const path=args.filter(a=>a.startsWith('/')).at(-1)||'';
function ok(body){process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body));}
if(path.endsWith('/user')) ok({login:'collector-fixture'});
else if(path.includes('/pulls/42')&&!path.includes('/reviews')&&!path.includes('/comments')) ok({number:42,state:'open',head:{sha:'resume-head'},updated_at:'2026-09-03T00:00:00Z',html_url:'https://github.com/acme/widgets/pull/42'});
else if(path.includes('/reviews')||path.includes('/comments')||path.includes('/reactions')) ok([]); else process.exit(2);
`,
      "utf8",
    );
    await chmod(gh, 0o755);

    // Live seat table selects the Grok production envelope (session_start.reason=resume).
    await savePublicCliConfig(
      setPersistentSeatHost(
        setPersistentSeatConfig({ seats: {} }, "collector", {
          provider: "xai",
          model: "grok-4.5",
          thinking: "high",
        }),
        "collector",
        "grok-build",
      ),
      home,
    );

    const runId = "run-resume-collector-real-001";
    const admitted = await admitCollectorInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      prNumber: 42,
      instruction: "",
      repo: "acme/widgets",
      createRunId: () => runId,
      model: { provider: "xai", model: "grok-4.5", thinking: "high" },
    });
    const coordinates = piDurablePrincipalAuthority.decode(admitted.principal);
    await writeRoleRunState(admitted.runDirectory, {
      runId,
      role: "collector",
      state: "resumable",
      bookKey: admitted.bookKey,
      projectRoot: admitted.projectRoot,
      sessionDirectory: coordinates.sessionDirectory,
      sessionFile: coordinates.sessionFile,
      admittedRequestPath: admitted.admittedRequestPath,
    });
    await mkdir(coordinates.sessionDirectory, { recursive: true });
    const initialRows = [
      {
        type: "session",
        version: 3,
        id: "collector-resume-session",
        timestamp: "2026-09-03T00:00:00.000Z",
        cwd: project,
      },
      {
        type: "message",
        id: "collector-initial-user",
        parentId: null,
        timestamp: "2026-09-03T00:00:01.000Z",
        message: { role: "user", content: "kickoff", timestamp: 1 },
      },
    ];
    await writeFile(
      coordinates.sessionFile,
      `${initialRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );

    const sessionIdentity = createGrokSessionIdentityAuthority(piDurablePrincipalAuthority);
    const roleRuntimeDependencies = createGrokRoleRuntimeDependencies(packageRoot);
    let preparedTurn: GrokPreparedTurn | undefined;
    let observedResumeContinuation = false;
    const grokHost = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      inspect: async () => ({ privateActive: [], akActive: [COLLECTOR_OUTPUT_TOOL] }),
      prepare: async (request) => {
        assert.equal(
          request.continuation.kind,
          "resume",
          "Grok envelope must activate Collector with session_start.reason=resume",
        );
        observedResumeContinuation = true;
        const prepared = await prepareGrokRoleEnvelope({
          request,
          dependencies: roleRuntimeDependencies,
          sessionFile: sessionIdentity.resolveSessionFile(request.principal),
          socketPath: join(home, `collector-resume-${randomUUID()}.sock`),
        });
        preparedTurn = prepared;
        return prepared;
      },
      connect: async () => ({
        async request(method) {
          if (method === "initialize") {
            return {
              _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } },
            };
          }
          if (method === "session/new" || method === "session/load") {
            return { sessionId: "collector-resume-grok-session" };
          }
          if (method === "session/prompt") {
            assert.ok(preparedTurn, "prepare must run before session/prompt");
            const server = preparedTurn.mcpServers[0] as GrokMcpServer;
            // Pi: observe on a prior toolUse message; turn_end sees sole output.
            // Grok ACP closes every session/prompt — drain observe via production
            // closeRound, then sole output for the host's sealing closeRound.
            const observed = await callThroughMcp(server, COLLECTOR_OBSERVE_TOOL, {});
            assert.equal(observed.error, undefined, JSON.stringify(observed));
            await preparedTurn.closeRound();
            const sealed = await callThroughMcp(server, COLLECTOR_OUTPUT_TOOL, {});
            assert.equal(sealed.error, undefined, JSON.stringify(sealed));
            return { stopReason: "end_turn" };
          }
          if (method === "session/close") return {};
          return {};
        },
        notify() {},
        async close() {},
      }),
    });

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const { io, stderr } = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        agentDir,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        collectorTimeoutMs: 90_000,
        hostAdapters: [
          {
            name: "grok-build",
            create: () => ({ ok: true as const, host: grokHost }),
          },
        ],
        io,
      });

      const errorArtifact = resumed.terminal?.artifacts.find((artifact) => artifact.kind === "error");
      const errorDetail =
        errorArtifact === undefined ? "" : await readFile(errorArtifact.path, "utf8");
      const sessionDetail = await readFile(coordinates.sessionFile, "utf8");
      assert.equal(resumed.exitCode, 0, `${stderr.join("")}\n${errorDetail}\n${sessionDetail}`);
      assert.equal(
        observedResumeContinuation,
        true,
        "Collector activation must observe continuation.kind=resume",
      );
      assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
      assert.equal(resumed.terminal?.roleOutcome.role, "collector");
      assert.equal(resumed.terminal?.runId, runId);
      const durable = await readRoleRunState(admitted.runDirectory, piDurablePrincipalAuthority);
      assert.equal(durable?.state, "terminal");
      assert.equal(durable?.sessionFile, coordinates.sessionFile);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

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
