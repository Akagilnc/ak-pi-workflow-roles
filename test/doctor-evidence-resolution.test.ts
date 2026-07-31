import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes } from "../src/canonical-json.ts";
import { resolveDoctorEvidenceIndex } from "../src/doctor-evidence.ts";
import { sha256Hex } from "../src/sha256.ts";

const commit = "a".repeat(40); const path = ".ak/dockets/issues/12/judgment/review-001/receipt.json";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function raw(data: unknown, overrides: Record<string, unknown> = {}) { const body = bytes(data); return { version: 1, repository: "ak/repo", targetCommit: commit, catalog: [{ key: "gate", kind: "gate", active: true }], populations: [{ id: "p", targetKey: "gate", eligibleEvidenceIds: ["bite"] }], evidence: [{ id: "bite", kind: "receipt", sha256: sha256Hex(body), byteLength: body.byteLength, source: { commit, path }, data }], ...overrides }; }

test("committed claim-chain evidence preserves exact raw identity across noncanonical JSON renderings", async () => {
  const payload = { zebra: 1, alpha: { second: true, first: false } };
  const renderings = [
    '{"zebra":1,"alpha":{"second":true,"first":false}}',
    '{\n  "zebra": 1,\n  "alpha": {\n    "second": true,\n    "first": false\n  }\n}\n',
    '{"alpha":{"first":false,"second":true},"zebra":1}\n',
  ];
  for (const rendering of renderings) {
    const targetBytes = new TextEncoder().encode(rendering);
    const asserted = raw(payload);
    asserted.evidence[0]!.sha256 = sha256Hex(targetBytes);
    asserted.evidence[0]!.byteLength = targetBytes.byteLength;
    const admitted = await resolveDoctorEvidenceIndex(asserted, { async read(target, requested) { assert.equal(target, commit); assert.equal(requested, path); return targetBytes; } });
    const entry = admitted.evidence[0]!;
    assert.deepEqual(entry.data, payload);
    assert.equal(entry.sha256, sha256Hex(targetBytes));
    assert.equal(entry.byteLength, targetBytes.byteLength);
    assert.ok(Object.isFrozen(admitted));
  }
});

test("fabricated inline receipts and target-byte mismatches cannot become admitted bites", async () => { const fabricated = { blocked: true }; const actual = { blocked: false }; await assert.rejects(resolveDoctorEvidenceIndex(raw(fabricated), { async read() { return bytes(actual); } }), /target-byte mismatch/); await assert.rejects(resolveDoctorEvidenceIndex(raw(fabricated, { evidence: [{ ...(raw(fabricated).evidence[0] as object), byteLength: 1 }] }), { async read() { return bytes(fabricated); } }), /digest mismatch/); await assert.rejects(resolveDoctorEvidenceIndex(raw(fabricated, { evidence: [{ ...(raw(fabricated).evidence[0] as object), sha256: "0".repeat(64) }] }), { async read() { return bytes(fabricated); } }), /digest mismatch/); });

test("committed sources reject escapes, aliases, duplicates, wrong targets, malformed and inaccessible bytes", async () => { const payload = { blocked: true }; const base: any = raw(payload); for (const escaped of ["../receipt.json", "/.ak/dockets/issues/12/x.json", ".ak\\dockets\\issues\\12\\x.json", ".ak/dockets/issues/0/x.json", ".ak/dockets/issues/12/../x.json"]) await assert.rejects(resolveDoctorEvidenceIndex({ ...base, evidence: [{ ...base.evidence[0], source: { commit, path: escaped } }] }, { async read() { return bytes(payload); } }), /canonical/); await assert.rejects(resolveDoctorEvidenceIndex({ ...base, evidence: [{ ...base.evidence[0], source: { commit: "b".repeat(40), path } }] }, { async read() { return bytes(payload); } }), /canonical/); await assert.rejects(resolveDoctorEvidenceIndex({ ...base, evidence: [base.evidence[0], { ...base.evidence[0], id: "other" }] }, { async read() { return bytes(payload); } }), /Duplicate committed/); await assert.rejects(resolveDoctorEvidenceIndex(base, { async read() { return new TextEncoder().encode("{not json"); } }), /malformed/); await assert.rejects(resolveDoctorEvidenceIndex(base, { async read() { throw new Error("missing"); } }), /inaccessible/); });

test("Git and tracker metadata accept only their closed normalized fact shapes", async () => { const git = { commits: [{ commit, timestamp: "2026-01-01T00:00:00Z", paths: ["src/x.ts"] }] }; const tracker = { issues: [{ repository: "ak/repo", number: 12, createdAt: "2026-01-01T00:00:00Z", closedAt: null }], pullRequests: [] }; const metadata = [entry("git", "gitMetadata", git), entry("tracker", "trackerMetadata", tracker)]; const admitted = await resolveDoctorEvidenceIndex({ ...raw({ blocked: true }), evidence: [...raw({ blocked: true }).evidence, ...metadata] }, { async read() { return bytes({ blocked: true }); } }); assert.equal(admitted.evidence.length, 3); for (const bad of [{ ...git, branch: "main" }, { commits: [{ ...git.commits[0], message: "unbounded" }] }, { ...tracker, issues: [{ ...tracker.issues[0], title: "unbounded" }] }]) { const kind = Object.hasOwn(bad, "commits") ? "gitMetadata" : "trackerMetadata"; await assert.rejects(resolveDoctorEvidenceIndex({ ...raw({ blocked: true }), evidence: [...raw({ blocked: true }).evidence, entry("bad", kind, bad)] }, { async read() { return bytes({ blocked: true }); } }), /exact keys/); } });

function entry(id: string, kind: string, data: unknown) { const body = canonicalJsonBytes(data); return { id, kind, sha256: sha256Hex(body), byteLength: body.byteLength, data }; }
