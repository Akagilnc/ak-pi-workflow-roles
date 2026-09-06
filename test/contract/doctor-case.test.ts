import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import { DOCTOR_TARGET_KINDS, DoctorEvidenceStore, DoctorSubmissionContractError, validateDoctorOutput, validateDoctorSubmissionShape } from "../../src/doctor-contracts.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const rows = [
  { type: "session", version: 3, id: "real-shape", timestamp: "2026-08-01T05:01:18.580Z", cwd: "/repo" },
  { type: "message", timestamp: "2026-08-01T05:01:18.900Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:19.000Z", message: { role: "assistant", responseId: "r1", usage: { output: 7 }, content: [{ type: "toolCall", id: "c1", name: "ak_coder_output", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:20.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "done" } } },
];

/** Machine ledger home runs root: `.../.ak-roles/books/<book>/issues/<issue>/runs`. */
function homeRuns(root: string, issue: number, book = "demo-book"): string {
  return join(root, ".ak-roles", "books", book, "issues", String(issue), "runs");
}

test("one retained runs directory yields an independently cited single-case cost report", async () => {
  await withTempRoot("doctor-case-", async (root) => {
    const runs = homeRuns(root, 28);
    await mkdir(join(runs, "review-004/session"), { recursive: true });
    await mkdir(join(runs, "review-004-retry"), { recursive: true });
    const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(join(runs, "review-004/session/real.jsonl"), body);
    await writeFile(join(runs, "review-004-retry/stderr.log"), "failed before session\n");
    await writeFile(join(runs, "review-004/session/stderr.log"), "nested diagnostic, not pre-header invocation evidence\n");
    const patient = await loadDoctorCase(runs);
    assert.deepEqual(patient.evidence.filter((entry) => entry.kind === "stderr").map((entry) => entry.id), ["review-004-retry/stderr.log"]);
    assert.equal(patient.identity.issueNumber, 28);
    assert.deepEqual(patient.cost.invocations, { count: 2, sources: ["review-004", "review-004-retry"] });
    assert.deepEqual(patient.cost.legs, { count: 1, sources: ["review-004/session/real.jsonl"] });
    assert.equal(patient.cost.modelApiTurns.count, 1);
    assert.equal(patient.cost.outputTokens.count, 7);
    assert.equal(patient.cost.toolCalls.count, 2);
    assert.equal(patient.cost.retries.count, 1);
    assert.equal(patient.cost.statuses[0]?.status, "completed");
    assert.deepEqual(patient.cost.commits, []);
    assert.equal(patient.cost.outputBytes.payload, "raw JSONL bytes");
    assert.equal(patient.cost.sessions[0]?.completion, "accepted");
    assert.equal(patient.cost.sessions[0]?.wallMilliseconds, 1420);

    const store = new DoctorEvidenceStore(patient);
    store.read("review-004/session/real.jsonl");
    const output = { status: "completed", case: patient.identity, findings: [] } as const;
    assert.deepEqual(validateDoctorOutput(output, patient, store), output);
    assert.throws(
      () => validateDoctorOutput({ ...output, case: { ...patient.identity, issueNumber: 29 } }, patient, store),
      DoctorSubmissionContractError,
    );
  });
});

