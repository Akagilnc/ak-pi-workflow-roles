import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixtureDoctorAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
/**
 * #113 public Doctor path — Issue identity + optional confined runs root
 * construct a truthful single-case evidence input; #78 locator remains sole
 * session/content route; completed/refused settle on the common Terminal face.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
  type DoctorOutput,
} from "../../src/doctor-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";

import {
  admitDoctorInvocation,
} from "../../src/public-cli/invocation.ts";
import {
  settleDoctorTerminalResult,
  trySettleDoctorTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-doctor-"));
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "doctor@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Doctor Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function isUsage(error: unknown): boolean {
  return error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
}

const sessionRows = [
  {
    type: "session",
    version: 3,
    id: "real-shape",
    timestamp: "2026-08-01T05:01:18.580Z",
    cwd: "/repo",
  },
  {
    type: "message",
    timestamp: "2026-08-01T05:01:19.000Z",
    message: {
      role: "assistant",
      responseId: "r1",
      usage: { output: 7 },
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "ak_coder_output",
          arguments: {},
        },
      ],
    },
  },
  {
    type: "message",
    timestamp: "2026-08-01T05:01:20.000Z",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ak_coder_output",
      isError: false,
      details: { status: "completed", report: "done" },
    },
  },
];

async function seedIssueRuns(
  home: string,
  bookKey: string,
  issueNumber: number,
): Promise<string> {
  const runs = join(
    home,
    ".ak-roles",
    "books",
    bookKey,
    "issues",
    String(issueNumber),
    "runs",
  );
  await mkdir(join(runs, "review-001", "session"), { recursive: true });
  await writeFile(
    join(runs, "review-001", "session", "leg.jsonl"),
    `${sessionRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return runs;
}

function sampleCompletedDoctorOutput(
  identity: { issueNumber: number; runsPath: string },
  findingObservation?: string,
): DoctorOutput {
  return {
    status: "completed",
    case: identity,
    findings:
      findingObservation === undefined
        ? []
        : [{ targetKey: "law/unique-s2", observation: findingObservation, evidenceIds: ["ev-1"] }],
    cost: {
      invocations: { count: 1, sources: ["review-001"] },
      legs: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      modelApiTurns: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      outputTokens: { count: 7, sources: ["review-001/session/leg.jsonl"] },
      toolCalls: { count: 1, sources: ["review-001/session/leg.jsonl"] },
      retries: {
        count: 0,
        sources: [],
        evidence: "literal run-dir naming",
      },
      statuses: [
        { source: "review-001/session/leg.jsonl", status: "completed" },
      ],
      commits: [],
      sessions: [
        {
          source: "review-001/session/leg.jsonl",
          startedAt: "2026-08-01T05:01:18.580Z",
          endedAt: "2026-08-01T05:01:20.000Z",
          wallMilliseconds: 1420,
          completion: "accepted",
        },
      ],
      outputBytes: {
        count: 1,
        sources: ["review-001/session/leg.jsonl"],
        payload: "raw JSONL bytes",
        providerWireBytes: "unavailable",
      },
    },
  };
}

test("admitDoctorInvocation builds #78 issue runs case and freezes identity without a second content store", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const seededRuns = await seedIssueRuns(home, bookKey, 40);
    const expectedPatient = await loadDoctorCase(seededRuns);

    const admitted = await admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      issueNumber: 40,
      createRunId: () => "run-doctor-001",
    });

    assert.equal(admitted.role, "doctor");
    assert.equal(admitted.issueNumber, 40);
    assert.equal(admitted.caseRunsPath, await realpath(seededRuns));
    assert.deepEqual(admitted.caseIdentity, expectedPatient.identity);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "runs", "run-doctor-001@doctor"),
    );
    assert.equal(
      piDurablePrincipalAuthority.decode(admitted.principal).sessionFile,
      join(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, "session.jsonl"),
    );

    // Case path is the #78 issue runs locator — not a copied case packet.
    const persisted = JSON.parse(
      await readFile(admitted.admittedRequestPath, "utf8"),
    ) as {
      role: string;
      issueNumber: number;
      caseRunsPath: string;
      caseIdentity: { issueNumber: number; runsPath: string };
    };
    assert.equal(persisted.role, "doctor");
    assert.equal(persisted.issueNumber, 40);
    assert.equal(persisted.caseRunsPath, admitted.caseRunsPath);
    assert.deepEqual(persisted.caseIdentity, expectedPatient.identity);

    // Empty retained root still admits — Doctor's refusal boundary owns insufficiency.
    const emptyIssue = 41;
    const emptyRuns = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "issues",
      String(emptyIssue),
      "runs",
    );
    await mkdir(emptyRuns, { recursive: true });
    const emptyAdmitted = await admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      issueNumber: emptyIssue,
      createRunId: () => "run-doctor-empty",
    });
    assert.equal(emptyAdmitted.issueNumber, emptyIssue);
    const emptyPatient = await loadDoctorCase(emptyAdmitted.caseRunsPath);
    assert.equal(emptyPatient.evidence.length, 0);
    assert.deepEqual(emptyAdmitted.caseIdentity, emptyPatient.identity);
  });
});

test("admitDoctorInvocation rejects missing/malformed runs override before admission", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedIssueRuns(home, bookKey, 40);

    // Absolute escape / missing path
    await assert.rejects(
      () =>
        admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          issueNumber: 40,
          runs: "/tmp/not-a-doctor-case",
          createRunId: () => "run-bad-abs",
        }),
      isUsage,
    );

    // Relative path that does not match Doctor case grammar
    await mkdir(join(project, "random-runs"), { recursive: true });
    await assert.rejects(
      () =>
        admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          issueNumber: 40,
          runs: "random-runs",
          createRunId: () => "run-bad-shape",
        }),
      isUsage,
    );

    // Issue number mismatch against path grammar
    const wrongIssueRuns = join(
      project,
      ".ak-roles",
      "books",
      "demo-book",
      "issues",
      "99",
      "runs",
    );
    await mkdir(wrongIssueRuns, { recursive: true });
    await assert.rejects(
      () =>
        admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          issueNumber: 40,
          runs: ".ak-roles/books/demo-book/issues/99/runs",
          createRunId: () => "run-mismatch",
        }),
      isUsage,
    );

    // Project-relative runs root that matches grammar + issue is admitted
    const localRuns = join(
      project,
      ".ak-roles",
      "books",
      "demo-book",
      "issues",
      "40",
      "runs",
    );
    await mkdir(join(localRuns, "coder", "session"), { recursive: true });
    await writeFile(
      join(localRuns, "coder", "session", "leg.jsonl"),
      `${sessionRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    const admitted = await admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      issueNumber: 40,
      runs: ".ak-roles/books/demo-book/issues/40/runs",
      createRunId: () => "run-local-runs",
    });
    assert.equal(admitted.caseRunsPath, await realpath(localRuns));
    assert.equal(admitted.caseIdentity.issueNumber, 40);
    // loadDoctorCase remains the sole case constructor (structurally exact).
    assert.deepEqual(
      admitted.caseIdentity,
      (await loadDoctorCase(admitted.caseRunsPath)).identity,
    );
  });
});

test("doctor activation projects casePath/isolation flags through typed request via real entry", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedIssueRuns(home, bookKey, 12);

    const captured: { current: RoleTurnRequest | undefined } = { current: undefined };

    await runAkRole(
      ["doctor", "--issue", "12", "--project", project, "diagnose retries"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-doctor-typed",
        io: captureIo().io,
        roleTurnHost: createMinimalHost((request) => {
          captured.current = request;
          return Promise.resolve({ code: 1, stderr: "stop", timedOut: false });
        }),
      },
    );

    const req = captured.current!;
    assert.equal(req.activation.role, "doctor");
    // Doctor activation derives casePath from the issued principal.
    assert.ok(req.activation.casePath.length > 0, "doctor must project a casePath");
    // Doctor activation does not bind skill methods.
    assert.equal(req.methods.length, 0);
  });
});

test("runAkRole doctor rejects malformed grammar before admission", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    let dispatched = false;
    const captured = captureIo();
    const result = await runAkRole(
      ["doctor", "--issue", "0", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io: captured.io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
          dispatched = true;
          throw new Error("doctor must not dispatch for malformed issue");
        },
          }),
      },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(dispatched, false);
    assert.equal(captured.stdout.join(""), "");
  });
});

test("runAkRole doctor settles completed and refused outcomes on common Terminal/artifacts", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedIssueRuns(home, bookKey, 40);
    const findingObservation = "UNIQUE-DOCTOR-FINDING-OBSERVATION-S2";

    const completedIo = captureIo();
    const completed = await runAkRole(
      ["doctor", "--issue", "40", "--project", project, "inspect"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        correlationId: "corr-doctor-113",
        io: completedIo.io,
        createRunId: () => "run-doctor-settle",
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
          assert.equal(options.env.AK_CORRELATION_ID, "corr-doctor-113");
          const casePath = args[args.indexOf("--ak-doctor-case") + 1]!;
          const patient = await loadDoctorCase(casePath);
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: DOCTOR_OUTPUT_TOOL_NAME,
                isError: false,
                details: sampleCompletedDoctorOutput(patient.identity, findingObservation),
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
          };
        },
          }),
      },
    );
    assert.equal(completed.exitCode, 0);
    assert.ok(completed.terminal);
    assert.equal(completed.terminal!.roleOutcome.role, "doctor");
    assert.equal(completed.terminal!.roleOutcome.kind, "accepted");
    assert.equal(completed.terminal!.roleOutcome.status, "completed");
    assert.equal(completed.terminal!.roleOutcome.decisiveFacts.issueNumber, 40);
    assert.equal(completed.terminal!.roleOutcome.decisiveFacts.findingsCount, 1);
    assert.match(completedIo.stdout.join(""), /doctor/);

    const reportPath = completed.terminal!.artifacts.find((a) => a.kind === "report")
      ?.path;
    assert.ok(reportPath);
    const report = JSON.parse(await readFile(reportPath!, "utf8")) as {
      role: string;
      receipt: { status: string; case: { issueNumber: number } };
    };
    assert.equal(report.role, "doctor");
    assert.equal(report.receipt.status, "completed");
    assert.equal(report.receipt.case.issueNumber, 40);
    assert.ok((await readFile(reportPath!, "utf8")).includes(findingObservation));

    // ② AK-owned run-state ledger reaches terminal for the one-shot real entry.
    const runState = JSON.parse(
      await readFile(
        join(home, ".ak-roles", "books", bookKey, "runs", "run-doctor-settle@doctor", "run-state.json"),
        "utf8",
      ),
    ) as { state: string };
    assert.equal(runState.state, "terminal", "doctor one-shot run must settle run-state terminal");

    // Refused path reuses the same Terminal settlement owner.
    const refusedIo = captureIo();
    const refused = await runAkRole(
      ["doctor", "--issue", "40", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        io: refusedIo.io,
        createRunId: () => "run-doctor-refuse",
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: DOCTOR_OUTPUT_TOOL_NAME,
                isError: false,
                details: {
                  status: "refused",
                  reason: "Need retained sessions",
                  missingEvidence: [
                    { need: "session header", targetKeys: ["case"] },
                  ],
                },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
          };
        },
          }),
      },
    );
    assert.equal(refused.exitCode, 0);
    assert.ok(refused.terminal);
    assert.equal(refused.terminal!.roleOutcome.kind, "accepted");
    assert.equal(
      refused.terminal!.roleOutcome.kind === "accepted"
        ? refused.terminal!.roleOutcome.status
        : undefined,
      "refused",
    );
    assert.equal(
      refused.terminal!.roleOutcome.decisiveFacts.reason,
      "Need retained sessions",
    );

    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-doctor-settle@doctor",
    );
    const admittedSnap = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as {
      issueNumber: number;
      caseRunsPath: string;
      caseIdentity: { issueNumber: number; runsPath: string };
    };
    const settled = await settleDoctorTerminalResult(
      fixtureDoctorAdmitted({
        runId: "run-doctor-settle",
        bookKey,
        projectRoot: project,
        instruction: "inspect",
        instructionEmpty: false,
        runDirectory,
        issueNumber: admittedSnap.issueNumber,
        caseRunsPath: admittedSnap.caseRunsPath,
        caseIdentity: admittedSnap.caseIdentity,
      }),
      piDurablePrincipalAuthority,
    );
    assert.equal(settled.roleOutcome.kind, "accepted");
    assert.equal(
      await trySettleDoctorTerminalResult(
        fixtureDoctorAdmitted({
          runId: "missing",
          bookKey,
          projectRoot: project,
          instruction: "",
          instructionEmpty: true,
          runDirectory: join(runDirectory, "nope"),
          issueNumber: admittedSnap.issueNumber,
          caseRunsPath: admittedSnap.caseRunsPath,
          caseIdentity: admittedSnap.caseIdentity,
        }),
        piDurablePrincipalAuthority,
      ),
      undefined,
    );
  });
});

test("terminal persistence write failure through public entry propagates loudly with no fake terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedIssueRuns(home, bookKey, 41);
    const runId = "run-doctor-terminal-write-fail";
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@doctor`,
    );
    const captured = captureIo();
    const result = await runAkRole(
      ["doctor", "--issue", "41", "--project", project, "inspect"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => runId,
        io: captured.io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const casePath = args[args.indexOf("--ak-doctor-case") + 1]!;
          const patient = await loadDoctorCase(casePath);
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: DOCTOR_OUTPUT_TOOL_NAME,
                isError: false,
                details: sampleCompletedDoctorOutput(patient.identity),
              },
            })}\n`,
            "utf8",
          );
          // Real run-state seam: the facade admitted the run and the
          // coordinator already marked it running; now occupy run-state.json
          // with a directory so markRunTerminal's terminal write fails (EISDIR).
          // No production hook, no direct markRunTerminal call, no new fixture.
          await rm(join(runDirectory, "run-state.json"));
          await mkdir(join(runDirectory, "run-state.json"));
          return {
            code: 0,
            timedOut: false,
            stderr: "",
            args: [...args],
          };
        },
          }),
      },
    );

    // The original terminal-persistence error must propagate loudly and no
    // fake terminal may be presented on stdout. If someone re-adds
    // `.catch(() => undefined)` around the settled-path markRunTerminal, the
    // failure would be swallowed and a terminal presented — this assertion
    // then fails, so the restoration is killed.
    assert.equal(result.exitCode, 1, `expected loud failure, got stdout=${JSON.stringify(captured.stdout)} stderr=${JSON.stringify(captured.stderr)}`);
    assert.equal(result.terminal, undefined, "no terminal may be returned when run-state write fails");
    assert.equal(captured.stdout.join(""), "", "stdout must not present a fake terminal");
  });
});

test("doctor resume is rejected as one-shot", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedIssueRuns(home, bookKey, 5);

    // Create a durable doctor run-state so peek can see the role.
    const admit = await admitDoctorInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      issueNumber: 5,
      createRunId: () => "run-doctor-oneshot",
    });
    await writeFile(
      join(admit.runDirectory, "run-state.json"),
      `${JSON.stringify({
        runId: admit.runId,
        role: "doctor",
        state: "resumable",
        bookKey: admit.bookKey,
        projectRoot: admit.projectRoot,
        sessionDirectory: piDurablePrincipalAuthority.decode(admit.principal).sessionDirectory,
        sessionFile: piDurablePrincipalAuthority.decode(admit.principal).sessionFile,
        runDirectory: admit.runDirectory,
        admittedRequestPath: admit.admittedRequestPath,
      })}\n`,
      "utf8",
    );

    const captured = captureIo();
    const result = await runAkRole(["resume", "run-doctor-oneshot"], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: false },
      io: captured.io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async () => {
        throw new Error("doctor must not resume");
      },
          }),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(captured.stdout.join(""), "");
  });
});
