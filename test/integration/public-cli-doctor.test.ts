import { historyPayloads, lockCurrentJson, readCurrentSection, submittedParams, terminalBodyAt } from "../helpers/run-dossier-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "../helpers/role-turn-host-fixture.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
/**
 * #113 public Doctor path — Issue identity + optional confined runs root
 * construct a truthful single-case evidence input; #78 locator remains sole
 * session/content route; completed/refused settle on the common Terminal face.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { statSync } from "node:fs";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { DOCTOR_CANDIDATE_ENTRY_TYPE } from "../../src/dossier-resolution.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import {
  DOCTOR_OUTPUT_TOOL_NAME,
} from "../../src/doctor-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE } from "../../src/public-cli/post-admission.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { payloadStatusSequence, objectPayloads } from "../helpers/terminal-payload.ts";

import {
  admitPublicRole,
} from "../../src/public-cli/invocation.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  doctorSessionRows,
  sampleCompletedDoctorOutput,
  seedDoctorIssueRuns,
} from "../helpers/doctor-fixtures.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-doctor-", scenario);
}

function isUsage(error: unknown): boolean {
  return error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";
}

function admitDoctor(options: {
  readonly principalAuthority: typeof piDurablePrincipalAuthority;
  readonly home: string;
  readonly cwd: string;
  readonly issueNumber: number;
  readonly runs?: string;
  readonly createRunId?: () => string;
}) {
  return admitPublicRole("doctor", {
    issueNumber: options.issueNumber,
    ...(options.runs === undefined ? {} : { runs: options.runs }),
  }, {
    principalAuthority: options.principalAuthority,
    home: options.home,
    cwd: options.cwd,
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
  });
}

test("admitDoctorInvocation builds #78 issue runs case and freezes identity without a second content store", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const seededRuns = await seedDoctorIssueRuns(home, bookKey, 40);
    const expectedPatient = await loadDoctorCase(seededRuns);

    const admitted = await admitDoctor({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      issueNumber: 40,
      createRunId: () => "run-doctor-001",
    });

    assert.deepEqual(
      admitted.role, "doctor");
    assert.equal(admitted.issueNumber, 40);
    assert.equal(admitted.caseRunsPath, await realpath(seededRuns));
    assert.deepEqual(admitted.caseIdentity, expectedPatient.identity);
    assert.equal(
      admitted.runDirectory,
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-doctor-001@doctor"),
    );
    assert.equal(
      piDurablePrincipalAuthority.decode(admitted.principal).sessionFile,
      join(piDurablePrincipalAuthority.decode(admitted.principal).sessionDirectory, "session.jsonl"),
    );

    // Case path is the #78 issue runs locator — not a copied case packet.
    const persisted = readCurrentSection(admitted.runDirectory, "admitted") as {
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
    // Default admit creates canonical <ticket>/runs; no need to pre-seed issues/.
    const emptyIssue = 41;
    const emptyAdmitted = await admitDoctor({
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
        admitDoctor({
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
        admitDoctor({
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
        admitDoctor({
      principalAuthority: piDurablePrincipalAuthority,
          home,
          cwd: project,
          issueNumber: 40,
          runs: ".ak-roles/books/demo-book/issues/99/runs",
          createRunId: () => "run-mismatch",
        }),
      isUsage,
    );

    // Project-relative runs root that matches canonical grammar + issue is admitted
    const localRuns = join(
      project,
      ".ak-roles",
      "books",
      "demo-book",
      "40",
      "runs",
    );
    await mkdir(join(localRuns, "coder", "session"), { recursive: true });
    await writeFile(
      join(localRuns, "coder", "session", "leg.jsonl"),
      `${doctorSessionRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    const admitted = await admitDoctor({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: project,
      issueNumber: 40,
      runs: ".ak-roles/books/demo-book/40/runs",
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

    await runAkRole(["doctor", "--model", "test/caller-seat:high", "--issue", "12", "--project", project, "diagnose retries"],
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
    const result = await runAkRole(["doctor", "--model", "test/caller-seat:high", "--issue", "0", "--project", project],
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
    await runAkRole(["config", "set", "auditor", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const findingObservation = "UNIQUE-DOCTOR-FINDING-OBSERVATION-S2";

    // #836: captured from the same real `loadDoctorCase`/role payload the
    // piRunner uses, so the later outcome.payloads/report.cost assertions check
    // against the actual values rather than hand-authored duplicates.
    let candidateCost: unknown;
    let candidateDetails: unknown;
    const completedIo = captureIo();
    const completed = await runAkRole(["doctor", "--model", "test/caller-seat:high", "--issue", "40", "--project", project, "inspect"],
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
          if (args[args.indexOf("--ak-role") + 1] === "auditor") {
            return scriptedTerminatingToolSession({
              role: "auditor", toolName: AUDITOR_OUTPUT_TOOL_NAME, details: { status: "converged" },
            })(args, options);
          }
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
    assert.deepEqual(payloadStatusSequence(completed.terminal!.roleOutcome), ["completed"]);
    // #757: full receipt passes through — issueNumber stays under case, not lifted.
    const completedCase = (objectPayloads(completed.terminal!.roleOutcome)[0] ?? {}).case as { issueNumber?: number } | undefined;
    assert.equal(completedCase?.issueNumber, 40);
    assert.ok(Array.isArray((objectPayloads(completed.terminal!.roleOutcome)[0] ?? {}).findings));
    assert.equal(((objectPayloads(completed.terminal!.roleOutcome)[0] ?? {}).findings as unknown[]).length, 1);

    const reportPath = completed.terminal!.artifacts.find((a) => a.kind === "report")
      ?.path;
    assert.ok(reportPath);
    const report = terminalBodyAt(reportPath!, "report") as {
      role: string;
      outcome?: { payloads?: unknown };
      cost: unknown;
    };
    assert.equal(report.role, "doctor");
    assert.equal(report.outcome !== undefined && "payloads" in report.outcome, false);
    assert.deepEqual(submittedParams(dirname(reportPath!)), [candidateDetails]);
    // #836: settlement publishes machine cost from the audit candidate entry
    // as an independent report field beside the role's original payload.
    assert.deepEqual(report.cost, candidateCost);

    // ② AK-owned run-state ledger reaches terminal for the real entry.
    const runState = readCurrentSection(
      join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-doctor-settle@doctor"),
      "runState",
    ) as { state: string };
    assert.deepEqual(runState.state, "terminal", "doctor run must settle run-state terminal");

    // Refused path reuses the same Terminal settlement owner.
    const refusedIo = captureIo();
    const refused = await runAkRole(["doctor", "--model", "test/caller-seat:high", "--issue", "40", "--project", project],
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
            piRunner: async (args, options) => {
          if (args[args.indexOf("--ak-role") + 1] === "auditor") {
            return scriptedTerminatingToolSession({
              role: "auditor", toolName: AUDITOR_OUTPUT_TOOL_NAME, details: { status: "converged" },
            })(args, options);
          }
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
            })}\n${JSON.stringify({ type: "custom", customType: DOCTOR_CANDIDATE_ENTRY_TYPE,
              data: { version: 1, testimony: details } })}\n`,
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
    assert.deepEqual(
      refused.terminal!.roleOutcome.kind === "accepted"
        ? payloadStatusSequence(refused.terminal!.roleOutcome)
        : [],
      ["refused"],
    );
    assert.equal(
      (objectPayloads(refused.terminal!.roleOutcome)[0] ?? {}).reason,
      "Need retained sessions",
    );
    const refusedReportPath = refused.terminal!.artifacts.find((a) => a.kind === "report")?.path;
    assert.ok(refusedReportPath);
    const refusedReport = terminalBodyAt(refusedReportPath, "report") as {
      cost?: unknown;
      auditNoReceipt?: unknown;
    };
    assert.equal(refusedReport.cost, undefined);
    assert.equal(refusedReport.auditNoReceipt, undefined);
  });
});

test("Doctor finishes each submission before Auditor review, then resumes only on rejection", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    await seedDoctorIssueRuns(home, bookKey, 42);
    await runAkRole(["config", "set", "auditor", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const runId = "run-doctor-review-loop";
    const replies = ["continue", "converged"] as const;
    let reviewCalls = 0;
    let doctorCalls = 0;
    const auditorHost = roleTurnHostFromLegacyPiRunner({
      packageRoot, principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => scriptedTerminatingToolSession({
        role: "auditor", toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: { status: replies[reviewCalls++] },
      })(args, options),
    });
    const result = await runAkRole(
      ["doctor", "--model", "test/caller-seat:high", "--issue", "42", "--project", project, "review"],
      {
        packageRoot, home, cwd: project, createRunId: () => runId, io: captureIo().io,
        roleTurnHost: createMinimalHost(async (request) => {
          if (request.activation.role === "auditor") {
            const rows = await readRecordedSubmissionRows(project, runId, home);
            assert.equal(rows.filter((row) => row.kind === "accepted").length, reviewCalls + 1);
            return auditorHost.executeTurn(request);
          }
          assert.equal(request.activation.role, "doctor");
          if (doctorCalls > 0) assert.equal(request.continuation.kind, "resume");
          const index = ++doctorCalls;
          const details = {
            status: "refused", reason: `doctor report ${index}`,
            missingEvidence: [{ need: "session", targetKeys: ["case"] }],
          };
          const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(sessionFile, `${JSON.stringify({ type: "custom", customType: DOCTOR_CANDIDATE_ENTRY_TYPE,
            data: { version: 1, testimony: details } })}\n`, "utf8");
          await sealAcceptedSubmission({
            cwd: request.cwd, home, runId, runDirectory: request.runDirectory,
            role: "doctor", details, toolCallId: `doctor-${index}`,
            ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(doctorCalls, 2);
    assert.equal(reviewCalls, 2);
    assert.equal(objectPayloads(result.terminal!.roleOutcome).at(-1)?.reason, "doctor report 2");
    const laterReport = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(laterReport);
    const laterBody = terminalBodyAt(laterReport.path, "report") as {
      cost?: unknown;
      auditNoReceipt?: unknown;
    };
    assert.equal(laterBody.cost, undefined);
    assert.equal(laterBody.auditNoReceipt, undefined);
  });
});

test("Doctor Auditor escalation resumes the officer and settles without Doctor resubmission", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedDoctorIssueRuns(home, resolveBookKeyFromGit(project), 43);
    await runAkRole(["config", "set", "auditor", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const runId = "run-doctor-auditor-escalation";
    let doctorCalls = 0;
    let auditorCalls = 0;
    let auditorRunId: string | undefined;
    const auditorHost = roleTurnHostFromLegacyPiRunner({
      packageRoot, principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => scriptedTerminatingToolSession({
        role: "auditor", toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: { status: auditorCalls++ === 0 ? "escalate" : "converged" },
      })(args, options),
    });
    const host = createMinimalHost(async (request) => {
      if (request.activation.role === "auditor") {
        auditorRunId = runIdFromRunDirectory(request.runDirectory);
        assert.equal((await readRecordedSubmissionRows(project, runId, home)).at(-1)?.kind, "accepted");
        return auditorHost.executeTurn(request);
      }
      doctorCalls++;
      const details = { status: "refused", reason: "recorded once", missingEvidence: [{ need: "session", targetKeys: ["case"] }] };
      const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(sessionFile, `${JSON.stringify({ type: "custom", customType: DOCTOR_CANDIDATE_ENTRY_TYPE,
        data: { version: 1, testimony: details } })}\n`, "utf8");
      await sealAcceptedSubmission({
        cwd: request.cwd, home, runId, runDirectory: request.runDirectory,
        role: "doctor", details, toolCallId: "doctor-only",
        ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    });
    const first = await runAkRole(
      ["doctor", "--model", "test/caller-seat:high", "--issue", "43", "--project", project, "review"],
      { packageRoot, home, cwd: project, createRunId: () => runId, io: captureIo().io, roleTurnHost: host },
    );
    assert.equal(first.exitCode, 0);
    assert.equal(first.terminal?.roleOutcome.role, "auditor");
    assert.ok(auditorRunId);
    const resumed = await runAkRole(
      ["resume", "--model", "test/caller-seat:high", auditorRunId!, "Owner answer"],
      { packageRoot, home, cwd: project, io: captureIo().io, roleTurnHost: host },
    );
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.terminal?.roleOutcome.role, "doctor");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(doctorCalls, 1);
    assert.equal(auditorCalls, 2);
  });
});

test("#1057 Doctor open status escalate still enters mandatory Auditor review", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedDoctorIssueRuns(home, resolveBookKeyFromGit(project), 44);
    await runAkRole(["config", "set", "auditor", "test/caller-seat:high"], {
      packageRoot, home, io: captureIo().io,
    });
    const runId = "run-doctor-open-escalate";
    let auditorCalls = 0;
    let doctorCalls = 0;
    const auditorHost = roleTurnHostFromLegacyPiRunner({
      packageRoot, principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => scriptedTerminatingToolSession({
        role: "auditor", toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: { status: "converged" },
      })(args, options),
    });
    const host = createMinimalHost(async (request) => {
      if (request.activation.role === "auditor") {
        auditorCalls += 1;
        return auditorHost.executeTurn(request);
      }
      doctorCalls += 1;
      // Open-domain escalate is accepted at the tool, then routed back to Doctor
      // before audit; corrected completed|refused continues mandatory auditor.
      const details = doctorCalls === 1
        ? {
          status: "escalate",
          reason: "hallucinated open status",
          missingEvidence: [{ need: "session", targetKeys: ["case"] }],
        }
        : {
          status: "refused",
          reason: "corrected after unreadable status reask",
          missingEvidence: [{ need: "session", targetKeys: ["case"] }],
        };
      if (doctorCalls > 1) assert.equal(request.continuation.kind, "resume");
      const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(sessionFile, `${JSON.stringify({ type: "custom", customType: DOCTOR_CANDIDATE_ENTRY_TYPE,
        data: { version: 1, testimony: details } })}\n`, "utf8");
      await sealAcceptedSubmission({
        cwd: request.cwd, home, runId, runDirectory: request.runDirectory,
        role: "doctor", details, toolCallId: `doctor-open-escalate-${doctorCalls}`,
        ...(request.courtAttemptId === undefined ? {} : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    });
    const result = await runAkRole(
      ["doctor", "--model", "test/caller-seat:high", "--issue", "44", "--project", project, "review"],
      { packageRoot, home, cwd: project, createRunId: () => runId, io: captureIo().io, roleTurnHost: host },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(doctorCalls, 2, "unreadable escalate must re-ask Doctor before audit");
    assert.equal(auditorCalls, 1, "corrected Doctor submission still enters mandatory auditor");
    assert.equal(result.terminal?.roleOutcome.role, "doctor");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      (result.terminal?.roleOutcome.payloads?.at(-1) as { status?: string } | undefined)?.status,
      "refused",
    );
  });
});

/**
 * Real run-state seam: the facade admitted the run and the coordinator already
 * marked it running; once the doctor turn has recorded its submission, occupy
 * current.json (the rendering of the runState fact) with a directory: every later
 * rendering is refused, while the rows (history.jsonl) stay readable and appendable.
 * The accepted doctor terminal stays; the refusals are package notes.
 * No production hook, no direct markRunTerminal call.
 */
