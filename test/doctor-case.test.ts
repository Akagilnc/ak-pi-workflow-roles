import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDoctorCase } from "../src/doctor-evidence.ts";
import { DoctorEvidenceStore, validateDoctorOutput } from "../src/doctor-contracts.ts";

const rows = [
  { type: "session", version: 3, id: "real-shape", timestamp: "2026-08-01T05:01:18.580Z", cwd: "/repo" },
  { type: "message", timestamp: "2026-08-01T05:01:18.900Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:19.000Z", message: { role: "assistant", responseId: "r1", usage: { output: 7 }, content: [{ type: "toolCall", id: "c1", name: "ak_coder_output", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:20.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "done", commitSha: "abc1234" } } },
];

test("Doctor mission licenses a retained runs case as the subject of a completed cost report", async () => {
  const soul = await (await import("node:fs/promises")).readFile(new URL("../souls/doctor.md", import.meta.url), "utf8");
  assert.match(soul, /保留的单案.*过程成本报告/);
  assert.match(soul, /三问.*开方/);
  assert.doesNotMatch(soul, /案子只是跨案症状证据，不是病人/);
});

test("one retained runs directory yields an independently cited single-case cost report", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-case-"));
  const runs = join(root, ".ak/work/issues/28/runs");
  await mkdir(join(runs, "review-004/session"), { recursive: true });
  await mkdir(join(runs, "review-004-retry"), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(join(runs, "review-004/session/real.jsonl"), body);
  await writeFile(join(runs, "review-004-retry/stderr.log"), "failed before session\n");
  const patient = await loadDoctorCase(runs);
  assert.equal(patient.identity.issueNumber, 28);
  assert.deepEqual(patient.cost.invocations, { count: 2, sources: ["review-004", "review-004-retry"] });
  assert.deepEqual(patient.cost.legs, { count: 1, sources: ["review-004/session/real.jsonl"] });
  assert.equal(patient.cost.modelApiTurns.count, 1);
  assert.equal(patient.cost.outputTokens.count, 7);
  assert.equal(patient.cost.toolCalls.count, 2);
  assert.equal(patient.cost.retries.count, 1);
  assert.equal(patient.cost.statuses[0]?.status, "completed");
  assert.equal(patient.cost.outputBytes.payload, "raw JSONL bytes");
  assert.equal(patient.cost.sessions[0]?.completion, "accepted");
  assert.equal(patient.cost.sessions[0]?.wallMilliseconds, 1420);

  const store = new DoctorEvidenceStore(patient);
  store.read("review-004/session/real.jsonl");
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [] } as const;
  assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, cost: { ...patient.cost, toolCalls: { ...patient.cost.toolCalls, count: 3 } } }, patient, store), /re-derived/);
});

test("runtime-derived metrics permit completion when a case exceeds evidence pagination, but unequal metrics fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-large-case-"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(join(runs, "coder/session"), { recursive: true });
  const padding = "x".repeat(5000);
  const fixture = [...rows, { type: "custom", timestamp: "2026-08-01T05:01:21.000Z", padding }];
  await writeFile(join(runs, "coder/session/large.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const patient = await loadDoctorCase(runs);
  assert.ok(patient.evidence[0]!.content.length > 4096);
  const store = new DoctorEvidenceStore(patient);
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [] } as const;
  assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, cost: { ...patient.cost, outputTokens: { ...patient.cost.outputTokens, count: 8 } } }, patient, store), /re-derived/);
});

test("intermediate object details neither terminate nor manufacture session status", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-endpoint-"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(join(runs, "coder/session"), { recursive: true });
  const fixture = [
    { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "toolResult", toolName: "read", isError: false, details: { status: "completed", commitSha: "badcafe" } } },
    { type: "message", timestamp: "2026-08-01T00:00:04.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "refused", reason: "blocked" } } },
    { type: "message", timestamp: "2026-08-01T00:00:05.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "refused", report: "blocked" } } },
  ];
  await writeFile(join(runs, "coder/session/terminal.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(runs, "coder/session/incomplete.jsonl"), fixture.slice(0, 3).map((row) => JSON.stringify(row)).join("\n") + "\n");
  const patient = await loadDoctorCase(runs);
  const terminal = patient.cost.sessions.find((session) => session.source.endsWith("terminal.jsonl"));
  const incomplete = patient.cost.sessions.find((session) => session.source.endsWith("incomplete.jsonl"));
  assert.deepEqual(terminal && { wall: terminal.wallMilliseconds, completion: terminal.completion }, { wall: 5000, completion: "accepted" });
  assert.deepEqual(incomplete && { wall: incomplete.wallMilliseconds, completion: incomplete.completion }, { wall: 4000, completion: "incomplete" });
  assert.deepEqual(patient.cost.statuses, [{ source: "coder/session/terminal.jsonl", status: "refused" }]);
  assert.deepEqual(patient.cost.commits, []);
});

test("single-case findings enforce actual/no-real-bite and prescription law", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-finding-"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(join(runs, "judge/session"), { recursive: true });
  await writeFile(join(runs, "judge/session/session.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const patient = await loadDoctorCase(runs);
  const evidenceId = "judge/session/session.jsonl";
  const store = new DoctorEvidenceStore(patient);
  store.read(evidenceId);
  const guardrail = { answer: true, evidenceIds: [evidenceId], explanation: "Observed in the retained case" };
  const finding = {
    targetKey: "judge", targetKind: "gate", evidenceIds: [evidenceId], disposition: "keep",
    guardrails: { reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: { ...guardrail, answer: false } },
    prescription: { kind: "retain", recommendation: "Retain the gate" },
    lastRealBite: { kind: "actual", targetKey: "judge", evidenceId },
  } as const;
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [finding] } as const;
  assert.throws(() => validateDoctorOutput(output, patient, store), /single-case cost report cannot assert reusable-asset findings/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, targetKey: "judge", targetKind: "law" }] }, patient, store), /single-case cost report cannot assert reusable-asset findings/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, disposition: "keep", lastRealBite: { kind: "noRealBite", targetKey: "judge", eligibleEvidenceIds: [evidenceId] } }] }, patient, store), /single-case cost report cannot assert reusable-asset findings/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, prescription: { kind: "patch", recommendation: "Patch it" } }] }, patient, store), /single-case cost report cannot assert reusable-asset findings/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, targetKey: "invented-gate", lastRealBite: { ...finding.lastRealBite, targetKey: "invented-gate" } }] }, patient, store), /single-case cost report cannot assert reusable-asset findings/);
  const refusal = { status: "refused", reason: "Need more bytes", missingEvidence: [{ need: "whole case", targetKeys: ["case"] }] } as const;
  assert.deepEqual(validateDoctorOutput(refusal, patient, store), refusal);
  assert.throws(() => validateDoctorOutput({ ...refusal, missingEvidence: [{ need: "unknown", targetKeys: ["invented-gate"] }] }, patient, store), /lawful case target/);
});
