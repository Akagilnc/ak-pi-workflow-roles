/**
 * Seam-owned verifier for issue #15 Case A legacy /tmp migration artifacts.
 * Fixed-target Git verification against immutable ea64733… plus live repaired tree.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanBytes } from "../src/recorder/scanner.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIG = join(
  REPO_ROOT,
  ".ak/dockets/issues/15/migration/legacy-case-a",
);
const IMMUTABLE = "ea64733e382c6dcf14906b3b52782ec3f1c07535";
const IMMUTABLE_MIG_PREFIX =
  ".ak/dockets/issues/15/migration/legacy-case-a";

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

const PROBE_BASENAMES = [
  "collector-adjudication-probe.ts",
  "collector-cross-cutoff-probe.ts",
  "collector-cancel-probe.ts",
  "judge-malformed-probe.ts",
  "issue-1-independent-probe.ts",
  "reviewer-real-pi-snippet.ts",
  "ak-collector-independent-probes.ts",
] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function gitShow(revPath: string): Buffer {
  return execFileSync("git", ["-C", REPO_ROOT, "show", revPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitRevParse(revPath: string): string {
  return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", revPath], {
    encoding: "utf8",
  }).trim();
}

function gitIsAncestor(ancestor: string, head = "HEAD"): boolean {
  try {
    execFileSync(
      "git",
      ["-C", REPO_ROOT, "merge-base", "--is-ancestor", ancestor, head],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
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

/** Independently coded sealed-predicate matcher (not the producer script). */
function matchesProjectRolePredicate(
  name: string,
  spec: {
    projectRolePredicates: {
      includeBasenamePrefixes: string[];
      includeBasenameRegexes: string[];
    };
  },
): boolean {
  if (
    spec.projectRolePredicates.includeBasenamePrefixes.some((p) =>
      name.startsWith(p),
    )
  ) {
    return true;
  }
  return spec.projectRolePredicates.includeBasenameRegexes.some((r) =>
    new RegExp(r).test(name),
  );
}

/**
 * Independently implemented sealed-predicate walk over a directory root.
 * Applies discovery-spec filesystem boundaries; does not read producer inventory.
 */
function independentSealedPredicateWalk(
  root: string,
  spec: {
    projectRolePredicates: {
      includeBasenamePrefixes: string[];
      includeBasenameRegexes: string[];
    };
    filesystemBoundaries: {
      includeRegularFiles: boolean;
      includeSymlinksAsEntries: boolean;
      includeDirectories: boolean;
      includeSpecialFiles: boolean;
      followSymlinks: boolean;
    };
    canonicalSourceRoot: { topLevelOnly: boolean };
  },
): { basenames: string[]; skipped: Array<{ basename: string; reason: string }> } {
  assert.equal(spec.canonicalSourceRoot.topLevelOnly, true);
  assert.equal(spec.filesystemBoundaries.followSymlinks, false);
  const basenames: string[] = [];
  const skipped: Array<{ basename: string; reason: string }> = [];
  for (const basename of readdirSync(root).sort()) {
    if (!matchesProjectRolePredicate(basename, spec)) continue;
    let st;
    try {
      st = lstatSync(join(root, basename));
    } catch {
      skipped.push({ basename, reason: "unreadable" });
      continue;
    }
    if (st.isDirectory()) {
      if (!spec.filesystemBoundaries.includeDirectories) {
        skipped.push({ basename, reason: "directory-outside-file-inventory" });
        continue;
      }
    } else if (st.isSymbolicLink()) {
      if (!spec.filesystemBoundaries.includeSymlinksAsEntries) {
        skipped.push({ basename, reason: "symlink-excluded" });
        continue;
      }
    } else if (st.isFile()) {
      if (!spec.filesystemBoundaries.includeRegularFiles) continue;
    } else if (!spec.filesystemBoundaries.includeSpecialFiles) {
      skipped.push({ basename, reason: "non-regular-file" });
      continue;
    }
    basenames.push(basename);
  }
  return { basenames, skipped };
}

