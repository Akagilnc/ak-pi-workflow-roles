import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDoctorCase } from "../../src/doctor-evidence.ts";
import { DOCTOR_TARGET_KINDS, DoctorEvidenceStore, validateDoctorOutput } from "../../src/doctor-contracts.ts";

const rows = [
  { type: "session", version: 3, id: "real-shape", timestamp: "2026-08-01T05:01:18.580Z", cwd: "/repo" },
  { type: "message", timestamp: "2026-08-01T05:01:18.900Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:19.000Z", message: { role: "assistant", responseId: "r1", usage: { output: 7 }, content: [{ type: "toolCall", id: "c1", name: "ak_coder_output", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:20.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "done" } } },
];

test("one retained runs directory yields an independently cited single-case cost report", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-case-"));
  const runs = join(root, ".ak/work/issues/28/runs");
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
  assert.throws(() => validateDoctorOutput({ ...output, presentation: "human-only" }, patient, store), /contract/);
  assert.throws(() => validateDoctorOutput({ ...output, case: { ...patient.identity, issueNumber: 29 } }, patient, store), /activated case identity/);
});

test("runtime-derived metrics permit testimony when a case exceeds evidence pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-large-case-"));
  const runs = join(root, ".ak/work/issues/40/runs");
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

test("commit accounting excludes Coder self-reported commit SHAs", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-commits-"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(join(runs, "coder/session"), { recursive: true });
  const fixture = [
    { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "toolResult", toolName: "bash", content: "HEAD is now at badcafe; commit def56789" } },
    { type: "message", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "mentions commit badcafe in free text" } } },
  ];
  await writeFile(join(runs, "coder/session/commits.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const patient = await loadDoctorCase(runs);
  assert.deepEqual(patient.cost.commits, []);
});

test("intermediate object details neither terminate nor manufacture session status", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-endpoint-"));
  const runs = join(root, ".ak/work/issues/40/runs");
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
  assert.deepEqual(incomplete && { wall: incomplete.wallMilliseconds, completion: incomplete.completion }, { wall: 3000, completion: "incomplete" });
  assert.deepEqual(patient.cost.statuses, [{ source: "coder/session/terminal.jsonl", status: "refused" }]);
  assert.deepEqual(patient.cost.commits, []);
});

test("timestamp-less terminating results leave the session incomplete at the last retained row", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-timestampless-terminal-"));
  const runs = join(root, ".ak/work/issues/40/runs");
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

test("partial and non-monotonic sessions remain reportable with every explicit degradation", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-degraded-"));
  const runs = join(root, ".ak/work/issues/40/runs");
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

test("case admission rejects runs trees outside the ADR 0017 path", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-invalid-path-"));
  const runs = join(root, "issues/40/runs");
  await mkdir(runs, { recursive: true });
  await assert.rejects(loadDoctorCase(runs), /\.ak\/work\/issues\/<n>\/runs/);
});

test("case identity is repository-relative with an absolute fallback outside repositories", async () => {
  const repository = await mkdtemp(join(tmpdir(), "doctor-identity-repository-"));
  await mkdir(join(repository, ".git"));
  const repositoryRuns = join(repository, ".ak/work/issues/40/runs");
  await mkdir(repositoryRuns, { recursive: true });
  assert.equal((await loadDoctorCase(repositoryRuns)).identity.runsPath, ".ak/work/issues/40/runs");

  const outside = await mkdtemp(join(tmpdir(), "doctor-identity-outside-"));
  const outsideRuns = join(outside, ".ak/work/issues/40/runs");
  await mkdir(outsideRuns, { recursive: true });
  assert.equal((await loadDoctorCase(outsideRuns)).identity.runsPath, await realpath(outsideRuns));
});

test("case identity discovery propagates unexpected filesystem errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-identity-error-"));
  await symlink(".git", join(root, ".git"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(runs, { recursive: true });
  await assert.rejects(loadDoctorCase(runs), (error: NodeJS.ErrnoException) => error.code === "ELOOP");
});

test("single-case findings enforce actual/no-real-bite and prescription law", async () => {
  assert.deepEqual(DOCTOR_TARGET_KINDS, ["law", "gate", "template", "station", "seat"]);
  const root = await mkdtemp(join(tmpdir(), "doctor-finding-"));
  const runs = join(root, ".ak/work/issues/40/runs");
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
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ targetKey: "case", evidenceIds: [evidenceId] }] }, patient, store), /contract/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, observation: "" }] }, patient, store), /contract/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, disposition: "delete" }] }, patient, store), /contract/);
  const assetFinding = {
    targetKey: "judge-output-gate", targetKind: "gate", assetEvidence: { targetKey: "judge-output-gate", targetKind: "gate", evidenceId }, evidenceIds: [evidenceId], disposition: "keep",
    guardrails: { reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: { ...guardrail, answer: false } },
    prescription: { kind: "retain", recommendation: "Retain the gate" },
    lastRealBite: { kind: "actual", targetKey: "judge-output-gate", evidenceId },
  } as const;
  const assetOutput = { ...output, findings: [assetFinding] } as const;
  assert.deepEqual(validateDoctorOutput(assetOutput, patient, store), assetOutput);
  const { assetEvidence: _missing, ...assetWithoutEvidence } = assetFinding;
  assert.throws(() => validateDoctorOutput({ ...output, findings: [assetWithoutEvidence] }, patient, store), /contract|typed asset evidence/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...assetFinding, disposition: "keep", lastRealBite: { kind: "noRealBite", targetKey: assetFinding.targetKey, eligibleEvidenceIds: [evidenceId] } }] }, patient, store), /noRealBite permits only thin or delete/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...assetFinding, prescription: { kind: "patch", recommendation: "Patch it" } }] }, patient, store), /necessity explanation/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, targetKey: "invented-run" }] }, patient, store), /lawful case target/);
  const refusal = { status: "refused", reason: "Need more bytes", missingEvidence: [{ need: "whole case", targetKeys: ["case"] }] } as const;
  assert.deepEqual(validateDoctorOutput(refusal, patient, store), refusal);
  assert.throws(() => validateDoctorOutput({ ...refusal, missingEvidence: [{ need: "unknown", targetKeys: ["invented-gate"] }] }, patient, store), /lawful case target/);
});
