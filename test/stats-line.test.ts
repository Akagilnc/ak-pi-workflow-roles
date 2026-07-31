import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../src/sha256.ts";
import { produceStatsLineV1, validateStatsLineV1, type CommittedSnapshot } from "../src/stats-line.ts";

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fixture(role: string, phase: string | undefined, id: string, details: unknown) {
  const receipt = enc({ toolName: `ak_${role}_output`, toolCallId: id, details, artifactKind: "acceptedReceipt" });
  const args = ["pi", "--ak-role", role, ...(phase ? [`--ak-${role}-phase`, phase] : [])];
  const manifest = enc({ version: 2, archive: { repositoryRoot: "/repo", root: ".ak/dockets", docketId: `issues/7/${id}` }, invocation: { id }, session: { id, directory: `.ak/work/${id}`, basename: "session.jsonl", sha256: "a".repeat(64), byteLength: 1, retention: "caller-owned-raw-not-promoted" }, execution: { argv: args, cwd: "/repo", environment: { inherit: true, overrides: {}, unset: [] }, stdin: "inherit", stdio: { stdout: "pass-through", stderr: "pass-through", diagnosticTailBytes: 4096 } }, provenance: { package: null, model: null, target: null, verification: "unverified" }, artifacts: [{ id: "receipt", kind: "receipt", redactionStatus: "clean", stored: { identity: "stored", path: "receipt.json", sha256: sha256Hex(receipt), byteLength: receipt.byteLength }, receiptArtifactKind: "acceptedReceipt" }], receipt: { toolName: `ak_${role}_output`, toolCallId: id, artifactId: "receipt", artifactKind: "acceptedReceipt" }, auditObservation: null, child: { status: "exited", exitCode: 0, signal: null }, recorder: { status: "completed" }, redaction: { hits: [] } });
  return { manifest, receipt };
}
function snapshot(files: Record<string, Uint8Array>, order = Object.keys(files)): CommittedSnapshot { return { repository: "ak/repo", targetCommit: "1".repeat(40), async list() { return order; }, async read(path) { const bytes = files[path]; if (!bytes) throw new Error(`missing ${path}`); return bytes; } }; }