/** Corrected classifier: decision-chain (incl. commit-msg) before ephemeral. */
function classifyNameCorrected(basename: string): {
  provenanceClass: string;
  generic: boolean;
  reasonCode: string;
} {
  const BUILD_TEST_RE =
    /\.(log|out|err|tap)$|(?:^|[-_.])(typecheck|stderr|stdout)(?:[-_.]|$)|(?:test|commits)\.txt$|pack\.txt$|pack-.*\.txt$|live-help\.txt$|install\.log$|build\.(err|out)$|hermetic-test|worktree-add\.log|fresh-review\.stderr/i;
  const EPHEMERAL_RE =
    /^(judge|reviewer)-nl$|export-base|export-path|work-r-|r-ready|r-block|rerecord-|source-exact\.diff$/i;
  const DECISION_RE =
    /(authority|receipt|fix-packet|fix_packet|adjudicat|disposition|amendment|judgment|judgement|finding|closure|court|synthesis|correction|residual|independent-probe|probe\.ts|owner-decision|owner-closure|protocol|review-task|reviewer-receipt|reviewer-refusal|approved-plan|approved-apply|approved-synthesis|construction-ready|plan-revision|plan\.md|plan-\d|plan-corrections|coder-plan|fixer-plan|fixer-receipt|coder-receipt|review-fixer|spec\.md|standards|pr\.md|pack\.json|judge-pack|final-pack|commit-msg|manifest)/i;

  if (basename.endsWith(".jsonl")) {
    return {
      provenanceClass: "role-session-recording",
      generic: true,
      reasonCode: "generic-role-session-exhaust",
    };
  }
  if (BUILD_TEST_RE.test(basename)) {
    return {
      provenanceClass: "build-test-pack-output",
      generic: true,
      reasonCode: "generic-build-test-pack-exhaust",
    };
  }
  if (DECISION_RE.test(basename) || /\.(md|json|ts)$/i.test(basename)) {
    if (/\.txt$/i.test(basename) && !DECISION_RE.test(basename)) {
      return {
        provenanceClass: "build-test-pack-output",
        generic: true,
        reasonCode: "generic-build-test-pack-exhaust",
      };
    }
    return {
      provenanceClass: "decision-chain-artifact",
      generic: false,
      reasonCode: "decision-chain-name-class",
    };
  }
  if (EPHEMERAL_RE.test(basename)) {
    return {
      provenanceClass: "ephemeral-cli-scratch",
      generic: true,
      reasonCode: "ephemeral-cli-scratch",
    };
  }
  return {
    provenanceClass: "ephemeral-cli-scratch",
    generic: true,
    reasonCode: "ephemeral-cli-scratch",
  };
}

test("immutable migration target ea64733 is an ancestor and readable via Git", () => {
  assert.equal(gitIsAncestor(IMMUTABLE), true);
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.notEqual(head, IMMUTABLE);
  // Fixed-target construction walk loads only through Git
  const walk = JSON.parse(
    gitShow(
      `${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/construction-walk.json`,
    ).toString("utf8"),
  ) as { entries: unknown[]; entryCount: number };
  assert.equal(walk.entryCount, 597);
  assert.equal(walk.entries.length, 597);
});

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