function poisonCurrentJsonAfterTurn(runDirectory: string, inner: RoleTurnHost): RoleTurnHost {
  return {
    executeTurn: async (request) => {
      const out = await inner.executeTurn(request);
      if (request.activation.role === "doctor") {
        lockCurrentJson(runDirectory);
      }
      return out;
    },
  };
}

test("terminal rendering failure is noted; the mandatory auditor still reads the recorded facts and the accepted doctor is delivered", async () => {
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
      "unbound", "runs",
      `${runId}@doctor`,
    );
    const captured = captureIo();
    // The accepted Doctor payload is the terminal. The current.json read failure
    // is a note beside it. This run records a real submission (sealedAcceptance)
    // before current.json is occupied. The assertion checks those bytes.
    // Mandatory auditor still runs; the note is not a substitute for that gate.
    await configurePassingReviewSeats(home);
    let recordedDetails: unknown;
    const result = await runAkRole(["doctor", "--model", "test/caller-seat:high", "--issue", "41", "--project", project, "inspect"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: false },
        createRunId: () => runId,
        io: captured.io,
        roleTurnHost: withPassingReviewHost(poisonCurrentJsonAfterTurn(runDirectory, roleTurnHostFromLegacyPiRunner({
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
              type: "custom",
              customType: DOCTOR_CANDIDATE_ENTRY_TYPE,
              data: { version: 1, testimony: details },
            })}\n${JSON.stringify({
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
          }))),
      },
    );

    // #1161: current.json is only a rendering of the rows. Occupying it refuses the
    // run-state and terminal renderings (each a note beside the host terminal) but
    // the facts are rows, so the mandatory auditor reads the run's admitted fact from
    // history.jsonl, passes, and the accepted doctor terminal is delivered.
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.roleOutcome.role, "doctor");
    assert.deepEqual(historyPayloads<{ face?: string }>(runDirectory, "terminal").map((terminal) => terminal.face), ["report"]);
    assert.equal(statSync(join(runDirectory, "current.json")).isDirectory(), true, "the injected refusal really held");
    const noteText = (await readFile(join(runDirectory, "session", "session.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } })
      .find((entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE)
      ?.data?.diagnostic;
    assert.equal(typeof noteText, "string");
    assert.ok((await readRecordedSubmissionRows(project, runId, home)).some((row) => row.kind === "accepted"));
  });
});
