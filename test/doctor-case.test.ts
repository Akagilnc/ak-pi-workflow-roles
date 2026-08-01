import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDoctorCase } from "../src/doctor-evidence.ts";
import { DOCTOR_TARGET_KINDS, DoctorEvidenceStore, validateDoctorOutput } from "../src/doctor-contracts.ts";

const rows = [
  { type: "session", version: 3, id: "real-shape", timestamp: "2026-08-01T05:01:18.580Z", cwd: "/repo" },
  { type: "message", timestamp: "2026-08-01T05:01:18.900Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:19.000Z", message: { role: "assistant", responseId: "r1", usage: { output: 7 }, content: [{ type: "toolCall", id: "c1", name: "ak_coder_output", arguments: {} }] } },
  { type: "message", timestamp: "2026-08-01T05:01:20.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "done", commitSha: "abc1234" } } },
];

test("Doctor mission preserves honest retained-work cost accounting without transport mechanics", async () => {
  const soul = await (await import("node:fs/promises")).readFile(new URL("../souls/doctor.md", import.meta.url), "utf8");
  assert.match(soul, /保留工作.*成本/);
  assert.match(soul, /开方.*(?:工厂|资产)/);
  assert.match(soul, /(?:证据|举证)/);
  assert.match(soul, /(?:区分|不得把)/);
});

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
  assert.deepEqual(patient.cost.commits, [{ source: "review-004/session/real.jsonl", commit: "abc1234" }]);
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
  const evidenceId = patient.evidence[0]!.id;
  store.read(evidenceId, 0, 1);
  assert.equal(store.hasRead(evidenceId), false);
  assert.deepEqual(store.readRecord(), [{ evidenceId, fullyRead: false }]);
  for (let offset = 1; offset < patient.evidence[0]!.content.length; offset += 4096) store.read(evidenceId, offset, 4096);
  assert.equal(store.hasRead(evidenceId), true);
  assert.deepEqual(store.readRecord(), [{ evidenceId, fullyRead: true }]);
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [] } as const;
  assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, cost: { ...patient.cost, outputTokens: { ...patient.cost.outputTokens, count: 8 } } }, patient, store), /re-derived/);
});

test("commit accounting admits only typed commit SHAs from accepted terminating results", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-commits-"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(join(runs, "coder/session"), { recursive: true });
  const fixture = [
    { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "toolResult", toolName: "bash", content: "HEAD is now at badcafe; commit def56789" } },
    { type: "message", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "mentions commit badcafe in free text", commitSha: "abc1234" } } },
  ];
  await writeFile(join(runs, "coder/session/commits.jsonl"), fixture.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const patient = await loadDoctorCase(runs);
  assert.deepEqual(patient.cost.commits, [
    { source: "coder/session/commits.jsonl", commit: "abc1234" },
  ]);
});

test("intermediate object details neither terminate nor manufacture session status", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-endpoint-"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(join(runs, "coder/session"), { recursive: true });
  const fixture = [
    { type: "session", timestamp: "2026-08-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "toolResult", toolName: "read", isError: false, details: { status: "completed", commitSha: "badcafe" } } },
    { type: "message", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "refused", reason: "invalid shape" } } },
    { type: "message", timestamp: "2026-08-01T00:00:04.000Z", message: { role: "toolResult", toolName: "ak_coder_output", isError: false, details: { status: "completed", report: "superseded", commitSha: "abc1234" } } },
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
  assert.deepEqual(patient.cost.commits, [{ source: "coder/session/terminal.jsonl", commit: "abc1234" }]);
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

test("case identity is repository-relative with an absolute fallback outside repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-identity-"));
  await mkdir(join(root, ".git"));
  const runs = join(root, ".ak/work/issues/40/runs");
  await mkdir(runs, { recursive: true });
  assert.equal((await loadDoctorCase(runs)).identity.runsPath, ".ak/work/issues/40/runs");
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
  const output = { status: "completed", case: patient.identity, cost: patient.cost, findings: [finding] } as const;
  assert.deepEqual(validateDoctorOutput(output, patient, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ targetKey: "case", evidenceIds: [evidenceId] }] }, patient, store), /closed contract/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, observation: "" }] }, patient, store), /closed contract/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, disposition: "delete" }] }, patient, store), /closed contract/);
  const assetFinding = {
    targetKey: "judge-output-gate", targetKind: "gate", assetEvidence: { targetKey: "judge-output-gate", targetKind: "gate", evidenceId }, evidenceIds: [evidenceId], disposition: "keep",
    guardrails: { reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: { ...guardrail, answer: false } },
    prescription: { kind: "retain", recommendation: "Retain the gate" },
    lastRealBite: { kind: "actual", targetKey: "judge-output-gate", evidenceId },
  } as const;
  const assetOutput = { ...output, findings: [assetFinding] } as const;
  assert.deepEqual(validateDoctorOutput(assetOutput, patient, store), assetOutput);
  const { assetEvidence: _missing, ...assetWithoutEvidence } = assetFinding;
  assert.throws(() => validateDoctorOutput({ ...output, findings: [assetWithoutEvidence] }, patient, store), /closed contract|typed asset evidence/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...assetFinding, disposition: "keep", lastRealBite: { kind: "noRealBite", targetKey: assetFinding.targetKey, eligibleEvidenceIds: [evidenceId] } }] }, patient, store), /noRealBite permits only thin or delete/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...assetFinding, prescription: { kind: "patch", recommendation: "Patch it" } }] }, patient, store), /necessity explanation/);
  assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, targetKey: "invented-run" }] }, patient, store), /lawful case target/);
  const refusal = { status: "refused", reason: "Need more bytes", missingEvidence: [{ need: "whole case", targetKeys: ["case"] }] } as const;
  assert.deepEqual(validateDoctorOutput(refusal, patient, store), refusal);
  assert.throws(() => validateDoctorOutput({ ...refusal, missingEvidence: [{ need: "unknown", targetKeys: ["invented-gate"] }] }, patient, store), /lawful case target/);
});