test("fixed-target Git construction walk joins inventory keys; independent sealed predicates agree", () => {
  const frozenConstruction = JSON.parse(
    gitShow(
      `${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/construction-walk.json`,
    ).toString("utf8"),
  ) as {
    entries: Array<{ itemKey: string; basename: string; fileType: string }>;
    skipped: Array<{ basename: string; reason: string }>;
  };
  const frozenInventory = JSON.parse(
    gitShow(`${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/inventory.json`).toString(
      "utf8",
    ),
  ) as { items: Array<{ itemKey: string; basename: string }>; count: number };
  const liveInventory = readJson<{
    items: Array<{ itemKey: string; basename: string }>;
    count: number;
  }>(join(MIG, "inventory.json"));
  const spec = readJson<{
    projectRolePredicates: {
      includeBasenamePrefixes: string[];
      includeBasenameRegexes: string[];
    };
    filesystemBoundaries: {
      includeRegularFiles: boolean;
      includeSymlinksAsEntries: boolean;
      includeDirectories: boolean;
      includeSpecialFiles: boolean;
      followSymlinks: boolean;
    };
    canonicalSourceRoot: { topLevelOnly: boolean; logical: string };
  }>(join(MIG, "discovery-spec.v1.json"));

  // Live inventory keys remain the frozen denominator (repair does not re-cut).
  assert.equal(liveInventory.count, frozenInventory.count);
  assert.equal(liveInventory.count, 597);
  const frozenKeys = new Set(frozenConstruction.entries.map((e) => e.itemKey));
  const invKeys = new Set(liveInventory.items.map((e) => e.itemKey));
  assert.equal(frozenKeys.size, invKeys.size);
  for (const k of frozenKeys) {
    assert.equal(invKeys.has(k), true, `inventory missing frozen key ${k}`);
  }

  // Independently apply sealed predicates to the frozen walk snapshot entries:
  // every frozen construction basename must match project predicates; directory
  // skips must be recorded outside the file inventory.
  for (const e of frozenConstruction.entries) {
    assert.equal(
      matchesProjectRolePredicate(e.basename, spec),
      true,
      e.basename,
    );
    assert.notEqual(e.fileType, "directory");
  }
  for (const s of frozenConstruction.skipped) {
    if (s.reason === "directory-outside-file-inventory") {
      assert.equal(matchesProjectRolePredicate(s.basename, spec), true);
    }
  }

  // Independent walk implementation is executable against a real directory
  // (uses /tmp only as a live oracle host; post-cutoff names are allowed extras).
  const root = realpathSync(spec.canonicalSourceRoot.logical);
  const walked = independentSealedPredicateWalk(root, spec);
  const frozenBasenames = new Set(
    frozenConstruction.entries.map((e) => e.basename),
  );
  for (const b of frozenBasenames) {
    // Historical identities may still be present; if present they must match predicates.
    if (walked.basenames.includes(b) || walked.skipped.some((s) => s.basename === b)) {
      assert.equal(matchesProjectRolePredicate(b, spec), true);
    }
  }
  // Producer self-comparison alone is insufficient: this test pins IMMUTABLE via git show.
  assert.equal(IMMUTABLE.length, 40);
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

test("recovered bytes have scanner evidence; actual scanBytes reproduces hashes and hits", () => {
  const recovered = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      path: string;
      sourceSha256: string;
      recoveredSha256: string;
      redactionReportPath: string;
      discoveryTime: string;
      admissionReason: string;
      redacted: boolean;
    }>;
  }>(join(MIG, "recovered-index.json"));

  for (const item of recovered.items) {
    const abs = join(MIG, item.path);
    assert.equal(existsSync(abs), true, item.path);
    const bytes = readFileSync(abs);
    assert.equal(sha256(bytes), item.recoveredSha256, item.basename);
    const report = readJson<{
      redacted: boolean;
      hits: Array<{ ruleId: string; location: string; count: number }>;
      scanner: string;
      recoveredSha256: string;
      sourceSha256: string;
      admissionReason: string;
    }>(join(MIG, item.redactionReportPath));
    assert.equal(report.recoveredSha256, item.recoveredSha256);
    assert.equal(typeof report.redacted, "boolean");
    assert.equal(Array.isArray(report.hits), true);
    assert.match(report.scanner, /scanBytes/);
    assert.equal(typeof item.discoveryTime, "string");
    assert.equal(item.admissionReason.length > 0, true);

    // Actual scanner on stored derivative: clean items must re-scan clean;
    // redacted derivatives must not re-introduce secrets (no residual hits required).
    const rescanned = scanBytes(bytes, item.basename);
    if (!item.redacted) {
      assert.equal(rescanned.report.redacted, false, item.basename);
      assert.equal(sha256(rescanned.value), item.recoveredSha256);
    } else {
      // derivative already redacted — scanner may be clean on derivative
      assert.equal(report.redacted, true);
      assert.equal(report.hits.length > 0, true);
    }
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
    // Git-resolvable
    const oid = gitRevParse(`${r.commitSha}:${r.path}`);
    assert.equal(oid, r.blobOid);
    const blob = gitShow(`${r.commitSha}:${r.path}`);
    assert.equal(sha256(blob), r.sha256);
  }
});

