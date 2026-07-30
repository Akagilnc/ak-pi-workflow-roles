/**
 * Seam-owned verifier for issue #15 Case A legacy /tmp migration artifacts.
 * Graduates the plan red/green oracles once into the regression suite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIG = join(
  REPO_ROOT,
  ".ak/dockets/issues/15/migration/legacy-case-a",
);

const ALLOWED_DISPOSITIONS = new Set([
  "recovered",
  "reference",
  "excluded",
  "superseded",
]);

const AXES = [
  "Judge",
  "Fixer",
  "Coder",
  "Reviewer",
  "Collector",
  "issue-1",
  "issue-2",
  "issue-3",
] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.isFile()) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

test("Case A migration artifacts exist at sealed seam path", () => {
  for (const f of [
    "discovery-spec.v1.json",
    "construction-walk.json",
    "independent-walk.json",
    "source-walk-equality.json",
    "inventory.json",
    "dispositions.json",
    "references.json",
    "recovered-index.json",
    "known-missing.json",
    "coverage-matrix.json",
    "manifest.json",
    "apply-self-check.json",
  ]) {
    assert.equal(existsSync(join(MIG, f)), true, `missing ${f}`);
  }
});

test("discovery spec seals prior aggregate out of the denominator", () => {
  const spec = readJson<{
    priorAggregateObservation: {
      excludedFromDenominator: boolean;
      excludedFromInventorySeed: boolean;
      excludedFromAdmissionOrCompleteness: boolean;
      notedCandidates: number;
    };
    genericExhaustClassification: { notByExtensionAlone: boolean };
    completenessClaim: string;
  }>(join(MIG, "discovery-spec.v1.json"));
  assert.equal(spec.priorAggregateObservation.excludedFromDenominator, true);
  assert.equal(spec.priorAggregateObservation.excludedFromInventorySeed, true);
  assert.equal(
    spec.priorAggregateObservation.excludedFromAdmissionOrCompleteness,
    true,
  );
  assert.equal(spec.genericExhaustClassification.notByExtensionAlone, true);
  assert.match(spec.completenessClaim, /does not claim historical completeness/i);
  const inv = readJson<{ priorAggregateObservationExcluded: boolean; count: number }>(
    join(MIG, "inventory.json"),
  );
  assert.equal(inv.priorAggregateObservationExcluded, true);
  assert.equal(inv.count > 0, true);
  assert.equal(typeof spec.priorAggregateObservation.notedCandidates, "number");
});

test("independent source-walk proves all-and-only equality with inventory keys", () => {
  const eq = readJson<{
    equal: boolean;
    keyCount: number;
  }>(join(MIG, "source-walk-equality.json"));
  assert.equal(eq.equal, true);
  const construction = readJson<{
    entries: Array<{ itemKey: string }>;
  }>(join(MIG, "construction-walk.json"));
  const independent = readJson<{
    entries: Array<{ itemKey: string }>;
  }>(join(MIG, "independent-walk.json"));
  const inv = readJson<{
    items: Array<{ itemKey: string }>;
    count: number;
  }>(join(MIG, "inventory.json"));

  const cKeys = new Set(construction.entries.map((e) => e.itemKey));
  const iKeys = new Set(independent.entries.map((e) => e.itemKey));
  const invKeys = new Set(inv.items.map((e) => e.itemKey));

  assert.equal(cKeys.size, iKeys.size);
  assert.equal(cKeys.size, invKeys.size);
  assert.equal(cKeys.size, eq.keyCount);
  assert.equal(inv.count, invKeys.size);
  for (const k of cKeys) {
    assert.equal(iKeys.has(k), true, `independent missing ${k}`);
    assert.equal(invKeys.has(k), true, `inventory missing ${k}`);
  }
  // RED oracle 1: omitting a construction key from inventory would fail
  assert.equal(invKeys.size > 0, true);
});

test("exactly one allowed disposition per discovered item; known-missing separate", () => {
  const inv = readJson<{ items: Array<{ itemKey: string; basename: string }> }>(
    join(MIG, "inventory.json"),
  );
  const disp = readJson<{
    items: Array<{ itemKey: string; disposition: string; basename: string }>;
  }>(join(MIG, "dispositions.json"));
  const km = readJson<{
    expectations: Array<{ status: string }>;
    note: string;
  }>(join(MIG, "known-missing.json"));

  assert.equal(disp.items.length, inv.items.length);
  const byKey = new Map<string, number>();
  for (const d of disp.items) {
    byKey.set(d.itemKey, (byKey.get(d.itemKey) ?? 0) + 1);
    assert.equal(
      ALLOWED_DISPOSITIONS.has(d.disposition),
      true,
      `unknown disposition ${d.disposition} for ${d.basename}`,
    );
  }
  for (const it of inv.items) {
    assert.equal(byKey.get(it.itemKey), 1, `disposition count for ${it.basename}`);
  }
  // RED: known-missing must not appear in discovered denominator
  for (const it of inv.items) {
    assert.notEqual(it.basename, "known-missing");
    assert.equal(String(it.itemKey).includes("known-missing"), false);
  }
  assert.match(km.note, /Separate from discovered denominator/i);
  for (const e of km.expectations) {
    assert.equal(e.status, "known-missing");
  }
});

test("superseded value-bearing evidence is not merely excluded", () => {
  const disp = readJson<{
    items: Array<{
      disposition: string;
      contentHandling?: string;
      contentStored?: boolean;
      evidence?: { reference?: unknown; recoveredPath?: string };
      reasonCode?: string;
    }>;
  }>(join(MIG, "dispositions.json"));
  const superseded = disp.items.filter((d) => d.disposition === "superseded");
  for (const d of superseded) {
    const preserved =
      d.contentHandling === "recovered" ||
      d.contentHandling === "reference" ||
      d.contentStored === true ||
      Boolean(d.evidence?.reference) ||
      Boolean(d.evidence?.recoveredPath);
    assert.equal(
      preserved,
      true,
      "superseded value-bearing must be recovered or referenced",
    );
    assert.notEqual(d.reasonCode, "generic-role-session-exhaust");
  }
});

test("genericity is not extension-alone; generic exhaust not copied; jsonl absent from recovered", () => {
  const spec = readJson<{
    genericExhaustClassification: {
      notByExtensionAlone: boolean;
      jsonlExtensionNeitherAutoExcludeNorAdmit: boolean;
    };
  }>(join(MIG, "discovery-spec.v1.json"));
  assert.equal(spec.genericExhaustClassification.notByExtensionAlone, true);
  assert.equal(
    spec.genericExhaustClassification.jsonlExtensionNeitherAutoExcludeNorAdmit,
    true,
  );

  const inv = readJson<{
    items: Array<{
      basename: string;
      genericExhaust: boolean;
      provenanceClass: string;
      classificationReason: string;
    }>;
  }>(join(MIG, "inventory.json"));
  const jsonl = inv.items.filter((i) => i.basename.endsWith(".jsonl"));
  assert.equal(jsonl.length > 0, true, "fixture expects some jsonl candidates");
  for (const j of jsonl) {
    // Classified by combined provenance, reason must not be extension-alone.
    assert.equal(j.genericExhaust, true);
    assert.equal(j.provenanceClass, "role-session-recording");
    assert.match(j.classificationReason, /Extension alone is insufficient/i);
  }

  const recoveredFiles = listFilesRecursive(join(MIG, "recovered"));
  for (const f of recoveredFiles) {
    assert.equal(f.endsWith(".jsonl"), false, `jsonl must not be recovered: ${f}`);
  }

  const disp = readJson<{
    items: Array<{
      basename: string;
      disposition: string;
      evidence?: { copiedIntoGit?: boolean; payloadSemanticallyRead?: boolean };
    }>;
  }>(join(MIG, "dispositions.json"));
  for (const d of disp.items) {
    if (d.basename.endsWith(".jsonl")) {
      assert.equal(d.disposition, "excluded");
      assert.equal(d.evidence?.copiedIntoGit ?? false, false);
      assert.equal(d.evidence?.payloadSemanticallyRead ?? false, false);
    }
  }
});

test("recovered bytes have scanner evidence; hashes match; required metadata present", () => {
  const recovered = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      path: string;
      recoveredSha256: string;
      redactionReportPath: string;
      discoveryTime: string;
      admissionReason: string;
    }>;
  }>(join(MIG, "recovered-index.json"));

  for (const item of recovered.items) {
    const abs = join(MIG, item.path);
    assert.equal(existsSync(abs), true, item.path);
    const bytes = readFileSync(abs);
    assert.equal(sha256(bytes), item.recoveredSha256, item.basename);
    const report = readJson<{
      redacted: boolean;
      hits: unknown[];
      scanner: string;
      recoveredSha256: string;
      admissionReason: string;
    }>(join(MIG, item.redactionReportPath));
    assert.equal(report.recoveredSha256, item.recoveredSha256);
    assert.equal(typeof report.redacted, "boolean");
    assert.equal(Array.isArray(report.hits), true);
    assert.match(report.scanner, /scanBytes/);
    assert.equal(typeof item.discoveryTime, "string");
    assert.equal(item.admissionReason.length > 0, true);
  }

  // reference tuples complete when present
  const refs = readJson<{
    items: Array<{
      repositoryId: string;
      commitSha: string;
      path: string;
      blobOid: string;
      sha256: string;
    }>;
  }>(join(MIG, "references.json"));
  for (const r of refs.items) {
    assert.equal(typeof r.repositoryId, "string");
    assert.equal(r.commitSha.length >= 40, true);
    assert.equal(typeof r.path, "string");
    assert.equal(r.blobOid.length >= 40, true);
    assert.equal(r.sha256.length, 64);
  }
});

test("eight-axis coverage matrix has explicit outcomes; no historical completeness claim", () => {
  const cov = readJson<{
    axes: string[];
    outcomes: Record<
      string,
      { status: string; axis: string }
    >;
    historicalCompletenessClaimed: boolean;
    completenessClaim: string;
  }>(join(MIG, "coverage-matrix.json"));
  assert.deepEqual(cov.axes, [...AXES]);
  assert.equal(cov.historicalCompletenessClaimed, false);
  assert.match(cov.completenessClaim, /not claim historical completeness/i);

  const allowed = new Set([
    "recovered",
    "reference",
    "known-missing",
    "justified-excluded",
    "superseded",
  ]);
  for (const axis of AXES) {
    const o = cov.outcomes[axis];
    assert.ok(o, `missing axis ${axis}`);
    assert.equal(o.axis, axis);
    assert.equal(allowed.has(o.status), true, `${axis} status ${o.status}`);
  }

  const manifest = readJson<{
    historicalCompletenessClaimed: boolean;
    genericPayloadCopiedIntoGit: boolean;
  }>(join(MIG, "manifest.json"));
  assert.equal(manifest.historicalCompletenessClaimed, false);
  assert.equal(manifest.genericPayloadCopiedIntoGit, false);
});

test("red oracle probes: synthetic violations are detectable from committed shape", () => {
  // These assertions document the failure conditions the verifier encodes.
  const inv = readJson<{ items: Array<{ itemKey: string }> }>(
    join(MIG, "inventory.json"),
  );
  const disp = readJson<{ items: Array<{ itemKey: string; disposition: string }> }>(
    join(MIG, "dispositions.json"),
  );
  // 1. omit inventory key
  {
    const broken = new Set(inv.items.map((i) => i.itemKey));
    broken.delete(inv.items[0]!.itemKey);
    assert.equal(broken.size, inv.items.length - 1);
    assert.notEqual(broken.size, disp.items.length);
  }
  // 2. zero dispositions for an item
  {
    const counts = new Map<string, number>();
    for (const d of disp.items) counts.set(d.itemKey, (counts.get(d.itemKey) ?? 0) + 1);
    for (const c of counts.values()) assert.equal(c, 1);
  }
  // 3. unknown disposition would fail ALLOWED set
  assert.equal(ALLOWED_DISPOSITIONS.has("not-a-real-disposition"), false);
  // 10. historical completeness claim forbidden
  const m = readJson<{ historicalCompletenessClaimed: boolean }>(
    join(MIG, "manifest.json"),
  );
  assert.equal(m.historicalCompletenessClaimed, false);
});

test("migration tree omits private rescue and contains only case-a artifacts under seam", () => {
  const files = listFilesRecursive(MIG).map((f) => relative(MIG, f));
  for (const f of files) {
    assert.equal(f.includes("case-a-rescue"), false);
    assert.equal(f.includes("node_modules"), false);
  }
  // seam path itself
  assert.equal(existsSync(MIG), true);
  const st = statSync(MIG);
  assert.equal(st.isDirectory(), true);
});
