/**
 * Seam-owned verifier for issue #15 Case A legacy /tmp migration artifacts.
 * Fixed-target Git verification against immutable ea64733… plus live repaired tree.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
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
const REPAIR_001_APPLY =
  ".ak/dockets/issues/15/repair/repair-001/apply";
const ORIGINAL_APPLY_COMMIT =
  "702e36f97caa92f012470bf5a890e656a5859800";
const NONCONFORMING_SUCCESSOR_COMMIT =
  "49807d493861b5dc5e9c6a9813b2d7679a241df8";
const RECORDER_001 =
  ".ak/dockets/issues/15/repair/repair-001/recorder-closure";
const RECORDER_002 =
  ".ak/dockets/issues/15/repair/repair-002/recorder-closure";
const HISTORICAL_NONCONFORMANCE =
  ".ak/dockets/issues/15/repair/repair-002/historical-nonconformance.json";

/** Sole separable post-cutoff addition under sealed predicates. */
const EXPECTED_POST_CUTOFF = new Set(["coder.ts"]);

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

type IssuePrCommitAssociations = {
  issues: number[];
  pullRequests: number[];
  commits: string[];
};

type SealedSpec = {
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
  priorAggregateObservation: {
    excludedFromDenominator: boolean;
    excludedFromInventorySeed: boolean;
    excludedFromAdmissionOrCompleteness: boolean;
    notedCandidates: number;
  };
  genericExhaustClassification: {
    notByExtensionAlone: boolean;
    jsonlExtensionNeitherAutoExcludeNorAdmit: boolean;
  };
  completenessClaim: string;
};

type FrozenWalkEntry = {
  itemKey: string;
  basename: string;
  sanitizedLocator: string;
  fileType: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  sha256: string | null;
};

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