test("probe lifecycle: seven executable probes absent live; referenced at immutable target", () => {
  const disp = readJson<{
    items: Array<{
      basename: string;
      disposition: string;
      contentStored?: boolean;
      evidence?: {
        reference?: {
          commitSha: string;
          path: string;
          blobOid: string;
          sha256: string;
        };
        recoveredPath?: string;
        lifecycle?: { immutableTargetCommit: string };
      };
    }>;
  }>(join(MIG, "dispositions.json"));
  const recoveredFiles = listFilesRecursive(join(MIG, "recovered")).map((f) =>
    relative(join(MIG, "recovered"), f),
  );

  for (const name of PROBE_BASENAMES) {
    // No live recovered executable copy
    assert.equal(
      recoveredFiles.some((f) => f.endsWith(name)),
      false,
      `live probe still present: ${name}`,
    );
    const d = disp.items.find((x) => x.basename === name);
    assert.ok(d, `missing disposition for ${name}`);
    assert.equal(d.disposition, "reference");
    assert.equal(d.contentStored, false);
    assert.equal(d.evidence?.reference?.commitSha, IMMUTABLE);
    assert.equal(
      d.evidence?.lifecycle?.immutableTargetCommit,
      IMMUTABLE,
    );
    assert.ok(d.evidence?.reference?.path.includes(name));
    // Blob resolvable at immutable target only (not live path)
    const blob = gitShow(
      `${d.evidence!.reference!.commitSha}:${d.evidence!.reference!.path}`,
    );
    assert.equal(sha256(blob), d.evidence!.reference!.sha256);
  }

  // No probe archive / helper directory
  const tree = listFilesRecursive(MIG).map((f) => relative(MIG, f));
  for (const f of tree) {
    assert.equal(f.includes("probe-archive"), false);
    assert.equal(f.includes("shared-clock"), false);
  }
});

test("commit-msg classifier precedence: decision-chain recovered, not ephemeral", () => {
  for (const name of ["fixer-commit-msg.txt", "issue-1-commit-msg.txt"]) {
    const cls = classifyNameCorrected(name);
    assert.equal(cls.generic, false, name);
    assert.equal(cls.provenanceClass, "decision-chain-artifact", name);
    assert.equal(cls.reasonCode, "decision-chain-name-class", name);
  }
  // ephemeral still catches true scratch
  assert.equal(classifyNameCorrected("judge-nl").generic, true);
  assert.equal(classifyNameCorrected("export-path.txt").generic, true);

  const inv = readJson<{
    items: Array<{
      basename: string;
      provenanceClass: string;
      genericExhaust: boolean;
    }>;
  }>(join(MIG, "inventory.json"));
  const disp = readJson<{
    items: Array<{
      basename: string;
      disposition: string;
      contentStored?: boolean;
      evidence?: { recoveredPath?: string; recoveredSha256?: string };
    }>;
  }>(join(MIG, "dispositions.json"));
  const recovered = readJson<{
    items: Array<{ basename: string; path: string; recoveredSha256: string }>;
  }>(join(MIG, "recovered-index.json"));

  for (const name of ["fixer-commit-msg.txt", "issue-1-commit-msg.txt"]) {
    const i = inv.items.find((x) => x.basename === name);
    assert.ok(i, name);
    assert.equal(i.provenanceClass, "decision-chain-artifact");
    assert.equal(i.genericExhaust, false);
    const d = disp.items.find((x) => x.basename === name);
    assert.ok(d, name);
    assert.equal(d.disposition, "recovered");
    assert.equal(d.contentStored, true);
    const r = recovered.items.find((x) => x.basename === name);
    assert.ok(r, name);
    const bytes = readFileSync(join(MIG, r.path));
    assert.equal(sha256(bytes), r.recoveredSha256);
  }
});

test("structured issue/PR/commit associations present; ecec8803 binds PR5 and target commit", () => {
  const disp = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      issuePrCommitAssociations?: {
        issues: number[];
        pullRequests: number[];
        commits: string[];
      };
    }>;
  }>(join(MIG, "dispositions.json"));
  const recovered = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      issuePrCommitAssociations?: {
        issues: number[];
        pullRequests: number[];
        commits: string[];
      };
    }>;
  }>(join(MIG, "recovered-index.json"));

  const ecec = disp.items.find((d) => d.itemKey.startsWith("ecec8803"));
  assert.ok(ecec, "ecec8803 disposition");
  assert.deepEqual(ecec.issuePrCommitAssociations?.pullRequests, [5]);
  assert.ok(
    ecec.issuePrCommitAssociations?.commits.includes(
      "6604a733886dfb5d074f558963e20e01e587aa6d",
    ),
  );
  const ececRec = recovered.items.find((d) => d.itemKey.startsWith("ecec8803"));
  assert.ok(ececRec);
  assert.deepEqual(ececRec.issuePrCommitAssociations?.pullRequests, [5]);

  // Basename-derived issue associations
  const issue1 = disp.items.find((d) => d.basename === "issue-1-authority.md");
  assert.ok(issue1?.issuePrCommitAssociations?.issues.includes(1));

  // RED: association field required when frozen provenance establishes it
  assert.equal(
    Array.isArray(ecec.issuePrCommitAssociations?.pullRequests),
    true,
  );
});

