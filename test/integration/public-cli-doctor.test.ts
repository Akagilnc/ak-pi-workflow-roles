import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixtureDoctorAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #113 public Doctor path — Issue identity + optional confined runs root
 * construct a truthful single-case evidence input; #78 locator remains sole
 * session/content route; completed/refused settle on the common Terminal face.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { DOCTOR_CANDIDATE_ENTRY_TYPE } from "../../src/dossier-resolution.ts";
import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
} from "../../src/doctor-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { payloadFacts, payloadStatus } from "../helpers/terminal-payload.ts";

import {
  admitDoctorInvocation,
} from "../../src/public-cli/invocation.ts";
import {
  settleDoctorTerminalResult,
  trySettleDoctorTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  doctorSessionRows,
  sampleCompletedDoctorOutput,
  seedDoctorIssueRuns,
} from "../helpers/doctor-fixtures.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { assertPublicFailureSettlement } from "../helpers/failure-settlement-kit.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-doctor-", scenario);
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

test("admitDoctorInvocation builds #78 issue runs case and freezes identity without a second content store", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const seededRuns = await seedDoctorIssueRuns(home, bookKey, 40);
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
    await seedDoctorIssueRuns(home, bookKey, 40);

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
      `${doctorSessionRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
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
    await seedDoctorIssueRuns(home, bookKey, 12);

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
    await seedDoctorIssueRuns(home, bookKey, 40);
    const findingObservation = "UNIQUE-DOCTOR-FINDING-OBSERVATION-S2";

    // #836: captured from the same real `loadDoctorCase`/role payload the
    // piRunner uses, so the later outcome.payloads/report.cost assertions check
    // against the actual values rather than hand-authored duplicates.
    let candidateCost: unknown;
    let candidateDetails: unknown;
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
          candidateCost = patient.cost;
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(join(sessionFile, ".."), { recursive: true });
          const details = sampleCompletedDoctorOutput(patient.identity, findingObservation);
          candidateDetails = details;
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: DOCTOR_OUTPUT_TOOL_NAME,
                isError: false,
                details,
              },
            })}\n${JSON.stringify({
              // #836: the audit candidate entry carries runtime cost beside
              // (never merged into) the role's testimony — settlement reads
              // it from here to publish the independent report.cost field.
              type: "custom",
              customType: DOCTOR_CANDIDATE_ENTRY_TYPE,
              data: { version: 1, testimony: details, cost: patient.cost },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            sealedAcceptance: { role: "doctor" as const, details },
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
    assert.equal(payloadStatus(completed.terminal!.roleOutcome), "completed");
    // #757: full receipt passes through — issueNumber stays under case, not lifted.
    const completedCase = payloadFacts(completed.terminal!.roleOutcome).case as { issueNumber?: number } | undefined;
    assert.equal(completedCase?.issueNumber, 40);
    assert.ok(Array.isArray(payloadFacts(completed.terminal!.roleOutcome).findings));
    assert.equal((payloadFacts(completed.terminal!.roleOutcome).findings as unknown[]).length, 1);
    assert.match(completedIo.stdout.join(""), /doctor/);

    const reportPath = completed.terminal!.artifacts.find((a) => a.kind === "report")
      ?.path;
    assert.ok(reportPath);
    const report = JSON.parse(await readFile(reportPath!, "utf8")) as {
      role: string;
      outcome?: { payloads?: unknown };
      cost: unknown;
    };
    assert.equal(report.role, "doctor");
    assert.deepEqual(report.outcome?.payloads, [candidateDetails]);
    // #836: settlement.ts extractDoctorCandidateCostFact/publishDoctorArtifacts
    // must read the audit candidate entry and publish machine cost as an
    // independent report field beside — not merged into — the role's original
    // payload sequence.
    assert.deepEqual(report.cost, candidateCost);
    assert.ok((await readFile(reportPath!, "utf8")).includes(findingObservation));

    // ② AK-owned run-state ledger reaches terminal for the real entry.
    const runState = JSON.parse(
      await readFile(
        join(home, ".ak-roles", "books", bookKey, "runs", "run-doctor-settle@doctor", "run-state.json"),
        "utf8",
      ),
    ) as { state: string };
    assert.equal(runState.state, "terminal", "doctor run must settle run-state terminal");

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
          const details = {
            status: "refused",
            reason: "Need retained sessions",
            missingEvidence: [
              { need: "session header", targetKeys: ["case"] },
            ],
          };
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: DOCTOR_OUTPUT_TOOL_NAME,
                isError: false,
                details,
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            sealedAcceptance: { role: "doctor" as const, details },
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
        ? payloadStatus(refused.terminal!.roleOutcome)
        : undefined,
      "refused",
    );
    assert.equal(
      payloadFacts(refused.terminal!.roleOutcome).reason,
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

    // #836: extractDoctorCandidateCostFact/extractDoctorCandidateAuditNoReceiptFact
    // must bound their scan to the current attempt (currentAttemptStartIndex),
    // the same bound already used elsewhere in settlement.ts for other
    // attempt-sensitive scans — a later attempt with no candidate entry of
    // its own must not inherit the prior attempt's cost/auditNoReceipt.
    const settleSessionFile = join(runDirectory, "session", "session.jsonl");
    await appendFile(
      settleSessionFile,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "resume" },
      })}\n${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: DOCTOR_OUTPUT_TOOL_NAME,
          isError: false,
          details: candidateDetails,
        },
      })}\n`,
      "utf8",
    );
    const settledNextAttempt = await settleDoctorTerminalResult(
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
    assert.equal(settledNextAttempt.roleOutcome.kind, "accepted");
    const reportPathNextAttempt = settledNextAttempt.artifacts.find((a) => a.kind === "report")?.path;
    assert.ok(reportPathNextAttempt);
    const reportNextAttempt = JSON.parse(
      await readFile(reportPathNextAttempt!, "utf8"),
    ) as { cost: unknown; auditNoReceipt: unknown };
    assert.equal(
      reportNextAttempt.cost,
      undefined,
      "#836: a prior attempt's candidate cost must not leak into a later attempt lacking its own candidate entry",
    );
    assert.equal(
      reportNextAttempt.auditNoReceipt,
      undefined,
      "#836: a prior attempt's auditNoReceipt must not leak into a later attempt lacking its own candidate entry",
    );

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

test("terminal persistence failure through public entry propagates loudly with no fake terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedDoctorIssueRuns(home, bookKey, 41);
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
    // #836 A.3 (class 2, r9 bounce): the accepted Doctor payload must ride
    // beside the persistence failure, not just a bare failure Terminal —
    // so this run must actually record a submission (sealedAcceptance, same
    // producer the "completed" tracer above uses) before the run-state write
    // is broken. Captured here so the assertion below checks against the
    // real recorded bytes, not a hand-authored duplicate.
    let recordedDetails: unknown;
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
          const details = sampleCompletedDoctorOutput(patient.identity);
          recordedDetails = details;
          await writeFile(
            sessionFile,
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: DOCTOR_OUTPUT_TOOL_NAME,
                isError: false,
                details,
              },
            })}\n`,
            "utf8",
          );
          // Real run-state seam: the facade admitted the run and the
          // coordinator already marked it running; now occupy run-state.json
          // with a directory. markRunTerminal reads current run-state before
          // it writes, so this actually fails that precondition read
          // (readFile → EISDIR) inside readRoleRunStateDisk — not the later
          // write step. The real EISDIR identity must propagate through, not
          // get relabeled a synthetic "run state missing".
          // No production hook, no direct markRunTerminal call, no new fixture.
          await rm(join(runDirectory, "run-state.json"));
          await mkdir(join(runDirectory, "run-state.json"));
          return {
            code: 0,
            sealedAcceptance: { role: "doctor" as const, details },
            timedOut: false,
            stderr: "",
            args: [...args],
          };
        },
          }),
      },
    );

    // #836: the original terminal-persistence error must propagate loudly as
    // a real controlled-failure Terminal, carrying its own real EISDIR
    // identity — never silently swallowed, never relabeled a synthetic
    // "run state missing", and never an escaped exception that reaches
    // auto-resume with no recorded Terminal at all. Reuses the shared
    // public-failure-settlement contract (same assertions every other seam's
    // real-persistence-failure case uses). Asserted on the portable
    // structured identity (code) rather than a hand-authored diagnostic
    // string, since the exact Node error message is not a stable contract.
    const { terminal } = await assertPublicFailureSettlement({
      result,
      stdout: captured.stdout,
      stderr: captured.stderr,
      diagnosticIncludes: "EISDIR",
      identityCode: "EISDIR",
    });
    assert.equal(terminal.roleOutcome.role, "doctor");
    // #836 A.3: the already-recorded Doctor payload rides beside the real
    // persistence failure — never dropped by the controlled-failure path.
    assert.deepEqual(terminal.submissions, [recordedDetails]);
    if (terminal.roleOutcome.kind === "failure") {
      assert.deepEqual(terminal.roleOutcome.payloads, [recordedDetails]);
    }
  });
});