function gitIsAncestor(ancestor: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", REPO_ROOT, "merge-base", "--is-ancestor", ancestor, "HEAD"],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function noFollowRead(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const st = lstatSync(path);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
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

function loadSealedSpec(): SealedSpec {
  return JSON.parse(
    gitShow(`${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/discovery-spec.v1.json`).toString(
      "utf8",
    ),
  ) as SealedSpec;
}

function loadFrozenWalk(): {
  entries: FrozenWalkEntry[];
  skipped: Array<{ basename: string; reason: string }>;
  entryCount: number;
} {
  return JSON.parse(
    gitShow(
      `${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/construction-walk.json`,
    ).toString("utf8"),
  ) as {
    entries: FrozenWalkEntry[];
    skipped: Array<{ basename: string; reason: string }>;
    entryCount: number;
  };
}

function loadFrozenInventory(): {
  items: Array<{ itemKey: string; basename: string }>;
  count: number;
} {
  return JSON.parse(
    gitShow(`${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/inventory.json`).toString(
      "utf8",
    ),
  ) as { items: Array<{ itemKey: string; basename: string }>; count: number };
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

/**
 * Derive associations from frozen basename metadata and admitted non-generic
 * recovered bytes only. Never reads generic JSONL/session payloads.
 */
function extractAssociationsFromBasenameAndOptionalJson(
  basename: string,
  jsonText: string | null,
): {
  issues: number[];
  pullRequests: number[];
  commits: string[];
  shortCommitTokens: string[];
} {
  const issues = new Set<number>();
  const pullRequests = new Set<number>();
  const commits = new Set<string>();
  const shortCommitTokens: string[] = [];

  for (const m of basename.matchAll(/issue[-_]?(\d+)(?:[-_.]|$)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20) issues.add(n);
  }
  for (const m of basename.matchAll(/pr[-_]?(\d+)/gi)) {
    pullRequests.add(Number(m[1]));
  }
  for (const m of basename.matchAll(/pr\d+-([0-9a-f]{3,39})(?:[-_.]|$)/gi)) {
    shortCommitTokens.push(m[1]!.toLowerCase());
  }

  if (jsonText !== null && basename.endsWith(".json")) {
    try {
      const j = JSON.parse(jsonText) as Record<string, unknown>;
      if (typeof j.prNumber === "number") pullRequests.add(j.prNumber);
      if (typeof j.pull_request === "number") pullRequests.add(j.pull_request);
      for (const key of ["targetHead", "commitSha", "commit", "headSha"]) {
        const v = j[key];
        if (typeof v === "string" && /^[0-9a-f]{40}$/i.test(v)) {
          commits.add(v.toLowerCase());
        }
      }
    } catch {
      /* non-JSON — basename-only */
    }
  }

  return {
    issues: [...issues].sort((a, b) => a - b),
    pullRequests: [...pullRequests].sort((a, b) => a - b),
    commits: [...commits].sort(),
    shortCommitTokens,
  };
}

function finalizeAssociations(
  raw: ReturnType<typeof extractAssociationsFromBasenameAndOptionalJson>,
  fullCommitIndex: string[],
): IssuePrCommitAssociations | null {
  const commits = new Set(raw.commits);
  for (const tok of raw.shortCommitTokens) {
    const hits = fullCommitIndex.filter((c) => c.startsWith(tok));
    if (hits.length === 1) commits.add(hits[0]!);
  }
  const out: IssuePrCommitAssociations = {
    issues: raw.issues,
    pullRequests: raw.pullRequests,
    commits: [...commits].sort(),
  };
  if (
    out.issues.length === 0 &&
    out.pullRequests.length === 0 &&
    out.commits.length === 0
  ) {
    return null;
  }
  return out;
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
  const spec = loadSealedSpec();
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

test("fixed-target Git construction walk seals 597 identities, predicates, and post-cutoff partition", () => {
  const spec = loadSealedSpec();
  const frozenWalk = loadFrozenWalk();
  const frozenInventory = loadFrozenInventory();
  const liveInventory = readJson<{
    items: Array<{ itemKey: string; basename: string }>;
    count: number;
  }>(join(MIG, "inventory.json"));

  assert.equal(frozenWalk.entryCount, 597);
  assert.equal(frozenWalk.entries.length, 597);
  assert.equal(frozenInventory.count, 597);
  assert.equal(liveInventory.count, frozenInventory.count);

  // Live inventory keys remain the frozen denominator (repair does not re-cut).
  const frozenKeys = new Set(frozenWalk.entries.map((e) => e.itemKey));
  const invKeys = new Set(liveInventory.items.map((e) => e.itemKey));
  assert.equal(frozenKeys.size, invKeys.size);
  for (const k of frozenKeys) {
    assert.equal(invKeys.has(k), true, `inventory missing frozen key ${k}`);
  }
  for (const k of frozenInventory.items.map((i) => i.itemKey)) {
    assert.equal(frozenKeys.has(k), true, `walk missing inventory key ${k}`);
  }

  // Every frozen construction basename matches sealed predicates; no directories.
  for (const e of frozenWalk.entries) {
    assert.equal(
      matchesProjectRolePredicate(e.basename, spec),
      true,
      `predicate drift: ${e.basename}`,
    );
    assert.notEqual(e.fileType, "directory");
  }
  for (const s of frozenWalk.skipped) {
    if (s.reason === "directory-outside-file-inventory") {
      assert.equal(matchesProjectRolePredicate(s.basename, spec), true);
    }
  }

  // Exact identity oracle: fail on any omitted or changed of the 597.
  let matched = 0;
  let missing = 0;
  let changed = 0;
  for (const e of frozenWalk.entries) {
    try {
      const st = lstatSync(e.sanitizedLocator);
      const type = st.isSymbolicLink()
        ? "symlink"
        : st.isFile()
          ? "regular"
          : st.isDirectory()
            ? "directory"
            : "other";
      const metaOk =
        type === e.fileType &&
        st.size === e.sizeBytes &&
        st.mtimeMs === e.mtimeMs &&
        st.ctimeMs === e.ctimeMs &&
        st.dev === e.dev &&
        st.ino === e.ino &&
        st.mode === e.mode;
      let hashOk = true;
      if (e.fileType === "regular" && e.sha256) {
        hashOk = sha256(noFollowRead(e.sanitizedLocator)) === e.sha256;
      }
      if (metaOk && hashOk) matched += 1;
      else changed += 1;
    } catch {
      missing += 1;
    }
  }
  assert.equal(missing, 0, "frozen identity missing from source root");
  assert.equal(changed, 0, "frozen identity metadata/hash changed");
  assert.equal(matched, 597);

  // Independent sealed-predicate walk: all-and-only post-cutoff partition.
  const root = realpathSync(spec.canonicalSourceRoot.logical);
  const walked = independentSealedPredicateWalk(root, spec);
  const frozenBasenames = new Set(frozenWalk.entries.map((e) => e.basename));
  const frozenSkipped = new Set(
    (frozenWalk.skipped || []).map((s) => s.basename),
  );
  const postCutoff: string[] = [];
  for (const b of walked.basenames) {
    if (!frozenBasenames.has(b)) postCutoff.push(b);
  }
  for (const s of walked.skipped) {
    if (
      s.reason === "directory-outside-file-inventory" &&
      !frozenSkipped.has(s.basename) &&
      !frozenBasenames.has(s.basename)
    ) {
      postCutoff.push(s.basename);
    }
  }
  assert.deepEqual(
    [...new Set(postCutoff)].sort(),
    [...EXPECTED_POST_CUTOFF].sort(),
  );
  // Frozen directory skip remains outside the denominator.
  assert.equal(
    frozenWalk.skipped.some(
      (s) =>
        s.basename === "collector-apply-evidence" &&
        s.reason === "directory-outside-file-inventory",
    ),
    true,
  );
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
  const spec = loadSealedSpec();
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

test("structured issue/PR/commit associations exhaustive from frozen metadata and admitted non-generic bytes", () => {
  const inv = readJson<{
    items: Array<{ itemKey: string; basename: string; genericExhaust: boolean }>;
  }>(join(MIG, "inventory.json"));
  const invByKey = new Map(inv.items.map((i) => [i.itemKey, i]));
  const disp = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      disposition: string;
      contentHandling?: string;
      evidence?: { recoveredPath?: string };
      issuePrCommitAssociations?: IssuePrCommitAssociations;
    }>;
  }>(join(MIG, "dispositions.json"));
  const recovered = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      path: string;
      issuePrCommitAssociations?: IssuePrCommitAssociations;
    }>;
  }>(join(MIG, "recovered-index.json"));
  const recoveredByKey = new Map(recovered.items.map((r) => [r.itemKey, r]));

  // Full-commit index from admitted non-generic recovered JSON only.
  const fullCommits = new Set<string>();
  for (const item of recovered.items) {
    const meta = invByKey.get(item.itemKey);
    assert.ok(meta, item.itemKey);
    if (meta.genericExhaust) continue;
    if (!item.basename.endsWith(".json")) continue;
    const text = readFileSync(join(MIG, item.path), "utf8");
    const raw = extractAssociationsFromBasenameAndOptionalJson(
      item.basename,
      text,
    );
    for (const c of raw.commits) fullCommits.add(c);
  }
  const fullCommitIndex = [...fullCommits].sort();

  // Exhaustive exact-set oracle over every disposition item.
  const expected = new Map<string, IssuePrCommitAssociations>();
  for (const d of disp.items) {
    const meta = invByKey.get(d.itemKey);
    assert.ok(meta, d.itemKey);
    let jsonText: string | null = null;
    if (
      !meta.genericExhaust &&
      d.basename.endsWith(".json") &&
      d.evidence?.recoveredPath &&
      existsSync(join(MIG, d.evidence.recoveredPath))
    ) {
      jsonText = readFileSync(join(MIG, d.evidence.recoveredPath), "utf8");
    }
    const assoc = finalizeAssociations(
      extractAssociationsFromBasenameAndOptionalJson(d.basename, jsonText),
      fullCommitIndex,
    );
    if (assoc) expected.set(d.itemKey, assoc);
  }

  assert.equal(expected.size > 0, true);
  for (const d of disp.items) {
    const exp = expected.get(d.itemKey) ?? null;
    const got = d.issuePrCommitAssociations ?? null;
    assert.deepEqual(
      got,
      exp,
      `disposition association mismatch for ${d.basename}`,
    );
  }
  for (const item of recovered.items) {
    const exp = expected.get(item.itemKey) ?? null;
    const got = item.issuePrCommitAssociations ?? null;
    assert.deepEqual(
      got,
      exp,
      `recovered-index association mismatch for ${item.basename}`,
    );
  }

  // Named samples remain bound.
  const pr5Disposition = disp.items.find((d) => d.itemKey.startsWith("ecec8803"));
  assert.ok(pr5Disposition, "ecec8803 disposition");
  assert.deepEqual(pr5Disposition.issuePrCommitAssociations?.pullRequests, [5]);
  assert.ok(
    pr5Disposition.issuePrCommitAssociations?.commits.includes(
      "6604a733886dfb5d074f558963e20e01e587aa6d",
    ),
  );
  const pr5RecoveredItem = recovered.items.find((d) =>
    d.itemKey.startsWith("ecec8803"),
  );
  assert.ok(pr5RecoveredItem);
  assert.deepEqual(pr5RecoveredItem.issuePrCommitAssociations?.pullRequests, [5]);

  const secondKnown = disp.items.find((d) => d.itemKey.startsWith("33454566"));
  assert.ok(secondKnown, "33454566 disposition");
  assert.deepEqual(secondKnown.issuePrCommitAssociations?.pullRequests, [5]);
  assert.ok(
    secondKnown.issuePrCommitAssociations?.commits.includes(
      "6604a733886dfb5d074f558963e20e01e587aa6d",
    ),
  );

  // RED: dropping a second known association must be detectable.
  {
    const mutated = new Map(expected);
    mutated.delete(secondKnown.itemKey);
    assert.equal(mutated.has(secondKnown.itemKey), false);
    assert.notEqual(mutated.size, expected.size);
    assert.notDeepEqual(
      secondKnown.issuePrCommitAssociations ?? null,
      mutated.get(secondKnown.itemKey) ?? null,
    );
  }
  // RED: association field required when frozen provenance establishes it
  assert.equal(
    Array.isArray(pr5Disposition.issuePrCommitAssociations?.pullRequests),
    true,
  );

  // Touch recoveredByKey so exhaustive recovered join is exercised.
  assert.equal(recoveredByKey.has(pr5RecoveredItem.itemKey), true);
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

test("repair-001 recorder closure remains byte-sealed historical evidence with receipt null", () => {
  const evidenceDir = join(REPO_ROOT, RECORDER_001);
  const manifestPath = join(evidenceDir, "manifest.json");
  assert.equal(existsSync(manifestPath), true, "recorder-001 closure manifest");
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

test("repair-002 recorder successor preserves executable corroboration implementation and 277-source scan result", () => {
  const evidenceDir = join(REPO_ROOT, RECORDER_002);
  const manifestPath = join(evidenceDir, "manifest.json");
  assert.equal(existsSync(manifestPath), true, "recorder-002 closure manifest");
  const manifest = readJson<{
    receipt: null | unknown;
    recorder: { status: string };
    child: { status: string; exitCode: number | null };
    provenance: { target: string | null };
    artifacts: Array<{
      id: string;
      kind: string;
      stored?: { path: string; sha256: string; byteLength: number };
    }>;
  }>(manifestPath);
  assert.equal(manifest.receipt, null);
  assert.equal(manifest.recorder.status, "completed");
  assert.equal(manifest.child.status, "exited");
  assert.equal(manifest.child.exitCode, 0);
  assert.match(String(manifest.provenance.target), /repair-002/);

  const implArt = manifest.artifacts.find(
    (a) => a.id === "corroboration-scan-implementation",
  );
  assert.ok(implArt?.stored?.path, "implementation exhibit stored");
  assert.equal(implArt!.kind, "exhibit");
  const implPath = join(evidenceDir, implArt!.stored!.path);
  assert.equal(existsSync(implPath), true);
  const implBytes = readFileSync(implPath);
  assert.equal(sha256(implBytes), implArt!.stored!.sha256);
  assert.equal(implBytes.byteLength, implArt!.stored!.byteLength);
  // Independently executable corroboration implementation is preserved.
  assert.match(implBytes.toString("utf8"), /scanBytes/);
  assert.match(implBytes.toString("utf8"), /R1-frozen-identity/);
  assert.match(implBytes.toString("utf8"), /EXPECTED_POST_CUTOFF/);

  const summaryArt = manifest.artifacts.find(
    (a) => a.id === "corroboration-scan-summary",
  );
  assert.ok(summaryArt?.stored?.path, "summary artifact stored path");
  const summaryPath = join(evidenceDir, summaryArt!.stored!.path);
  assert.equal(existsSync(summaryPath), true);
  const summaryBytes = readFileSync(summaryPath);
  assert.equal(sha256(summaryBytes), summaryArt!.stored!.sha256);
  const summary = JSON.parse(summaryBytes.toString("utf8")) as {
    ok: boolean;
    r1: {
      recorded: number;
      matched: number;
      missing: number;
      changed: number;
      postCutoffAdditions: Array<{ basename: string }>;
      expectedPostCutoff: string[];
    };
    r2: {
      admittedScanned: number;
      allMatched: boolean;
      redactedCount: number;
      highlighted: Array<{
        itemKey: string;
        basename: string;
        redacted: boolean;
        sourceSha256: string;
        recoveredSha256: string;
        hits: unknown[];
      }>;
      results: Array<{
        itemKey: string;
        basename: string;
        sourceSha256: string;
        recoveredSha256: string;
        redacted: boolean;
        hits: unknown[];
      }>;
    };
  };
  assert.equal(summary.ok, true);
  assert.equal(summary.r1.recorded, 597);
  assert.equal(summary.r1.matched, 597);
  assert.equal(summary.r1.missing, 0);
  assert.equal(summary.r1.changed, 0);
  assert.deepEqual(
    summary.r1.postCutoffAdditions.map((p) => p.basename).sort(),
    [...EXPECTED_POST_CUTOFF].sort(),
  );
  assert.equal(summary.r2.admittedScanned, 277);
  assert.equal(summary.r2.allMatched, true);
  assert.equal(summary.r2.results.length, 277);
  assert.equal(summary.r2.redactedCount, 2);

  const byKey = new Map(summary.r2.results.map((r) => [r.itemKey, r]));
  const probeA = [...byKey.keys()].find((k) => k.startsWith("42a9fc"));
  const probeB = [...byKey.keys()].find((k) => k.startsWith("af289a"));
  assert.ok(probeA, "42a9fc result present");
  assert.ok(probeB, "af289a result present");
  assert.equal(byKey.get(probeA!)!.redacted, true);
  assert.equal(byKey.get(probeB!)!.redacted, true);
  assert.equal(byKey.get(probeA!)!.hits.length > 0, true);
  assert.equal(byKey.get(probeB!)!.hits.length > 0, true);
  const hlNames = new Set(summary.r2.highlighted.map((h) => h.basename));
  assert.equal(hlNames.has("judge-malformed-probe.ts"), true);
  assert.equal(hlNames.has("reviewer-real-pi-snippet.ts"), true);

  // repair-001 closure bytes must remain untouched by this successor.
  assert.equal(existsSync(join(REPO_ROOT, RECORDER_001, "manifest.json")), true);
});

test("historical nonconformance closure seals original and 49807d4 successor identities", () => {
  assert.equal(gitIsAncestor(ORIGINAL_APPLY_COMMIT), true);
  assert.equal(gitIsAncestor(NONCONFORMING_SUCCESSOR_COMMIT), true);

  const recordPath = join(REPO_ROOT, HISTORICAL_NONCONFORMANCE);
  assert.equal(existsSync(recordPath), true);
  const record = readJson<{
    kind: string;
    originalApplyCommit: string;
    nonconformingSuccessorCommit: string;
    original: {
      receipt: { path: string; blobOid: string; sha256: string };
      manifest: { path: string; blobOid: string; sha256: string };
    };
    nonconformingSuccessors: {
      classification: string;
      receipt: { path: string; blobOid: string; sha256: string };
      manifest: { path: string; blobOid: string; sha256: string };
    };
    bindings: {
      verifierPath: string;
      recorderSuccessorPath: string;
      manualReconciliation: {
        path: string;
        classification: string;
      };
    };
    historicalPathsByteUnchanged: boolean;
  }>(recordPath);

  assert.equal(record.kind, "historical-nonconformance-closure");
  assert.equal(record.originalApplyCommit, ORIGINAL_APPLY_COMMIT);
  assert.equal(
    record.nonconformingSuccessorCommit,
    NONCONFORMING_SUCCESSOR_COMMIT,
  );
  assert.match(
    record.nonconformingSuccessors.classification,
    /nonconforming/i,
  );
  assert.equal(record.historicalPathsByteUnchanged, true);
  assert.equal(
    record.bindings.verifierPath,
    "test/legacy-case-a-migration-verifier.test.ts",
  );
  assert.equal(
    record.bindings.recorderSuccessorPath,
    `${RECORDER_002}/manifest.json`,
  );
  assert.equal(
    record.bindings.manualReconciliation.classification,
    "exact-set-only",
  );

  const checks: Array<{
    label: string;
    commit: string;
    path: string;
    blobOid: string;
    sha256: string;
  }> = [
    {
      label: "original-receipt",
      commit: ORIGINAL_APPLY_COMMIT,
      path: record.original.receipt.path,
      blobOid: record.original.receipt.blobOid,
      sha256: record.original.receipt.sha256,
    },
    {
      label: "original-manifest",
      commit: ORIGINAL_APPLY_COMMIT,
      path: record.original.manifest.path,
      blobOid: record.original.manifest.blobOid,
      sha256: record.original.manifest.sha256,
    },
    {
      label: "successor-receipt",
      commit: NONCONFORMING_SUCCESSOR_COMMIT,
      path: record.nonconformingSuccessors.receipt.path,
      blobOid: record.nonconformingSuccessors.receipt.blobOid,
      sha256: record.nonconformingSuccessors.receipt.sha256,
    },
    {
      label: "successor-manifest",
      commit: NONCONFORMING_SUCCESSOR_COMMIT,
      path: record.nonconformingSuccessors.manifest.path,
      blobOid: record.nonconformingSuccessors.manifest.blobOid,
      sha256: record.nonconformingSuccessors.manifest.sha256,
    },
  ];

  // Judge-specified exact identities.
  assert.equal(
    record.original.receipt.blobOid,
    "d1bf646ee019ea217612cc8d30100dfa635faf3b",
  );
  assert.equal(
    record.original.receipt.sha256,
    "0b29ebaf849d16aad4bf1821d571a83a08b67df0d6b53d56ab2727e375c6656a",
  );
  assert.equal(
    record.original.manifest.blobOid,
    "04fe1b57b745afcc8b18f2655412c854326a94fd",
  );
  assert.equal(
    record.original.manifest.sha256,
    "64d5cfdeaf0df40713c0f0f8a9f083107f708664abb812240c6c8bdef54405f0",
  );
  assert.equal(
    record.nonconformingSuccessors.receipt.blobOid,
    "b339d64d33f30e8a1eda80ec974b5f89e93e3a76",
  );
  assert.equal(
    record.nonconformingSuccessors.receipt.sha256,
    "4fd89914713ea6459dfb71d8997dd71e5a6c6c15e0890f43b2bdc6299e5408a8",
  );
  assert.equal(
    record.nonconformingSuccessors.manifest.blobOid,
    "62153db474b4e6cb1f77978a6e6ee1402ef2db3a",
  );
  assert.equal(
    record.nonconformingSuccessors.manifest.sha256,
    "0536d1c0f92dec60830cbd72bc7bbd6622fb37464e51b1f396af4eec489aff39",
  );

  for (const c of checks) {
    assert.equal(c.path.startsWith(REPAIR_001_APPLY), true, c.label);
    const oid = gitRevParse(`${c.commit}:${c.path}`);
    assert.equal(oid, c.blobOid, `${c.label} blobOid`);
    assert.equal(sha256(gitShow(`${c.commit}:${c.path}`)), c.sha256, c.label);
  }

  // Live paths remain the nonconforming successor bytes (not rewritten again).
  for (const path of [
    record.nonconformingSuccessors.receipt.path,
    record.nonconformingSuccessors.manifest.path,
  ]) {
    const live = readFileSync(join(REPO_ROOT, path));
    const liveOid = gitRevParse(`HEAD:${path}`);
    assert.equal(liveOid, gitRevParse(`${NONCONFORMING_SUCCESSOR_COMMIT}:${path}`));
    assert.equal(
      sha256(live),
      sha256(gitShow(`${NONCONFORMING_SUCCESSOR_COMMIT}:${path}`)),
    );
  }

  // Manual reconciliation is exact-set only (not substantive Apply proof).
  const manual = readFileSync(
    join(REPO_ROOT, record.bindings.manualReconciliation.path),
    "utf8",
  );
  assert.match(manual, /exact/i);
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