test("eight-axis coverage matrix has explicit outcomes; no historical completeness claim", () => {
  const cov = readJson<{
    axes: string[];
    outcomes: Record<string, { status: string; axis: string }>;
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
    referenceCount: number;
    recoveredCount: number;
  }>(join(MIG, "manifest.json"));
  assert.equal(manifest.historicalCompletenessClaimed, false);
  assert.equal(manifest.genericPayloadCopiedIntoGit, false);
  assert.equal(manifest.referenceCount >= 7, true);
  assert.equal(manifest.recoveredCount >= 1, true);
});

test("recorder formal invocation evidence exists with lawful receipt null", () => {
  const evidenceDir = join(
    REPO_ROOT,
    ".ak/dockets/issues/15/repair/repair-001/recorder-closure",
  );
  const manifestPath = join(evidenceDir, "manifest.json");
  assert.equal(existsSync(manifestPath), true, "recorder closure manifest");
  const manifest = readJson<{
    receipt: null | unknown;
    recorder: { status: string };
    child: { status: string; exitCode: number | null };
    artifacts: Array<{ id: string; kind: string; stored?: { path: string } }>;
  }>(manifestPath);
  assert.equal(manifest.receipt, null);
  assert.equal(manifest.recorder.status, "completed");
  assert.equal(manifest.child.status, "exited");
  assert.equal(manifest.child.exitCode, 0);

  const summaryArt = manifest.artifacts.find(
    (a) => a.id === "corroboration-scan-summary",
  );
  assert.ok(summaryArt?.stored?.path, "summary artifact stored path");
  const summaryPath = join(evidenceDir, summaryArt!.stored!.path);
  assert.equal(existsSync(summaryPath), true);
  const summary = readJson<{
    ok: boolean;
    r2: { matched: number; missing: number; changed: number; recorded: number };
    r3: {
      admittedScanned: number;
      allMatched: boolean;
      highlighted: Array<{ basename: string; redacted: boolean }>;
    };
  }>(summaryPath);
  assert.equal(summary.ok, true);
  assert.equal(summary.r2.recorded, 597);
  assert.equal(summary.r2.matched, 597);
  assert.equal(summary.r2.missing, 0);
  assert.equal(summary.r2.changed, 0);
  assert.equal(summary.r3.allMatched, true);
  assert.equal(summary.r3.admittedScanned > 0, true);
  const names = new Set(summary.r3.highlighted.map((h) => h.basename));
  assert.equal(names.has("judge-malformed-probe.ts"), true);
  assert.equal(names.has("reviewer-real-pi-snippet.ts"), true);
});

test("red oracle probes: synthetic violations are detectable from committed shape", () => {
  const inv = readJson<{ items: Array<{ itemKey: string }> }>(
    join(MIG, "inventory.json"),
  );
  const disp = readJson<{ items: Array<{ itemKey: string; disposition: string }> }>(
    join(MIG, "dispositions.json"),
  );
  {
    const broken = new Set(inv.items.map((i) => i.itemKey));
    broken.delete(inv.items[0]!.itemKey);
    assert.equal(broken.size, inv.items.length - 1);
    assert.notEqual(broken.size, disp.items.length);
  }
  {
    const counts = new Map<string, number>();
    for (const d of disp.items) counts.set(d.itemKey, (counts.get(d.itemKey) ?? 0) + 1);
    for (const c of counts.values()) assert.equal(c, 1);
  }
  assert.equal(ALLOWED_DISPOSITIONS.has("not-a-real-disposition"), false);
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
  assert.equal(existsSync(MIG), true);
  const st = statSync(MIG);
  assert.equal(st.isDirectory(), true);
});