test("StatsLine deterministically classifies exact roles/phases and preserves typed unavailable observations", async () => {
  const judge = fixture("judge", undefined, "judge-id", { judgeStatus: "continue", fix: { summary: "Repair the gate." }, classes: [{ name: "Gate", owner: "gate", boundary: "factory gate", disposition: "repair" }] });
  const coder = fixture("coder", "apply", "coder-id", { status: "completed", report: "done" });
  const doctor = fixture("doctor", undefined, "doctor-id", { status: "refused", reason: "No admitted trend population.", missingEvidence: [{ need: "two StatsLines", targetKeys: ["gate"] }] });
  const files = { ".ak/dockets/issues/7/z/manifest.json": judge.manifest, ".ak/dockets/issues/7/z/receipt.json": judge.receipt, ".ak/dockets/issues/7/a/manifest.json": coder.manifest, ".ak/dockets/issues/7/a/receipt.json": coder.receipt, ".ak/dockets/issues/7/m/manifest.json": doctor.manifest, ".ak/dockets/issues/7/m/receipt.json": doctor.receipt };
  const first = await produceStatsLineV1({ snapshot: snapshot(files, Object.keys(files).reverse()), issueNumber: 7 });
  const second = await produceStatsLineV1({ snapshot: snapshot(files), issueNumber: 7 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.source.manifests.map((item) => item.path), [".ak/dockets/issues/7/a/manifest.json", ".ak/dockets/issues/7/m/manifest.json", ".ak/dockets/issues/7/z/manifest.json"]);
  assert.deepEqual(first.recordedInvocations, { status: "measured", value: { total: 3, byRole: { judge: 1, fixer: 0, coder: 1, reviewer: 0, collector: 0, doctor: 1 }, unclassified: 0 } });
  assert.deepEqual(first.judgeContinueCount, { status: "measured", value: 1 });
  assert.deepEqual(first.auditRejectionCount, { status: "unavailable", reason: "recorder-records-only-accepted-audits" });
  assert.deepEqual(first.recordedInvocationWindow, { status: "unavailable", reason: "recorder-does-not-record-invocation-timestamps" });
  assert.equal(first.paperApplyBytes.status, "measured");
  if (first.paperApplyBytes.status === "measured") assert.deepEqual(first.paperApplyBytes.value.ratio, { status: "measured", value: { numerator: judge.receipt.byteLength + doctor.receipt.byteLength, denominator: coder.receipt.byteLength } });
});

test("StatsLine applies the exact receipt-byte complement law", async () => {
  const cases: Array<{ name: string; argv: string[]; bucket: "paper" | "apply" | "unclassified" }> = [
    ...["judge", "reviewer", "collector", "doctor"].map((role) => ({ name: role, argv: ["pi", "--ak-role", role, "--ak-coder-phase", "apply"], bucket: "paper" as const })),
    { name: "coder apply", argv: ["pi", "--ak-role", "coder", "--ak-coder-phase", "apply", "--ak-fixer-phase", "plan"], bucket: "apply" },
    { name: "fixer apply", argv: ["pi", "--ak-role", "fixer", "--ak-fixer-phase", "apply", "--ak-coder-phase", "plan"], bucket: "apply" },
    ...["plan", "", "future"].map((phase) => ({ name: `coder ${phase || "empty"}`, argv: ["pi", "--ak-role", "coder", "--ak-coder-phase", phase], bucket: "paper" as const })),
    { name: "coder missing phase", argv: ["pi", "--ak-role", "coder"], bucket: "paper" },
    { name: "coder duplicate apply", argv: ["pi", "--ak-role", "coder", "--ak-coder-phase", "apply", "--ak-coder-phase", "apply"], bucket: "paper" },
    { name: "fixer duplicate phase", argv: ["pi", "--ak-role", "fixer", "--ak-fixer-phase", "plan", "--ak-fixer-phase", "apply"], bucket: "paper" },
    { name: "missing role", argv: ["pi"], bucket: "unclassified" },
    { name: "empty role", argv: ["pi", "--ak-role", ""], bucket: "unclassified" },
    { name: "unknown role", argv: ["pi", "--ak-role", "future"], bucket: "unclassified" },
    { name: "duplicate role", argv: ["pi", "--ak-role", "judge", "--ak-role", "doctor"], bucket: "unclassified" },
  ];
  for (const item of cases) {
    const archived = fixture("judge", undefined, item.name, { judgeStatus: "converged" });
    const manifest = JSON.parse(new TextDecoder().decode(archived.manifest));
    manifest.execution.argv = item.argv;
    const files = { ".ak/dockets/issues/7/a/manifest.json": enc(manifest), ".ak/dockets/issues/7/a/receipt.json": archived.receipt };
    const result = await produceStatsLineV1({ snapshot: snapshot(files), issueNumber: 7 });
    assert.equal(result.paperApplyBytes.status, "measured", item.name);
    if (result.paperApplyBytes.status !== "measured") continue;
    const { paperBytes, applyBytes, ratio } = result.paperApplyBytes.value;
    assert.equal(paperBytes + applyBytes, item.bucket === "unclassified" ? 0 : archived.receipt.byteLength, `${item.name} byte conservation`);
    assert.equal(paperBytes, item.bucket === "paper" ? archived.receipt.byteLength : 0, item.name);
    assert.equal(applyBytes, item.bucket === "apply" ? archived.receipt.byteLength : 0, item.name);
    if (item.bucket === "unclassified") assert.deepEqual(ratio, { status: "unavailable", reason: "unclassifiable-receipt" }, item.name);
    else if (item.bucket === "paper") assert.deepEqual(ratio, { status: "unavailable", reason: "no-apply-receipts" }, item.name);
    else assert.deepEqual(ratio, { status: "measured", value: { numerator: 0, denominator: archived.receipt.byteLength } }, item.name);
  }
});

test("StatsLine closes every measured payload, unavailable reason, and cross-metric invariant", async () => {
  const valid = await produceStatsLineV1({ snapshot: snapshot({}), issueNumber: 7, tracker: { repository: "ak/repo", issueNumber: 7, issueOpenedAt: "2026-01-01T00:00:00.000Z", pullRequest: { repository: "ak/repo", number: 19, issueNumber: 7, mergedAt: "2026-01-02T00:00:00.000Z", base: { name: "main", isDefault: true } } } });
  const clone = () => structuredClone(valid) as any;
  const invalid: Array<[string, (line: any) => void]> = [
    ["wrong scalar type", line => { line.judgeContinueCount.value = "0"; }],
    ["negative count", line => { line.judgeContinueCount.value = -1; }],
    ["fractional count", line => { line.auditRejectionCount = { status: "measured", value: 0.5 }; }],
    ["unsafe byte count", line => { line.paperApplyBytes.value.paperBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ["nested extra key", line => { line.paperApplyBytes.value.extra = true; }],
    ["wrong metric reason", line => { line.recordedInvocationWindow = { status: "unavailable", reason: "tracker-metadata-invalid" }; }],
    ["unordered window", line => { line.recordedInvocationWindow = { status: "measured", value: { first: "2026-01-02T00:00:00Z", last: "2026-01-01T00:00:00Z" } }; }],
    ["invalid timestamp", line => { line.issueToDefaultMerge.value.mergedAt = "tomorrow"; }],
    ["inexact merge milliseconds", line => { line.issueToDefaultMerge.value.milliseconds += 1; }],
    ["zero measured ratio denominator", line => { line.paperApplyBytes.value.ratio = { status: "measured", value: { numerator: 0, denominator: 0 } }; }],
    ["ratio does not match byte totals", line => { line.paperApplyBytes.value.ratio = { status: "measured", value: { numerator: 1, denominator: 2 } }; }],
    ["no-apply reason with apply bytes", line => { line.paperApplyBytes.value.applyBytes = 1; }],
    ["wrong wall-clock reason", line => { line.paperApplyWallClock = { status: "unavailable", reason: "no-apply-receipts" }; }],
    ["role total mismatch", line => { line.recordedInvocations.value.total = 1; }],
  ];
  for (const [name, mutate] of invalid) {
    const candidate = clone(); mutate(candidate);
    assert.throws(() => validateStatsLineV1(candidate), Error, name);
  }

  const measured = clone();
  measured.auditRejectionCount = { status: "measured", value: 2 };
  measured.recordedInvocationWindow = { status: "measured", value: { first: "2026-01-01T00:00:00Z", last: "2026-01-02T00:00:00Z" } };
  measured.paperApplyBytes = { status: "measured", value: { paperBytes: 6, applyBytes: 3, ratio: { status: "measured", value: { numerator: 6, denominator: 3 } } } };
  measured.paperApplyWallClock = { status: "measured", value: { paperMilliseconds: 8, applyMilliseconds: 13 } };
  assert.equal(validateStatsLineV1(measured), measured);
});

test("StatsLine rejects duplicate/corrupt committed manifests and ignores files without a manifest", async () => {
  const one = fixture("judge", undefined, "same", { judgeStatus: "converged" }); const two = fixture("doctor", undefined, "same", { status: "completed" });
  const duplicate = { ".ak/dockets/issues/7/a/manifest.json": one.manifest, ".ak/dockets/issues/7/a/receipt.json": one.receipt, ".ak/dockets/issues/7/b/manifest.json": two.manifest, ".ak/dockets/issues/7/b/receipt.json": two.receipt, ".ak/dockets/issues/7/unarchived/receipt.json": enc({ ignored: true }) };
  await assert.rejects(produceStatsLineV1({ snapshot: snapshot(duplicate), issueNumber: 7 }), /Duplicate invocation/);
  const corrupt = { ".ak/dockets/issues/7/a/manifest.json": one.manifest, ".ak/dockets/issues/7/a/receipt.json": enc({ changed: true }) };
  await assert.rejects(produceStatsLineV1({ snapshot: snapshot(corrupt), issueNumber: 7 }), /Receipt identity mismatch/);
});

test("StatsLine puts ambiguous roles in unclassified and makes byte ratio honestly unavailable", async () => {
  const archived = fixture("judge", undefined, "ambiguous", { judgeStatus: "converged" });
  const manifest = JSON.parse(new TextDecoder().decode(archived.manifest));
  manifest.execution.argv.push("--ak-role", "doctor");
  const files = { ".ak/dockets/issues/7/a/manifest.json": enc(manifest), ".ak/dockets/issues/7/a/receipt.json": archived.receipt };
  const result = await produceStatsLineV1({ snapshot: snapshot(files), issueNumber: 7 });
  assert.equal(result.recordedInvocations.status, "measured");
  if (result.recordedInvocations.status === "measured") assert.equal(result.recordedInvocations.value.unclassified, 1);
  assert.equal(result.paperApplyBytes.status, "measured");
  if (result.paperApplyBytes.status === "measured") assert.deepEqual(result.paperApplyBytes.value.ratio, { status: "unavailable", reason: "unclassifiable-receipt" });
});

test("StatsLine validates the complete tracker default-merge join and never substitutes Git time", async () => {
  const empty = snapshot({});
  const measured = await produceStatsLineV1({ snapshot: empty, issueNumber: 7, tracker: { repository: "ak/repo", issueNumber: 7, issueOpenedAt: "2026-01-01T00:00:00.000Z", pullRequest: { repository: "ak/repo", number: 19, issueNumber: 7, mergedAt: "2026-01-02T00:00:00.000Z", base: { name: "main", isDefault: true } } } });
  assert.deepEqual(measured.issueToDefaultMerge, { status: "measured", value: { issueOpenedAt: "2026-01-01T00:00:00.000Z", mergedAt: "2026-01-02T00:00:00.000Z", milliseconds: 86_400_000 } });
  assert.deepEqual((await produceStatsLineV1({ snapshot: empty, issueNumber: 7 })).issueToDefaultMerge, { status: "unavailable", reason: "tracker-metadata-invalid" });
  assert.deepEqual(measured.paperApplyBytes, { status: "measured", value: { paperBytes: 0, applyBytes: 0, ratio: { status: "unavailable", reason: "no-apply-receipts" } } });
});
