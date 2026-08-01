import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDoctorCase } from "../src/doctor-evidence.ts";
import { DoctorEvidenceStore, validateDoctorOutput } from "../src/doctor-contracts.ts";

const rows = [
  { type: "session", version: 3, id: "real-shape", timestamp: "2026-08-01T05:01:18.580Z", cwd: "/repo" },
  { type: "message", timestamp: "2026-08-01T05:01:19.000Z", message: { role: "assistant", responseId: "r1", usage: { output: 7 }, content: [{ type: "toolCall", id: "c1", name: "ak_judge_output", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:20.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "ak_judge_output", isError: false, details: { judgeStatus: "converged", commitSha: "abc1234" } } },
];

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
  assert.equal(patient.cost.toolCalls.count, 1);
  assert.equal(patient.cost.retries.count, 1);
  assert.equal(patient.cost.statuses[0]?.status, "converged");
  assert.equal(patient.cost.outputBytes.payload, "raw JSONL bytes");
  assert.equal(patient.cost.sessions[0]?.completion, "accepted");
  assert.equal(patient.cost.sessions[0]?.wallMilliseconds, 1420);

  const store = new DoctorEvidenceStore(patient);
  store.read("review-004/session/real.jsonl");
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [] } as const;
  assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, cost: { ...patient.cost, toolCalls: { ...patient.cost.toolCalls, count: 2 } } }, patient, store), /re-derived/);
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
    targetKey: "judge-output", targetKind: "gate", evidenceIds: [evidenceId], disposition: "keep",
    guardrails: { reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: { ...guardrail, answer: false } },
    prescription: { kind: "retain", recommendation: "Retain the gate" },
    lastRealBite: { kind: "actual", targetKey: "judge-output", evidenceId },
  } as const;
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [finding] } as const;
  assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, disposition: "keep", lastRealBite: { kind: "noRealBite", targetKey: "judge-output", eligibleEvidenceIds: [evidenceId] } }] }, patient, store), /noRealBite permits only thin or delete/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, prescription: { kind: "patch", recommendation: "Patch it" } }] }, patient, store), /necessity explanation/);
});