test("runtime-derived metrics permit testimony when a case exceeds evidence pagination", async () => {
  await withTempRoot("doctor-large-case-", async (root) => {
    const runs = homeRuns(root, 40);
    await mkdir(join(runs, "coder/session"), { recursive: true });
    const padding = "保留证据".repeat(1250);
    const fixture = [...rows, { type: "custom", timestamp: "2026-08-01T05:01:21.000Z", padding }];
    await writeFile(join(runs, "coder/session/large.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const patient = await loadDoctorCase(runs);
    const entry = patient.evidence[0]!;
    assert.ok(entry.contentLength > 4096);
    assert.equal(entry.contentLength, entry.content.length);
    assert.notEqual(entry.contentLength, entry.byteLength);
    const store = new DoctorEvidenceStore(patient);
    const evidenceId = entry.id;
    for (let offset = 0; offset < entry.contentLength; offset += 4096) {
      const page = store.read(evidenceId, offset, 4096);
      assert.equal(page.contentLength, entry.contentLength);
    }
    assert.equal(store.hasRead(evidenceId), true);
    assert.deepEqual(store.readRecord(), [{ evidenceId, fullyRead: true }]);
    const finding = { targetKey: "case", observation: "Non-ASCII retained evidence was fully read", evidenceIds: [evidenceId] } as const;
    const output = { status: "completed", case: patient.identity, findings: [finding] } as const;
    assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  });
});

// Self-reported commit exclusion, dual fixture (absorbed from two dedicated
// tests): neither Coder free-text SHAs nor Fixer classResults commitSha enter
// cost accounting — one case load carries both rows.
test("commit accounting excludes self-reported commit SHAs from Coder and Fixer legs", async () => {
  await withTempRoot("doctor-commits-", async (root) => {
    const runs = homeRuns(root, 40);

    // Row 1: Coder self-reported SHAs in bash output + report prose.
    await mkdir(join(runs, "coder/session"), { recursive: true });
    const coderFixture = [
      { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
      { type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "toolResult", toolName: "bash", content: "HEAD is now at badcafe; commit def56789" } },
      { type: "message", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "mentions commit badcafe in free text" } } },
    ];
    await writeFile(join(runs, "coder/session/commits.jsonl"), coderFixture.map((row) => JSON.stringify(row)).join("\n") + "\n");

    // Row 2: Fixer classResults commitSha.
    await mkdir(join(runs, "fixer/session"), { recursive: true });
    const fixerFixture = [
      { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
      {
        type: "message",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolName: "ak_fixer_output",
          isError: false,
          details: {
            status: "completed",
            report: "settled one class",
            classResults: [{
              name: "ParserCase",
              disposition: "completed",
              searchScope: "all parser entry points",
              exceptions: [],
              commitSha: "a".repeat(40),
            }],
          },
        },
      },
    ];
    await writeFile(join(runs, "fixer/session/commits.jsonl"), fixerFixture.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const patient = await loadDoctorCase(runs);
    assert.equal(patient.cost.statuses[0]?.status, "completed");
    assert.deepEqual(patient.cost.commits, []);
  });
});

test("intermediate object details neither terminate nor manufacture session status", async () => {
  await withTempRoot("doctor-endpoint-", async (root) => {
    const runs = homeRuns(root, 40);
    await mkdir(join(runs, "coder/session"), { recursive: true });
    const fixture = [
      { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
      { type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "toolResult", toolName: "read", isError: false, details: { status: "completed", commitSha: "badcafe" } } },
      { type: "message", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "refused", reason: "invalid shape" } } },
      { type: "message", timestamp: "2026-08-01T00:00:04.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "superseded" } } },
      { type: "message", timestamp: "2026-08-01T00:00:05.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "refused", report: "final" } } },
    ];
    await writeFile(join(runs, "coder/session/terminal.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(join(runs, "coder/session/incomplete.jsonl"), fixture.slice(0, 3).map((row) => JSON.stringify(row)).join("\n") + "\n");
    const patient = await loadDoctorCase(runs);
    const terminal = patient.cost.sessions.find((session) => session.source.endsWith("terminal.jsonl"));
    const incomplete = patient.cost.sessions.find((session) => session.source.endsWith("incomplete.jsonl"));
    assert.deepEqual(terminal && { wall: terminal.wallMilliseconds, completion: terminal.completion }, { wall: 5000, completion: "accepted" });
    assert.equal(incomplete?.wallMilliseconds, 3000);
    assert.deepEqual(patient.cost.statuses, [
      { source: "coder/session/incomplete.jsonl", status: "refused" },
      { source: "coder/session/terminal.jsonl", status: "refused" },
    ]);
    assert.deepEqual(patient.cost.commits, []);
  });
});

test("timestamp-less terminating results leave the session incomplete at the last retained row", async () => {
  await withTempRoot("doctor-timestampless-terminal-", async (root) => {
    const runs = homeRuns(root, 40);
    await mkdir(join(runs, "coder/session"), { recursive: true });
    const fixture = [
      { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
      { type: "message", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "done" } } },
      { type: "custom", timestamp: "2026-08-01T00:00:04.000Z" },
    ];
    await writeFile(join(runs, "coder/session/timestampless.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const patient = await loadDoctorCase(runs);
    assert.deepEqual(patient.cost.sessions[0], {
      source: "coder/session/timestampless.jsonl",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:04.000Z",
      wallMilliseconds: 4000,
      completion: "incomplete",
    });
  });
});

test("partial and non-monotonic sessions remain reportable with every explicit degradation", async () => {
  await withTempRoot("doctor-degraded-", async (root) => {
    const runs = homeRuns(root, 40);
    await mkdir(join(runs, "crashed/session"), { recursive: true });
    await writeFile(join(runs, "crashed/session/truncated.jsonl"), `${JSON.stringify({ type: "session", timestamp: "2026-08-01T00:00:02.000Z" })}\n{`);
    await writeFile(join(runs, "crashed/session/headerless.jsonl"), `${JSON.stringify({ type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "assistant", responseId: "r" } })}\n`);
    await writeFile(join(runs, "crashed/session/backwards.jsonl"), `${[{ type: "session", timestamp: "2026-08-01T00:00:02.000Z" }, { type: "custom", timestamp: "2026-08-01T00:00:01.000Z" }].map((row) => JSON.stringify(row)).join("\n")}\n{`);
    const patient = await loadDoctorCase(runs);
    assert.equal(patient.cost.sessions.length, 3);
    assert.ok(patient.cost.sessions.every((session) => session.completion === "incomplete" && session.degradationReason));
    const combined = patient.cost.sessions.find((session) => session.source.endsWith("backwards.jsonl"));
    assert.equal(combined?.wallMilliseconds, undefined);
    assert.equal(combined?.completion, "incomplete");
    if (combined?.completion !== "incomplete") assert.fail("combined session must be incomplete");
    assert.match(combined.degradationReason ?? "", /malformed JSON tail/);
    assert.match(combined.degradationReason ?? "", /non-monotonic session timestamps/);
  });
});

test("grok-home native journals are excluded and do not become false incomplete Pi legs", async () => {
  await withTempRoot("doctor-grok-home-", async (root) => {
    const runs = homeRuns(root, 594);
    const runDir = "fixer-apply@roles-594";
    await mkdir(join(runs, runDir, "session"), { recursive: true });
    await mkdir(join(runs, runDir, "grok-home", "sessions", "cwd-encoded", "session-123"), { recursive: true });
    const piBody = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(join(runs, runDir, "session", "session.jsonl"), piBody);
    // Grok native journal shape (no Pi session header) retained under run books (ADR 0077).
    await writeFile(
      join(runs, runDir, "grok-home", "sessions", "cwd-encoded", "session-123", "updates.jsonl"),
      '{"type":"message","text":"grok-native"}\n',
    );
    const patient = await loadDoctorCase(runs);
    assert.deepEqual(patient.cost.legs, { count: 1, sources: [`${runDir}/session/session.jsonl`] });
    assert.equal(patient.cost.sessions.length, 1);
    assert.equal(patient.cost.sessions[0]?.completion, "accepted");
    assert.equal(patient.cost.sessions[0]?.source.includes("grok-home"), false);
    assert.equal(patient.evidence.some((entry) => entry.id.includes("grok-home")), false);
    assert.equal(patient.cost.modelApiTurns.count, 1);
    assert.equal(patient.cost.outputTokens.count, 7);
  });
});

test("case admission rejects runs trees outside the ledger-home path", async () => {
  await withTempRoot("doctor-invalid-path-", async (root) => {
    const runs = join(root, "issues/40/runs");
    await mkdir(runs, { recursive: true });
    await assert.rejects(loadDoctorCase(runs));
  });
});

test("case admission rejects retired .ak/work runs trees", async () => {
  await withTempRoot("doctor-retired-ak-work-", async (root) => {
    const runs = join(root, ".ak/work/issues/40/runs");
    await mkdir(runs, { recursive: true });
    await assert.rejects(loadDoctorCase(runs));
  });
});

test("ledger-home historical and current invocation@source-tree shapes are admitted together", async () => {
  await withTempRoot("doctor-home-shapes-", async (root) => {
    const runs = homeRuns(root, 130, "ak-roles-130");
    const historicalRunDir = "review-004@legacy-worktree";
    const currentRunDir = "coder-apply@ak-roles-130";
    await mkdir(join(runs, historicalRunDir, "session"), { recursive: true });
    await mkdir(join(runs, currentRunDir, "session"), { recursive: true });
    const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(join(runs, historicalRunDir, "session", "retained.jsonl"), body);
    await writeFile(join(runs, currentRunDir, "session", "session.jsonl"), body);
    const patient = await loadDoctorCase(runs);
    assert.equal(patient.identity.issueNumber, 130);
    const historicalLeg = `${historicalRunDir}/session/retained.jsonl`;
    const currentLeg = `${currentRunDir}/session/session.jsonl`;
    assert.deepEqual(patient.cost.invocations.sources, [currentRunDir, historicalRunDir]);
    assert.ok(patient.cost.legs.sources.includes(historicalLeg));
    assert.ok(patient.cost.legs.sources.includes(currentLeg));
    assert.ok(patient.cost.sessions.some((session) => session.source === historicalLeg));
    assert.ok(patient.cost.sessions.some((session) => session.source === currentLeg));
    assert.ok(patient.evidence.some((entry) => entry.id === historicalLeg));
    assert.ok(patient.evidence.some((entry) => entry.id === currentLeg));
    assert.ok(patient.cost.sessions.every((session) => session.completion === "accepted"));
  });
});

test("case identity is repository-relative with an absolute fallback outside repositories", async () => {
  await withTempRoot("doctor-identity-repository-", async (repository) => {
    await mkdir(join(repository, ".git"));
    const repositoryRuns = homeRuns(repository, 40);
    await mkdir(repositoryRuns, { recursive: true });
    assert.equal((await loadDoctorCase(repositoryRuns)).identity.runsPath, ".ak-roles/books/demo-book/issues/40/runs");
  });

  // Absolute-fallback arm must sit truly outside any git worktree. worktreeTempPrefix
  // roots live inside this repo, so stableRunsIdentity would return a relative path.
  // /tmp create-and-abandon: owner 2026-09-06 forbids deleting outside the worktree.
  const outside = await mkdtemp(join("/tmp", "doctor-identity-outside-"));
  const outsideRuns = homeRuns(outside, 40);
  await mkdir(outsideRuns, { recursive: true });
  assert.equal((await loadDoctorCase(outsideRuns)).identity.runsPath, await realpath(outsideRuns));
});

test("case identity discovery propagates unexpected filesystem errors", async () => {
  await withTempRoot("doctor-identity-error-", async (root) => {
    await symlink(".git", join(root, ".git"));
    const runs = homeRuns(root, 40);
    await mkdir(runs, { recursive: true });
    await assert.rejects(loadDoctorCase(runs), (error: NodeJS.ErrnoException) => error.code === "ELOOP");
  });
});

test("single-case findings enforce actual/no-real-bite and prescription law", async () => {
  assert.deepEqual(DOCTOR_TARGET_KINDS, ["law", "gate", "template", "station", "seat"]);
  await withTempRoot("doctor-finding-", async (root) => {
    const runs = homeRuns(root, 40);
    await mkdir(join(runs, "judge/session"), { recursive: true });
    await writeFile(join(runs, "judge/session/session.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const patient = await loadDoctorCase(runs);
    const evidenceId = "judge/session/session.jsonl";
    const store = new DoctorEvidenceStore(patient);
    store.read(evidenceId);
    const guardrail = { answer: true, evidenceIds: [evidenceId], explanation: "Observed in the retained case" };
    const finding = { targetKey: "case", observation: "The retained case used two tool calls", evidenceIds: [evidenceId] } as const;
    const output = { status: "completed", case: patient.identity, findings: [finding] } as const;
    assert.deepEqual(validateDoctorOutput(output, patient, store), output);
    const assetFinding = {
      targetKey: "judge-output-gate", targetKind: "gate", assetEvidence: { targetKey: "judge-output-gate", targetKind: "gate", evidenceId }, evidenceIds: [evidenceId], disposition: "keep",
      guardrails: { reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: { ...guardrail, answer: false } },
      prescription: { kind: "retain", recommendation: "Retain the gate" },
      lastRealBite: { kind: "actual", targetKey: "judge-output-gate", evidenceId },
    } as const;
    const assetOutput = { ...output, findings: [assetFinding] } as const;
    assert.deepEqual(validateDoctorOutput(assetOutput, patient, store), assetOutput);
    const emptyAsset = { ...assetOutput, findings: [{ ...assetFinding, assetEvidence: {} }] };
    assert.deepEqual(validateDoctorOutput(emptyAsset, patient, store), emptyAsset);
    assert.throws(
      () => validateDoctorOutput({ ...assetOutput, findings: [{ ...assetFinding, assetEvidence: { targetKey: "case" } }] }, patient, store),
      DoctorSubmissionContractError,
    );
    assert.throws(
      () => validateDoctorOutput({ ...assetOutput, findings: [{ ...assetFinding, assetEvidence: { targetKind: "law" } }] }, patient, store),
      DoctorSubmissionContractError,
    );
    assert.throws(
      () => validateDoctorOutput({ ...assetOutput, findings: [{ ...assetFinding, assetEvidence: { evidenceId: "unknown" } }] }, patient, store),
      DoctorSubmissionContractError,
    );
    assert.throws(
      () => validateDoctorOutput({ ...assetOutput, findings: [{ ...assetFinding, assetEvidence: { evidenceId } }] }, patient, new DoctorEvidenceStore(patient)),
      DoctorSubmissionContractError,
    );
    const noRealBiteKeep = { ...output, findings: [{ ...assetFinding, disposition: "keep", lastRealBite: { kind: "noRealBite", targetKey: assetFinding.targetKey, eligibleEvidenceIds: [evidenceId] } }] } as const;
    assert.deepEqual(validateDoctorOutput(noRealBiteKeep, patient, store), noRealBiteKeep);
    const unexplainedPatch = { ...output, findings: [{ ...assetFinding, prescription: { kind: "patch", recommendation: "Patch it" } }] } as const;
    assert.deepEqual(validateDoctorOutput(unexplainedPatch, patient, store), unexplainedPatch);
    assert.throws(
      () => validateDoctorOutput({ ...output, findings: [{ ...finding, targetKey: "invented-run" }] }, patient, store),
      DoctorSubmissionContractError,
    );
    const refusal = { status: "refused", reason: "Need more bytes", missingEvidence: [{ need: "whole case", targetKeys: ["case"] }] } as const;
    assert.deepEqual(validateDoctorOutput(refusal, patient, store), refusal);
    assert.throws(
      () => validateDoctorOutput({ ...refusal, missingEvidence: [{ need: "unknown", targetKeys: ["invented-gate"] }] }, patient, store),
      DoctorSubmissionContractError,
    );
  });
});

test("Doctor submission accepts unknown guardrail keys and safely rejects unrecognized execution intent", () => {
  const guardrail = { answer: true, evidenceIds: ["e1"], explanation: "observed" };
  const baseFinding = {
    targetKey: "judge-output-gate",
    targetKind: "gate" as const,
    assetEvidence: { targetKey: "judge-output-gate", targetKind: "gate" as const, evidenceId: "e1" },
    evidenceIds: ["e1"],
    disposition: "keep" as const,
    prescription: { kind: "retain" as const, recommendation: "Retain the gate" },
    lastRealBite: { kind: "actual" as const, targetKey: "judge-output-gate", evidenceId: "e1" },
  };
  const withUnknown = {
    status: "completed" as const,
    case: { issueNumber: 40, runsPath: ".ak/work/issues/40/runs" },
    findings: [{
      ...baseFinding,
      guardrails: {
        reproducibleFailure: guardrail,
        owningSeamOrInvariant: guardrail,
        deletionOrSimplificationSuffices: { ...guardrail, answer: false },
        narrativeNote: "human-facing only",
      },
    }],
  };
  assert.deepEqual(validateDoctorSubmissionShape(withUnknown), withUnknown);

  for (const candidate of [undefined, null, 1, new Proxy({}, { get() { throw new Error("getter"); } })]) {
    assert.throws(() => validateDoctorSubmissionShape(candidate), DoctorSubmissionContractError);
  }
});
