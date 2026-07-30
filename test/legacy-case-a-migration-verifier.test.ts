/**
 * Seam-owned verifier for issue #15 Case A legacy /tmp migration artifacts.
 * Fixed-target Git verification against immutable ea64733… plus live repaired tree.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
const REPAIR_002_COMMIT =
  "da250445d09ef2b9105a99590f2ccda0a8db29c4";
const RECORDER_001 =
  ".ak/dockets/issues/15/repair/repair-001/recorder-closure";
const RECORDER_002 =
  ".ak/dockets/issues/15/repair/repair-002/recorder-closure";
const RECORDER_003 =
  ".ak/dockets/issues/15/repair/repair-003/recorder-closure";
const HISTORICAL_NONCONFORMANCE =
  ".ak/dockets/issues/15/repair/repair-002/historical-nonconformance.json";

const REPAIR_002_IMPL_SHA =
  "fd219ea9e1d43aae383d67a0289a92612726980e62b6a1aaf97fdacb19411576";
const REPAIR_002_RESULT_SHA =
  "654fdff4002b26cdaf08586b722aff6688b8c19b08752a62d329a84ef40e9a70";

const SOLE_REPO_NAMESPACE = "github.com/Akagilnc/ak-pi-workflow-roles";
const SOLE_URL_PREFIX =
  "https://github.com/Akagilnc/ak-pi-workflow-roles/";
const ASSOCIATION_ROOTS = [
  IMMUTABLE,
  ORIGINAL_APPLY_COMMIT,
  NONCONFORMING_SUCCESSOR_COMMIT,
  REPAIR_002_COMMIT,
] as const;

const NAMESPACE_ISSUE_SNAPSHOT =
  ".ak/dockets/issues/15/authority/judge-003/inputs/issue-snapshot";
const NAMESPACE_DISCOVERY_SPEC =
  `${IMMUTABLE_MIG_PREFIX}/discovery-spec.v1.json`;

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
  authorizedRepositories?: Array<{ remoteHint?: string }>;
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

/** Exact candidate identity used by the sealed cutoff oracle (not basename alone). */
type CandidateIdentity = {
  basename: string;
  fileType: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  sha256: string | null;
  itemKey?: string;
};

type GitTuple = {
  repository: string;
  commit: string;
  path: string;
  blobOid: string;
  sha256: string;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const LIVE_SOURCE_UNIVERSE_AVAILABLE =
  process.env.AK_LEGACY_CASE_A_LIVE_SOURCE !== "0" &&
  readJson<{
    entries: FrozenWalkEntry[];
  }>(join(MIG, "construction-walk.json")).entries.every((entry) =>
    existsSync(entry.sanitizedLocator),
  );

function liveSourceTest(name: string, fn: () => void): void {
  test(
    name,
    {
      skip: LIVE_SOURCE_UNIVERSE_AVAILABLE
        ? false
        : "volatile Case-A source universe is unavailable on this host",
    },
    fn,
  );
}

function sha256(buf: Buffer | string): string {
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

function gitTuple(commit: string, path: string): GitTuple {
  const blobOid = gitRevParse(`${commit}:${path}`);
  const digest = sha256(gitShow(`${commit}:${path}`));
  return {
    repository: SOLE_REPO_NAMESPACE,
    commit,
    path,
    blobOid,
    sha256: digest,
  };
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
  items: Array<{
    itemKey: string;
    basename: string;
    genericExhaust?: boolean;
    provenanceClass?: string;
    classificationReasonCode?: string;
  }>;
  count: number;
} {
  return JSON.parse(
    gitShow(`${IMMUTABLE}:${IMMUTABLE_MIG_PREFIX}/inventory.json`).toString(
      "utf8",
    ),
  ) as {
    items: Array<{
      itemKey: string;
      basename: string;
      genericExhaust?: boolean;
      provenanceClass?: string;
      classificationReasonCode?: string;
    }>;
    count: number;
  };
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
): {
  basenames: string[];
  candidates: CandidateIdentity[];
  skipped: Array<{ basename: string; reason: string }>;
} {
  assert.equal(spec.canonicalSourceRoot.topLevelOnly, true);
  assert.equal(spec.filesystemBoundaries.followSymlinks, false);
  const basenames: string[] = [];
  const candidates: CandidateIdentity[] = [];
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
    const fileType = st.isSymbolicLink()
      ? "symlink"
      : st.isDirectory()
        ? "directory"
        : st.isFile()
          ? "regular"
          : "other";
    let digest: string | null = null;
    if (fileType === "regular") {
      digest = sha256(noFollowRead(join(root, basename)));
    }
    const candidate: CandidateIdentity = {
      basename,
      fileType,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      dev: st.dev,
      ino: st.ino,
      mode: st.mode,
      sha256: digest,
    };
    if (digest) candidate.itemKey = digest;
    candidates.push(candidate);
  }
  return { basenames, candidates, skipped };
}

function candidateMatchesFrozenIdentity(
  candidate: CandidateIdentity,
  frozen: FrozenWalkEntry,
): boolean {
  if (candidate.itemKey && candidate.itemKey === frozen.itemKey) return true;
  return (
    candidate.fileType === frozen.fileType &&
    candidate.sizeBytes === frozen.sizeBytes &&
    candidate.mtimeMs === frozen.mtimeMs &&
    candidate.ctimeMs === frozen.ctimeMs &&
    candidate.dev === frozen.dev &&
    candidate.ino === frozen.ino &&
    candidate.mode === frozen.mode &&
    (candidate.sha256 ?? null) === (frozen.sha256 ?? null)
  );
}

/**
 * Single sealed cutoff oracle: post-cutoff iff candidate matches sealed
 * discovery predicates/filesystem class and is absent from the frozen
 * construction identity set. Basename alone never establishes post-cutoff.
 */
function isPostCutoffAddition(
  candidate: CandidateIdentity,
  frozenEntries: FrozenWalkEntry[],
  frozenItemKeys: Set<string>,
  spec: SealedSpec,
): boolean {
  if (!matchesProjectRolePredicate(candidate.basename, spec)) return false;
  if (candidate.itemKey && frozenItemKeys.has(candidate.itemKey)) return false;
  for (const frozen of frozenEntries) {
    if (candidateMatchesFrozenIdentity(candidate, frozen)) return false;
  }
  return true;
}

function partitionPostCutoff(
  candidates: CandidateIdentity[],
  frozenEntries: FrozenWalkEntry[],
  frozenItemKeys: Set<string>,
  spec: SealedSpec,
): CandidateIdentity[] {
  return candidates.filter((c) =>
    isPostCutoffAddition(c, frozenEntries, frozenItemKeys, spec),
  );
}

/* -------------------------------------------------------------------------- */
/* R2 closed association grammar                                              */
/* -------------------------------------------------------------------------- */

const RE_N = "[1-9][0-9]*";
const RE_H = "[0-9A-Fa-f]{7,40}";
const RE_NON_B = "[^A-Za-z0-9_]";
const RE_URL_CHAR = "A-Za-z0-9._~:/?#@!$&'()*+,;=%\\-";
const RE_NON_URL = `[^${RE_URL_CHAR}]`;

const BASENAME_ISSUE_RE = new RegExp(
  `(?:^|[-_.])issue[-_](${RE_N})(?=$|[-_.])`,
  "gi",
);
const BASENAME_PR_RE = new RegExp(
  `(?:^|[-_.])pr[-_](${RE_N})(?=$|[-_.])`,
  "gi",
);
const TEXT_LABEL_RE = new RegExp(
  `(?:^|${RE_NON_B})(issue|pr|pull[ \\t]+request)[ \\t]+#?(${RE_N})(?=$|[^0-9])`,
  "gi",
);
const QUALIFIED_URL_RE = new RegExp(
  `(?:^|${RE_NON_URL})https://github\\.com/akagilnc/ak-pi-workflow-roles/(issues|pull)/(${RE_N})(?=$|[?#]|${RE_NON_URL})`,
  "gi",
);
const COMMIT_LABEL_RE = new RegExp(
  `(?:^|${RE_NON_B})(commit|commitOid|commitSha|headSha|reviewedHead|targetHead)[ \\t]*[:=][ \\t]*(${RE_H})(?=$|[^A-Za-z0-9])`,
  "gi",
);
const EXACT_N_RE = new RegExp(`^${RE_N}$`);
const EXACT_H_RE = new RegExp(`^${RE_H}$`);

const ISSUE_STRUCT_KEYS = new Set(
  ["issue", "issueNumber", "issue_number"].map((s) => s.toLowerCase()),
);
const PR_STRUCT_KEYS = new Set(
  [
    "pr",
    "prNumber",
    "pr_number",
    "pullRequest",
    "pullRequestNumber",
    "pull_request",
  ].map((s) => s.toLowerCase()),
);
const COMMIT_STRUCT_KEYS = new Set(
  [
    "commit",
    "commitOid",
    "commitSha",
    "headSha",
    "reviewedHead",
    "targetHead",
  ].map((s) => s.toLowerCase()),
);

let cachedCommitUniverse: Set<string> | null = null;

function loadCommitUniverse(): Set<string> {
  if (cachedCommitUniverse) return cachedCommitUniverse;
  const set = new Set<string>();
  for (const root of ASSOCIATION_ROOTS) {
    const out = execFileSync("git", ["-C", REPO_ROOT, "rev-list", root], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      const c = line.trim();
      if (c) set.add(c);
    }
  }
  cachedCommitUniverse = set;
  return set;
}

function resolveCommitToken(
  token: string,
  universe: Set<string>,
): string | null {
  const t = token.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(t)) return null;
  if (t.length === 40) return t;
  const hits: string[] = [];
  for (const c of universe) {
    if (c.startsWith(t)) hits.push(c);
    if (hits.length > 1) return null;
  }
  return hits.length === 1 ? hits[0]! : null;
}

function scanTextAssociations(
  text: string,
  issues: Set<number>,
  pullRequests: Set<number>,
  commits: Set<string>,
  universe: Set<string>,
): void {
  TEXT_LABEL_RE.lastIndex = 0;
  for (const m of text.matchAll(TEXT_LABEL_RE)) {
    const kind = m[1]!.toLowerCase().replace(/[ \t]+/g, " ");
    const n = Number(m[2]);
    if (kind === "issue") issues.add(n);
    else pullRequests.add(n);
  }
  QUALIFIED_URL_RE.lastIndex = 0;
  for (const m of text.matchAll(QUALIFIED_URL_RE)) {
    const kind = m[1]!.toLowerCase();
    const n = Number(m[2]);
    if (kind === "issues") issues.add(n);
    else pullRequests.add(n);
  }
  COMMIT_LABEL_RE.lastIndex = 0;
  for (const m of text.matchAll(COMMIT_LABEL_RE)) {
    const resolved = resolveCommitToken(m[2]!, universe);
    if (resolved) commits.add(resolved);
  }
}

function isPositiveSafeInteger(v: unknown): v is number {
  if (typeof v === "boolean") return false;
  if (typeof v === "number") {
    return (
      Number.isInteger(v) &&
      v >= 1 &&
      v <= Number.MAX_SAFE_INTEGER
    );
  }
  return false;
}

function walkJsonAssociations(
  value: unknown,
  issues: Set<number>,
  pullRequests: Set<number>,
  commits: Set<string>,
  universe: Set<string>,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    scanTextAssociations(value, issues, pullRequests, commits, universe);
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) {
      walkJsonAssociations(el, issues, pullRequests, commits, universe);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "issuePrCommitAssociations") continue;
    const kl = k.toLowerCase();
    if (isPositiveSafeInteger(v)) {
      if (ISSUE_STRUCT_KEYS.has(kl)) issues.add(v);
      else if (PR_STRUCT_KEYS.has(kl)) pullRequests.add(v);
    }
    if (typeof v === "string") {
      if (ISSUE_STRUCT_KEYS.has(kl) && EXACT_N_RE.test(v)) {
        issues.add(Number(v));
      } else if (PR_STRUCT_KEYS.has(kl) && EXACT_N_RE.test(v)) {
        pullRequests.add(Number(v));
      } else if (COMMIT_STRUCT_KEYS.has(kl) && EXACT_H_RE.test(v)) {
        const resolved = resolveCommitToken(v, universe);
        if (resolved) commits.add(resolved);
      }
      scanTextAssociations(v, issues, pullRequests, commits, universe);
    } else if (v !== null && typeof v === "object") {
      walkJsonAssociations(v, issues, pullRequests, commits, universe);
    }
  }
}

/**
 * Closed association extractor over basename + optional admitted non-generic
 * payload text. Never opens generic payloads (caller must pass text=null).
 */
function extractAssociationsClosed(
  basename: string,
  text: string | null,
  asJson: boolean,
  universe: Set<string> = loadCommitUniverse(),
): IssuePrCommitAssociations | null {
  const issues = new Set<number>();
  const pullRequests = new Set<number>();
  const commits = new Set<string>();

  BASENAME_ISSUE_RE.lastIndex = 0;
  for (const m of basename.matchAll(BASENAME_ISSUE_RE)) {
    issues.add(Number(m[1]));
  }
  BASENAME_PR_RE.lastIndex = 0;
  for (const m of basename.matchAll(BASENAME_PR_RE)) {
    pullRequests.add(Number(m[1]));
  }

  if (text !== null) {
    if (asJson) {
      try {
        const parsed: unknown = JSON.parse(text);
        walkJsonAssociations(parsed, issues, pullRequests, commits, universe);
      } catch {
        scanTextAssociations(text, issues, pullRequests, commits, universe);
      }
    } else {
      scanTextAssociations(text, issues, pullRequests, commits, universe);
    }
  }

  if (issues.size === 0 && pullRequests.size === 0 && commits.size === 0) {
    return null;
  }
  return {
    issues: [...issues].sort((a, b) => a - b),
    pullRequests: [...pullRequests].sort((a, b) => a - b),
    commits: [...commits].sort(),
  };
}

function associationsEqual(
  a: IssuePrCommitAssociations | null | undefined,
  b: IssuePrCommitAssociations | null | undefined,
): boolean {
  const norm = (x: IssuePrCommitAssociations | null | undefined) =>
    x ?? null;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function loadNamespaceBinding(): {
  namespace: string;
  issueSnapshot: GitTuple;
  discoverySpec: GitTuple;
} {
  const issueSnapshot = gitTuple(IMMUTABLE, NAMESPACE_ISSUE_SNAPSHOT);
  const discoverySpec = gitTuple(IMMUTABLE, NAMESPACE_DISCOVERY_SPEC);
  const snap = JSON.parse(gitShow(`${IMMUTABLE}:${NAMESPACE_ISSUE_SNAPSHOT}`).toString("utf8")) as {
    repository_url?: string;
    html_url?: string;
  };
  const spec = loadSealedSpec();
  const fromRepoApi = String(snap.repository_url ?? "").match(
    /github\.com\/repos\/([^/]+)\/([^/]+)/i,
  );
  const fromHtml = String(snap.html_url ?? "").match(
    /github\.com\/([^/]+)\/([^/]+)/i,
  );
  assert.ok(fromRepoApi, "repository_url owner/repo");
  assert.ok(fromHtml, "html_url owner/repo");
  const nsFromRepo = `github.com/${fromRepoApi![1]}/${fromRepoApi![2]}`;
  const nsFromHtml = `github.com/${fromHtml![1]}/${fromHtml![2]}`;
  const canon = (s: string) =>
    s.replace(/^github\.com\//i, "github.com/").toLowerCase();
  assert.equal(canon(nsFromRepo), canon(SOLE_REPO_NAMESPACE));
  assert.equal(canon(nsFromHtml), canon(SOLE_REPO_NAMESPACE));
  const remoteHint = spec.authorizedRepositories?.[0]?.remoteHint ?? "";
  assert.equal(remoteHint, "Akagilnc/ak-pi-workflow-roles");
  // Canonical sole namespace — no ambient remote.
  assert.equal(SOLE_REPO_NAMESPACE, "github.com/Akagilnc/ak-pi-workflow-roles");
  assert.equal(
    SOLE_URL_PREFIX.startsWith("https://github.com/Akagilnc/ak-pi-workflow-roles/"),
    true,
  );
  return { namespace: SOLE_REPO_NAMESPACE, issueSnapshot, discoverySpec };
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

function loadAdmittedSourceText(
  d: {
    itemKey: string;
    basename: string;
    evidence?: {
      reference?: { commitSha: string; path: string };
      recoveredPath?: string;
    };
  },
  meta: { genericExhaust?: boolean },
): { text: string | null; asJson: boolean } {
  if (meta.genericExhaust) {
    return { text: null, asJson: false };
  }
  let raw: Buffer | null = null;
  const ref = d.evidence?.reference;
  if (ref) {
    raw = gitShow(`${ref.commitSha}:${ref.path}`);
  } else if (d.evidence?.recoveredPath) {
    const abs = join(MIG, d.evidence.recoveredPath);
    if (existsSync(abs)) raw = readFileSync(abs);
  }
  if (!raw) return { text: null, asJson: false };
  const text = raw.toString("utf8");
  const asJson = d.basename.toLowerCase().endsWith(".json");
  return { text, asJson };
}

function deriveExpectedAssociations(): Map<
  string,
  IssuePrCommitAssociations | null
> {
  const universe = loadCommitUniverse();
  const frozenInv = loadFrozenInventory();
  const invByKey = new Map(frozenInv.items.map((i) => [i.itemKey, i]));
  // Prefer live inventory genericity if present (same keys).
  const liveInv = readJson<{
    items: Array<{ itemKey: string; basename: string; genericExhaust: boolean }>;
  }>(join(MIG, "inventory.json"));
  for (const i of liveInv.items) {
    invByKey.set(i.itemKey, i);
  }
  const disp = readJson<{
    items: Array<{
      itemKey: string;
      basename: string;
      evidence?: {
        reference?: { commitSha: string; path: string };
        recoveredPath?: string;
      };
    }>;
  }>(join(MIG, "dispositions.json"));

  const expected = new Map<string, IssuePrCommitAssociations | null>();
  for (const d of disp.items) {
    const meta = invByKey.get(d.itemKey) ?? {
      itemKey: d.itemKey,
      basename: d.basename,
      genericExhaust: true,
    };
    const { text, asJson } = loadAdmittedSourceText(d, meta);
    expected.set(
      d.itemKey,
      extractAssociationsClosed(d.basename, text, asJson, universe),
    );
  }
  return expected;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test("immutable migration target ea64733 is an ancestor and readable via Git", () => {
  assert.equal(gitIsAncestor(IMMUTABLE), true);
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.notEqual(head, IMMUTABLE);
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

liveSourceTest("fixed-target Git construction walk seals 597 identities, predicates, and cutoff-derived partition", () => {
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

  const frozenKeys = new Set(frozenWalk.entries.map((e) => e.itemKey));
  const invKeys = new Set(liveInventory.items.map((e) => e.itemKey));
  assert.equal(frozenKeys.size, invKeys.size);
  for (const k of frozenKeys) {
    assert.equal(invKeys.has(k), true, `inventory missing frozen key ${k}`);
  }
  for (const k of frozenInventory.items.map((i) => i.itemKey)) {
    assert.equal(frozenKeys.has(k), true, `walk missing inventory key ${k}`);
  }

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

  // Cutoff-derived all-and-only partition via identity oracle (not basename allowlist).
  const root = realpathSync(spec.canonicalSourceRoot.logical);
  const walked = independentSealedPredicateWalk(root, spec);
  const postCutoff = partitionPostCutoff(
    walked.candidates,
    frozenWalk.entries,
    frozenKeys,
    spec,
  );
  // Every accepted addition proves absence from sealed pre-cutoff identity set.
  for (const c of postCutoff) {
    assert.equal(
      isPostCutoffAddition(c, frozenWalk.entries, frozenKeys, spec),
      true,
    );
    if (c.itemKey) assert.equal(frozenKeys.has(c.itemKey), false);
    for (const f of frozenWalk.entries) {
      assert.equal(candidateMatchesFrozenIdentity(c, f), false);
    }
  }
  // Live walk members that are frozen identities are not post-cutoff.
  for (const c of walked.candidates) {
    const frozenHit = frozenWalk.entries.some((f) =>
      candidateMatchesFrozenIdentity(c, f),
    );
    if (frozenHit || (c.itemKey && frozenKeys.has(c.itemKey))) {
      assert.equal(
        isPostCutoffAddition(c, frozenWalk.entries, frozenKeys, spec),
        false,
      );
    }
  }
  // Real source root currently carries the separable post-cutoff coder.ts identity.
  assert.equal(
    postCutoff.some((c) => c.basename === "coder.ts"),
    true,
  );
  assert.equal(postCutoff.length >= 1, true);

  // RED: synthetic omitted frozen/pre-cutoff identity whose basename is coder.ts
  // must be rejected by the same oracle (basename alone never establishes post-cutoff).
  const frozenSample = frozenWalk.entries[0]!;
  const syntheticPreCutoffCoder: CandidateIdentity = {
    basename: "coder.ts",
    fileType: frozenSample.fileType,
    sizeBytes: frozenSample.sizeBytes,
    mtimeMs: frozenSample.mtimeMs,
    ctimeMs: frozenSample.ctimeMs,
    dev: frozenSample.dev,
    ino: frozenSample.ino,
    mode: frozenSample.mode,
    sha256: frozenSample.sha256,
    itemKey: frozenSample.itemKey,
  };
  assert.equal(
    isPostCutoffAddition(
      syntheticPreCutoffCoder,
      frozenWalk.entries,
      frozenKeys,
      spec,
    ),
    false,
    "pre-cutoff identity with basename coder.ts must not be classified post-cutoff",
  );

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

liveSourceTest("recovered bytes have scanner evidence; actual scanBytes reproduces hashes and hits", () => {
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

    const rescanned = scanBytes(bytes, item.basename);
    if (!item.redacted) {
      assert.equal(rescanned.report.redacted, false, item.basename);
      assert.equal(sha256(rescanned.value), item.recoveredSha256);
    } else {
      assert.equal(report.redacted, true);
      assert.equal(report.hits.length > 0, true);
    }
  }

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
    const blob = gitShow(
      `${d.evidence!.reference!.commitSha}:${d.evidence!.reference!.path}`,
    );
    assert.equal(sha256(blob), d.evidence!.reference!.sha256);
  }

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

test("sole repository namespace bound from immutable Git bytes only", () => {
  const binding = loadNamespaceBinding();
  assert.equal(binding.namespace, SOLE_REPO_NAMESPACE);
  assert.equal(binding.issueSnapshot.commit, IMMUTABLE);
  assert.equal(binding.discoverySpec.commit, IMMUTABLE);
  assert.equal(binding.issueSnapshot.path, NAMESPACE_ISSUE_SNAPSHOT);
  assert.equal(binding.discoverySpec.path, NAMESPACE_DISCOVERY_SPEC);
  assert.equal(binding.issueSnapshot.blobOid.length, 40);
  assert.equal(binding.discoverySpec.blobOid.length, 40);
  assert.equal(binding.issueSnapshot.sha256.length, 64);
  assert.equal(binding.discoverySpec.sha256.length, 64);
  // Re-resolve
  assert.equal(
    gitRevParse(`${IMMUTABLE}:${NAMESPACE_ISSUE_SNAPSHOT}`),
    binding.issueSnapshot.blobOid,
  );
  assert.equal(
    sha256(gitShow(`${IMMUTABLE}:${NAMESPACE_ISSUE_SNAPSHOT}`)),
    binding.issueSnapshot.sha256,
  );
});

test("closed association grammar boundary table (accept and reject)", () => {
  const universe = loadCommitUniverse();
  // Seed a known full commit from universe for positive abbreviated resolution.
  const sampleFull = [...universe][0]!;
  const sampleAbbrev = sampleFull.slice(0, 8);
  const ambiguousStem = "a"; // too short / ambiguous by construction when expanded poorly
  void ambiguousStem;

  type Case = {
    name: string;
    basename: string;
    text: string | null;
    asJson: boolean;
    expect: IssuePrCommitAssociations | null;
  };

  const cases: Case[] = [
    // Basename boundaries
    {
      name: "basename issue-N accepted",
      basename: "issue-3-plan.md",
      text: null,
      asJson: false,
      expect: { issues: [3], pullRequests: [], commits: [] },
    },
    {
      name: "basename issue_N accepted",
      basename: "x_issue_2_y.md",
      text: null,
      asJson: false,
      expect: { issues: [2], pullRequests: [], commits: [] },
    },
    {
      name: "basename pr-N accepted",
      basename: "fix-pr-5-packet.md",
      text: null,
      asJson: false,
      expect: { issues: [], pullRequests: [5], commits: [] },
    },
    {
      name: "basename prN without separator rejected",
      basename: "ak-collector-pr5-6604.md",
      text: null,
      asJson: false,
      expect: null,
    },
    {
      name: "basename glued issueN rejected",
      basename: "preissue-3-plan.md",
      text: null,
      asJson: false,
      expect: null,
    },
    // Text labels
    {
      name: "text issue label accepted",
      basename: "notes.md",
      text: "See issue 12 for details",
      asJson: false,
      expect: { issues: [12], pullRequests: [], commits: [] },
    },
    {
      name: "text pull request label accepted",
      basename: "notes.md",
      text: "closed pull request #4 today",
      asJson: false,
      expect: { issues: [], pullRequests: [4], commits: [] },
    },
    {
      name: "bare number rejected",
      basename: "notes.md",
      text: "the value 12 is bare",
      asJson: false,
      expect: null,
    },
    {
      name: "bare #N rejected",
      basename: "notes.md",
      text: "see #12 only",
      asJson: false,
      expect: null,
    },
    {
      name: "label glued to word rejected",
      basename: "notes.md",
      text: "myissue 12 no",
      asJson: false,
      expect: null,
    },
    // URLs
    {
      name: "qualified issues URL accepted",
      basename: "notes.md",
      text: `link ${SOLE_URL_PREFIX}issues/15 done`,
      asJson: false,
      expect: { issues: [15], pullRequests: [], commits: [] },
    },
    {
      name: "qualified pull URL case-insensitive host accepted",
      basename: "notes.md",
      text: "see https://GitHub.com/akagilnc/ak-pi-workflow-roles/pull/5 end",
      asJson: false,
      expect: { issues: [], pullRequests: [5], commits: [] },
    },
    {
      name: "qualified URL with query boundary accepted",
      basename: "notes.md",
      text: `${SOLE_URL_PREFIX}pull/7?foo=1`,
      asJson: false,
      expect: { issues: [], pullRequests: [7], commits: [] },
    },
    {
      name: "wrong owner URL rejected",
      basename: "notes.md",
      text: "https://github.com/other/ak-pi-workflow-roles/issues/15",
      asJson: false,
      expect: null,
    },
    {
      name: "wrong repo URL rejected",
      basename: "notes.md",
      text: "https://github.com/Akagilnc/other-repo/issues/15",
      asJson: false,
      expect: null,
    },
    {
      name: "digit immediately after N rejected",
      basename: "notes.md",
      text: `${SOLE_URL_PREFIX}issues/15x`,
      asJson: false,
      expect: null,
    },
    // Commits labeled
    {
      name: "labeled full commit accepted",
      basename: "notes.md",
      text: `commit: ${sampleFull}`,
      asJson: false,
      expect: { issues: [], pullRequests: [], commits: [sampleFull] },
    },
    {
      name: "labeled abbreviated unique commit accepted",
      basename: "notes.md",
      text: `commitSha = ${sampleAbbrev}`,
      asJson: false,
      expect: { issues: [], pullRequests: [], commits: [sampleFull] },
    },
    {
      name: "prose-only commitOid mention rejected",
      basename: "notes.md",
      text: "the commitOid field matters",
      asJson: false,
      expect: null,
    },
    {
      name: "prose-only reviewedHead mention rejected",
      basename: "notes.md",
      text: "reviewedHead should bind",
      asJson: false,
      expect: null,
    },
    {
      name: "unlabeled hex rejected",
      basename: "notes.md",
      text: `raw ${sampleFull} only`,
      asJson: false,
      expect: null,
    },
    // JSON structural + recursive strings
    {
      name: "structural prNumber accepted",
      basename: "x.json",
      text: JSON.stringify({ prNumber: 5 }),
      asJson: true,
      expect: { issues: [], pullRequests: [5], commits: [] },
    },
    {
      name: "structural targetHead accepted",
      basename: "x.json",
      text: JSON.stringify({ targetHead: sampleFull }),
      asJson: true,
      expect: { issues: [], pullRequests: [], commits: [sampleFull] },
    },
    {
      name: "unlisted structural key hex rejected unless string grammar hits",
      basename: "x.json",
      text: JSON.stringify({ headOid: sampleFull }),
      asJson: true,
      expect: null,
    },
    {
      name: "nested JSON string text label accepted",
      basename: "x.json",
      text: JSON.stringify({ note: "see issue 9 please" }),
      asJson: true,
      expect: { issues: [9], pullRequests: [], commits: [] },
    },
    {
      name: "top-level JSON string text label accepted",
      basename: "x.json",
      text: JSON.stringify("see issue 9 please"),
      asJson: true,
      expect: { issues: [9], pullRequests: [], commits: [] },
    },
    {
      name: "array-nested JSON string text label accepted",
      basename: "x.json",
      text: JSON.stringify(["see issue 9 please"]),
      asJson: true,
      expect: { issues: [9], pullRequests: [], commits: [] },
    },
    {
      name: "issuePrCommitAssociations subtree omitted",
      basename: "x.json",
      text: JSON.stringify({
        issuePrCommitAssociations: { issues: [99], pullRequests: [99], commits: [sampleFull] },
        ok: true,
      }),
      asJson: true,
      expect: null,
    },
    {
      name: "zero / negative structural rejected",
      basename: "x.json",
      text: JSON.stringify({ issue: 0, prNumber: -1 }),
      asJson: true,
      expect: null,
    },
    {
      name: "non-exact structural string rejected",
      basename: "x.json",
      text: JSON.stringify({ issue: "01", prNumber: "5a" }),
      asJson: true,
      expect: null,
    },
  ];

  for (const c of cases) {
    const got = extractAssociationsClosed(c.basename, c.text, c.asJson, universe);
    assert.deepEqual(got, c.expect, c.name);
  }

  // Unresolvable but syntactically valid 7-hex abbreviations fail to associate.
  {
    let absentPrefix: string | null = null;
    for (let i = 0; i <= 0xfffffff; i += 1) {
      const cand = i.toString(16).padStart(7, "0");
      let hit = false;
      for (const c of universe) {
        if (c.startsWith(cand)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        absentPrefix = cand;
        break;
      }
    }
    assert.ok(absentPrefix, "deterministically selected absent 7-hex prefix");
    assert.equal(/^[0-9a-f]{7}$/.test(absentPrefix!), true, "prefix is valid H token");
    assert.equal(
      resolveCommitToken(absentPrefix!, universe),
      null,
      "selected prefix must be absent from sealed four-root universe",
    );
    const gotAbsent = extractAssociationsClosed(
      "notes.md",
      `commit: ${absentPrefix}`,
      false,
      universe,
    );
    assert.equal(gotAbsent, null, "valid unresolved commit prefix must not associate");
  }
  {
    // Ambiguous: pick a prefix shared by >=2 commits if any; else skip with synthetic universe.
    const synth = new Set(["aaaaaaa111111111111111111111111111111111", "aaaaaaa222222222222222222222222222222222"]);
    const got = extractAssociationsClosed(
      "notes.md",
      "commitSha: aaaaaaa",
      false,
      synth,
    );
    assert.equal(got, null, "ambiguous abbreviation must not associate");
  }
});

liveSourceTest("structured issue/PR/commit associations exhaustive from frozen metadata and admitted non-generic bytes", () => {
  loadNamespaceBinding();
  const universe = loadCommitUniverse();
  const expected = deriveExpectedAssociations();
  assert.equal(expected.size, 597);

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
      evidence?: {
        recoveredPath?: string;
        reference?: { commitSha: string; path: string };
      };
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

  // Exact-set equality for every disposition + recovered-index row.
  for (const d of disp.items) {
    const exp = expected.get(d.itemKey) ?? null;
    const got = d.issuePrCommitAssociations ?? null;
    assert.equal(
      associationsEqual(got, exp),
      true,
      `disposition association mismatch for ${d.basename}: got ${JSON.stringify(got)} exp ${JSON.stringify(exp)}`,
    );
    // Generic items never opened payload: re-derive basename-only and match.
    const meta = invByKey.get(d.itemKey)!;
    if (meta.genericExhaust) {
      const basenameOnly = extractAssociationsClosed(
        d.basename,
        null,
        false,
        universe,
      );
      assert.equal(associationsEqual(exp, basenameOnly), true, d.basename);
    }
  }
  for (const item of recovered.items) {
    const exp = expected.get(item.itemKey) ?? null;
    const got = item.issuePrCommitAssociations ?? null;
    assert.equal(
      associationsEqual(got, exp),
      true,
      `recovered-index association mismatch for ${item.basename}`,
    );
  }

  // First known-item check — both persisted metadata paths (disposition + recovered).
  const pr5Disposition = disp.items.find((d) => d.itemKey.startsWith("ecec8803"));
  assert.ok(pr5Disposition, "ecec8803 disposition");
  const pr5Expected = expected.get(pr5Disposition.itemKey) ?? null;
  assert.ok(pr5Expected, "ecec8803 expected non-null from structural JSON");
  assert.deepEqual(pr5Disposition.issuePrCommitAssociations, pr5Expected);
  assert.equal(pr5Expected.pullRequests.includes(5), true);
  assert.equal(
    pr5Expected.commits.includes("6604a733886dfb5d074f558963e20e01e587aa6d"),
    true,
  );
  const pr5RecoveredItem = recovered.items.find((d) =>
    d.itemKey.startsWith("ecec8803"),
  );
  assert.ok(pr5RecoveredItem);
  assert.deepEqual(pr5RecoveredItem.issuePrCommitAssociations, pr5Expected);

  // Second known item — actual persisted record (may be null under closed grammar).
  const secondKnown = disp.items.find((d) => d.itemKey.startsWith("33454566"));
  assert.ok(secondKnown, "33454566 disposition");
  const secondExpected = expected.get(secondKnown.itemKey) ?? null;
  assert.equal(
    associationsEqual(secondKnown.issuePrCommitAssociations ?? null, secondExpected),
    true,
  );
  const secondRecovered = recovered.items.find((d) =>
    d.itemKey.startsWith("33454566"),
  );
  assert.ok(secondRecovered, "33454566 recovered");
  assert.equal(
    associationsEqual(
      secondRecovered.issuePrCommitAssociations ?? null,
      secondExpected,
    ),
    true,
  );

  // RED: clone actual parsed disposition/recovered record, mutate real association value.
  {
    const mutatedDisp = {
      ...secondKnown,
      issuePrCommitAssociations: {
        issues: [999],
        pullRequests: [999],
        commits: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
      },
    };
    assert.equal(
      associationsEqual(
        mutatedDisp.issuePrCommitAssociations,
        secondExpected,
      ),
      false,
      "mutated disposition association must mismatch canonical set",
    );
    const mutatedRec = {
      ...secondRecovered,
      issuePrCommitAssociations: {
        issues: [1],
        pullRequests: [],
        commits: [],
      },
    };
    assert.equal(
      associationsEqual(
        mutatedRec.issuePrCommitAssociations,
        secondExpected,
      ),
      false,
      "mutated recovered association must mismatch canonical set",
    );
  }

  // RED: mutate eligible parsed source input to a rejected boundary; derived set changes.
  {
    const { text, asJson } = loadAdmittedSourceText(
      secondKnown,
      invByKey.get(secondKnown.itemKey)!,
    );
    assert.equal(typeof text === "string" || text === null, true);
    const baseline = extractAssociationsClosed(
      secondKnown.basename,
      text,
      asJson,
      universe,
    );
    assert.equal(associationsEqual(baseline, secondExpected), true);
    // Eligible source: force a rejected-boundary basename contribution only would not change
    // if text already empty; inject rejected bare #N text (no new accept) vs accepted label.
    const rejectedBoundaryText = `${text ?? ""}\nsee #42 only bare\n`;
    const withRejected = extractAssociationsClosed(
      secondKnown.basename,
      rejectedBoundaryText,
      false, // plain text scan path
      universe,
    );
    // bare #42 must not add issue 42
    if (withRejected) {
      assert.equal(withRejected.issues.includes(42), false);
    }
    const acceptedBoundaryText = `${text ?? ""}\nsee issue 42 please\n`;
    const withAccepted = extractAssociationsClosed(
      secondKnown.basename,
      acceptedBoundaryText,
      false,
      universe,
    );
    assert.ok(withAccepted);
    assert.equal(withAccepted.issues.includes(42), true);
    assert.equal(
      associationsEqual(withAccepted, secondExpected),
      false,
      "accepted boundary mutation must change derived set vs persisted expected",
    );
  }

  assert.equal(Array.isArray(pr5Disposition.issuePrCommitAssociations?.pullRequests), true);
  assert.equal(recoveredByKey.has(pr5RecoveredItem.itemKey), true);
  assert.equal(universe.size > 0, true);
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
  assert.equal(sha256(implBytes), REPAIR_002_IMPL_SHA);
  assert.match(implBytes.toString("utf8"), /scanBytes/);
  assert.match(implBytes.toString("utf8"), /R1-frozen-identity/);

  const summaryArt = manifest.artifacts.find(
    (a) => a.id === "corroboration-scan-summary",
  );
  assert.ok(summaryArt?.stored?.path, "summary artifact stored path");
  const summaryPath = join(evidenceDir, summaryArt!.stored!.path);
  assert.equal(existsSync(summaryPath), true);
  const summaryBytes = readFileSync(summaryPath);
  assert.equal(sha256(summaryBytes), summaryArt!.stored!.sha256);
  assert.equal(sha256(summaryBytes), REPAIR_002_RESULT_SHA);
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
  // Historical repair-002 result content (byte-frozen) records coder.ts partition.
  assert.deepEqual(
    summary.r1.postCutoffAdditions.map((p) => p.basename).sort(),
    ["coder.ts"],
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

  assert.equal(existsSync(join(REPO_ROOT, RECORDER_001, "manifest.json")), true);
});

liveSourceTest("repair-003 recorder successor independently corroborates cutoff oracle and 277-source scan", () => {
  const evidenceDir = join(REPO_ROOT, RECORDER_003);
  const manifestPath = join(evidenceDir, "manifest.json");
  assert.equal(existsSync(manifestPath), true, "recorder-003 closure manifest");
  const manifest = readJson<{
    receipt: null | unknown;
    recorder: { status: string };
    child: { status: string; exitCode: number | null };
    provenance: { target: string | null };
    artifacts: Array<{
      id: string;
      kind: string;
      stored?: { path: string; sha256: string; byteLength: number };
      reference?: {
        commit: string;
        path: string;
        blobOid: string;
        sha256: string;
      };
    }>;
    identityLedger?: {
      gitTupleCount?: number;
      gitTuples?: GitTuple[];
      externalSources?: Array<{
        itemKey: string;
        sourceSha256: string;
        basename?: string;
      }>;
      namespace?: { namespace: string; inputs: GitTuple[] };
    };
  }>(manifestPath);
  assert.equal(manifest.receipt, null);
  assert.equal(manifest.recorder.status, "completed");
  assert.equal(manifest.child.status, "exited");
  assert.equal(manifest.child.exitCode, 0);
  assert.match(String(manifest.provenance.target), /repair-003/);

  const implArt = manifest.artifacts.find(
    (a) => a.id === "repair-003-child-implementation",
  );
  assert.ok(implArt?.stored?.path, "implementation exhibit stored");
  const implPath = join(evidenceDir, implArt!.stored!.path);
  const implBytes = readFileSync(implPath);
  assert.equal(sha256(implBytes), implArt!.stored!.sha256);
  assert.match(implBytes.toString("utf8"), /scanBytes/);
  assert.match(implBytes.toString("utf8"), /isPostCutoffAddition|post-cutoff|cutoff/);
  assert.match(implBytes.toString("utf8"), /scanner/);

  const summaryArt = manifest.artifacts.find(
    (a) => a.id === "repair-003-child-result",
  );
  assert.ok(summaryArt?.stored?.path, "result stored");
  const summaryPath = join(evidenceDir, summaryArt!.stored!.path);
  const summaryBytes = readFileSync(summaryPath);
  assert.equal(sha256(summaryBytes), summaryArt!.stored!.sha256);
  const summary = JSON.parse(summaryBytes.toString("utf8")) as {
    ok: boolean;
    childExitCode: number;
    executionHead: string;
    r1: {
      matched: number;
      missing: number;
      changed: number;
      recorded: number;
      postCutoffCount: number;
      postCutoffBasenames: string[];
    };
    r2: {
      admittedScanned: number;
      allMatched: boolean;
      redactedCount: number;
      highlighted: Array<{ basename: string; redacted: boolean }>;
      results: Array<{
        itemKey: string;
        basename: string;
        sourceSha256: string;
        recoveredSha256: string;
        redacted: boolean;
      }>;
    };
    scanner: {
      path: string;
      sha256: string;
      srcTuple?: GitTuple;
      distPath: string;
      distSha256: string;
      distTuple?: GitTuple;
      verified: boolean;
      executableVerifiedBeforeImport?: boolean;
    };
    identityLedger: {
      gitTuples: GitTuple[];
      requiredTupleKeys?: string[];
      referenceTuples?: Array<{
        itemKey: string;
        basename: string;
        disposition: string;
        tuple: GitTuple;
      }>;
      externalSources: Array<{
        itemKey: string;
        sourceSha256: string;
        basename: string;
        sourceOrigin?: string;
        frozenIdentity?: { itemKey: string; basename: string; disposition: string };
      }>;
      namespace: { namespace: string; inputs: GitTuple[] };
      scanner?: { source: GitTuple; dist: GitTuple };
    };
    redGates: Record<string, boolean>;
  };
  assert.equal(summary.ok, true);
  assert.equal(summary.childExitCode, 0);
  assert.equal(typeof summary.executionHead, "string");
  assert.equal(summary.executionHead.length, 40);
  assert.equal(gitIsAncestor(summary.executionHead), true);
  assert.equal(summary.r1.recorded, 597);
  assert.equal(summary.r1.matched, 597);
  assert.equal(summary.r1.missing, 0);
  assert.equal(summary.r1.changed, 0);
  assert.equal(summary.r1.postCutoffCount >= 1, true);
  assert.equal(summary.r1.postCutoffBasenames.includes("coder.ts"), true);
  assert.equal(summary.r2.admittedScanned, 277);
  assert.equal(summary.r2.allMatched, true);
  assert.equal(summary.r2.redactedCount, 2);
  assert.equal(summary.r2.results.length, 277);
  const hl = new Set(summary.r2.highlighted.map((h) => h.basename));
  assert.equal(hl.has("judge-malformed-probe.ts"), true);
  assert.equal(hl.has("reviewer-real-pi-snippet.ts"), true);
  assert.equal(summary.scanner.verified, true);
  assert.equal(summary.scanner.executableVerifiedBeforeImport, true);
  assert.equal(summary.identityLedger.namespace.namespace, SOLE_REPO_NAMESPACE);
  assert.equal(summary.identityLedger.externalSources.length, 277);
  assert.equal(summary.identityLedger.gitTuples.length > 0, true);

  // Executable boundary: distinct source + dist tuples bound at child executionHead.
  const execHead = summary.executionHead;
  const scannerSrc = gitTuple(execHead, "src/recorder/scanner.ts");
  const scannerDist = gitTuple(execHead, "dist/recorder/scanner.js");
  assert.notEqual(scannerSrc.path, scannerDist.path);
  assert.notEqual(scannerSrc.blobOid, scannerDist.blobOid);
  assert.notEqual(scannerSrc.sha256, scannerDist.sha256);
  // Worktree bytes still match the sealed executable/source identities.
  assert.equal(
    sha256(readFileSync(join(REPO_ROOT, "src/recorder/scanner.ts"))),
    scannerSrc.sha256,
  );
  assert.equal(
    sha256(readFileSync(join(REPO_ROOT, "dist/recorder/scanner.js"))),
    scannerDist.sha256,
  );
  assert.equal(summary.scanner.path, scannerSrc.path);
  assert.equal(summary.scanner.sha256, scannerSrc.sha256);
  assert.equal(summary.scanner.distPath, scannerDist.path);
  assert.equal(summary.scanner.distSha256, scannerDist.sha256);
  assert.ok(summary.scanner.srcTuple, "scanner srcTuple");
  assert.ok(summary.scanner.distTuple, "scanner distTuple");
  assert.deepEqual(summary.scanner.srcTuple, scannerSrc);
  assert.deepEqual(summary.scanner.distTuple, scannerDist);
  assert.ok(summary.identityLedger.scanner, "ledger scanner section");
  assert.deepEqual(summary.identityLedger.scanner!.source, scannerSrc);
  assert.deepEqual(summary.identityLedger.scanner!.dist, scannerDist);
  const tupleKey = (t: GitTuple) =>
    `${t.repository}|${t.commit}|${t.path}|${t.blobOid}|${t.sha256}`;
  const ledgerKeySet = new Set(summary.identityLedger.gitTuples.map(tupleKey));
  assert.equal(ledgerKeySet.has(tupleKey(scannerSrc)), true, "src tuple in ledger");
  assert.equal(ledgerKeySet.has(tupleKey(scannerDist)), true, "dist tuple in ledger");

  // Child must reject dist drift before dynamic import (implementation shape).
  const implText = implBytes.toString("utf8");
  assert.match(implText, /scanner-dist-worktree-drift/);
  assert.match(
    implText,
    /dist digest mismatch rejected before import|expectedDistTuple[\s\S]*await import/,
  );
  const driftIdx = implText.indexOf("scanner-dist-worktree-drift");
  const importIdx = implText.indexOf("await import");
  assert.equal(driftIdx >= 0 && importIdx > driftIdx, true, "dist gate precedes import");

  // Immutable execution-input shape: one executionHead, Git dispositions, no fail-open catches.
  assert.match(implText, /required-tuple-unresolvable/);
  assert.match(implText, /dispositions-worktree-drift/);
  assert.match(implText, /report-worktree-drift/);
  assert.match(implText, /derivative-worktree-drift/);
  assert.match(
    implText,
    /Load dispositions from the single execution commit|dispositionsFromExecutionHead/,
  );
  assert.equal(
    /\/\*\s*worktree-only\s*\*\//.test(implText),
    false,
    "no worktree-only omission catches in child",
  );
  assert.equal(
    /dispositions may be dirty mid-apply/.test(implText),
    false,
    "no dirty-disposition fail-open in child",
  );
  // executionHead captured before disposition load / required-universe construction.
  const execHeadDecl = implText.indexOf(
    "const executionHead = gitRevParse(\"HEAD\")",
  );
  const dispLoad = implText.indexOf(
    "requireGitTuple(executionHead, dispRel)",
  );
  assert.equal(
    execHeadDecl >= 0 && dispLoad > execHeadDecl,
    true,
    "executionHead precedes disposition Git load",
  );

  // Resolve every successor Git tuple from the ledger.
  for (const t of summary.identityLedger.gitTuples) {
    assert.equal(t.repository, SOLE_REPO_NAMESPACE);
    const oid = gitRevParse(`${t.commit}:${t.path}`);
    assert.equal(oid, t.blobOid, `blob ${t.path}`);
    assert.equal(sha256(gitShow(`${t.commit}:${t.path}`)), t.sha256, t.path);
  }
  for (const t of summary.identityLedger.namespace.inputs) {
    const oid = gitRevParse(`${t.commit}:${t.path}`);
    assert.equal(oid, t.blobOid);
    assert.equal(sha256(gitShow(`${t.commit}:${t.path}`)), t.sha256);
  }

  // Independent required-tuple completeness oracle at child executionHead.
  // Fail-closed: dispositions and every report/derivative resolve without catches.
  const required: GitTuple[] = [
    gitTuple(IMMUTABLE, NAMESPACE_ISSUE_SNAPSHOT),
    gitTuple(IMMUTABLE, NAMESPACE_DISCOVERY_SPEC),
    gitTuple(IMMUTABLE, `${IMMUTABLE_MIG_PREFIX}/construction-walk.json`),
    gitTuple(IMMUTABLE, `${IMMUTABLE_MIG_PREFIX}/inventory.json`),
    scannerSrc,
    scannerDist,
    gitTuple(execHead, `${IMMUTABLE_MIG_PREFIX}/dispositions.json`),
  ];
  const dispFromExec = JSON.parse(
    gitShow(`${execHead}:${IMMUTABLE_MIG_PREFIX}/dispositions.json`).toString(
      "utf8",
    ),
  ) as {
    items: Array<{
      itemKey: string;
      basename: string;
      disposition: string;
      evidence?: {
        sourceSha256?: string;
        reference?: { commitSha: string; path: string };
        redactionReportPath?: string;
        recoveredPath?: string;
      };
    }>;
  };
  const admittedFromExec = dispFromExec.items.filter((d) =>
    ["recovered", "reference", "superseded"].includes(d.disposition),
  );
  assert.equal(admittedFromExec.length, 277);
  const referenceDisps = admittedFromExec.filter(
    (d) => d.disposition === "reference",
  );
  assert.equal(referenceDisps.length, 7, "seven reference dispositions");
  for (const d of admittedFromExec) {
    if (d.evidence?.reference) {
      required.push(
        gitTuple(d.evidence.reference.commitSha, d.evidence.reference.path),
      );
    }
    if (d.evidence?.redactionReportPath) {
      required.push(
        gitTuple(
          execHead,
          `${IMMUTABLE_MIG_PREFIX}/${d.evidence.redactionReportPath}`,
        ),
      );
    }
    if (d.evidence?.recoveredPath) {
      required.push(
        gitTuple(
          execHead,
          `${IMMUTABLE_MIG_PREFIX}/${d.evidence.recoveredPath}`,
        ),
      );
    }
  }
  const requiredKeySet = new Set(required.map(tupleKey));
  const missingRequired = [...requiredKeySet]
    .filter((k) => !ledgerKeySet.has(k))
    .sort();
  assert.deepEqual(missingRequired, [], "ledger missing required tuples");
  // Child-recorded required keys must agree with independent oracle.
  assert.ok(summary.identityLedger.requiredTupleKeys, "requiredTupleKeys recorded");
  assert.deepEqual(
    [...summary.identityLedger.requiredTupleKeys!].sort(),
    [...requiredKeySet].sort(),
  );

  // Sealed dispositions input must bind executionHead Git bytes (not null-commit fallback).
  const sealedDisp = (
    summary as {
      sealedInputs?: {
        dispositions?: GitTuple & {
          worktreeMatchesHead?: boolean;
          commit: string | null;
        };
      };
    }
  ).sealedInputs?.dispositions;
  assert.ok(sealedDisp, "sealed dispositions tuple");
  assert.equal(sealedDisp!.commit, execHead);
  assert.equal(sealedDisp!.path, `${IMMUTABLE_MIG_PREFIX}/dispositions.json`);
  assert.equal(typeof sealedDisp!.blobOid, "string");
  assert.equal(sealedDisp!.blobOid!.length, 40);
  assert.equal(sealedDisp!.sha256.length, 64);
  assert.equal(
    (sealedDisp as { worktreeMatchesHead?: boolean }).worktreeMatchesHead,
    undefined,
    "no worktree fallback field on sealed dispositions",
  );

  // Manifest gitTupleCount must equal sealed result unique Git tuples and
  // the independently required unique tuple-key universe (three-way equality).
  const resultUniqueGitTupleCount = ledgerKeySet.size;
  assert.equal(
    summary.identityLedger.gitTuples.length,
    resultUniqueGitTupleCount,
    "result gitTuples are unique",
  );
  assert.equal(
    typeof manifest.identityLedger?.gitTupleCount,
    "number",
    "manifest identityLedger.gitTupleCount present",
  );
  assert.equal(
    manifest.identityLedger!.gitTupleCount,
    resultUniqueGitTupleCount,
    "manifest gitTupleCount equals result unique Git tuple count",
  );
  assert.equal(
    manifest.identityLedger!.gitTupleCount,
    requiredKeySet.size,
    "manifest gitTupleCount equals independently required unique tuple-key count",
  );
  assert.equal(
    resultUniqueGitTupleCount,
    requiredKeySet.size,
    "result unique Git tuples equal required unique tuple keys",
  );

  // RED: omitting any one required key from a copy must fail completeness.
  {
    const copy = new Set(ledgerKeySet);
    const victim = [...requiredKeySet][0]!;
    copy.delete(victim);
    const omitted = [...requiredKeySet].filter((k) => !copy.has(k));
    assert.equal(omitted.length >= 1, true, "omission red oracle");
    assert.equal(omitted.includes(victim), true);
  }

  // RED (child-seam): dirty disposition/report/derivative and unresolvable
  // required path must make the existing repair-003 child fail closed.
  {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "case-a-child-seam-"));
    const currentHead = gitRevParse("HEAD");
    try {
      execFileSync("git", ["clone", "--shared", "--quiet", REPO_ROOT, fixtureRoot], {
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["-C", fixtureRoot, "checkout", "--detach", "--quiet", currentHead],
        { stdio: "ignore" },
      );

      const dispRel = `${IMMUTABLE_MIG_PREFIX}/dispositions.json`;
      const fixtureDisp = JSON.parse(
        execFileSync("git", ["-C", fixtureRoot, "show", `${currentHead}:${dispRel}`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      ) as {
        items: Array<{
          disposition: string;
          evidence?: {
            redactionReportPath?: string;
            recoveredPath?: string;
          };
        }>;
      };
      const fixtureAdmitted = fixtureDisp.items.filter((d) =>
        ["recovered", "reference", "superseded"].includes(d.disposition),
      );
      const sample = fixtureAdmitted.find(
        (d) =>
          d.evidence?.redactionReportPath && d.evidence?.recoveredPath,
      );
      assert.ok(sample, "disposition-derived report+derivative sample");
      const reportRel = `${IMMUTABLE_MIG_PREFIX}/${sample!.evidence!.redactionReportPath}`;
      const derRel = `${IMMUTABLE_MIG_PREFIX}/${sample!.evidence!.recoveredPath}`;

      const childPath = join(
        fixtureRoot,
        RECORDER_003,
        "exhibits/cutoff-scan-implementation",
      );
      const runExistingChild = (
        outName: string,
      ): { exitCode: number; payload: Record<string, unknown> } => {
        const outPath = join(fixtureRoot, outName);
        const result = spawnSync(process.execPath, [childPath], {
          env: {
            ...process.env,
            AK_REPAIR_REPO_ROOT: fixtureRoot,
            AK_REPAIR_EVIDENCE_OUT: outPath,
          },
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        assert.equal(
          existsSync(outPath),
          true,
          `child must write evidence out for ${outName}`,
        );
        const payload = JSON.parse(readFileSync(outPath, "utf8")) as Record<
          string,
          unknown
        >;
        return { exitCode: result.status ?? 1, payload };
      };

      const resetFixtureWorktree = () => {
        execFileSync(
          "git",
          ["-C", fixtureRoot, "checkout", "--", "."],
          { stdio: "ignore" },
        );
        execFileSync(
          "git",
          ["-C", fixtureRoot, "clean", "-fdq"],
          { stdio: "ignore" },
        );
      };

      const driftCases: Array<{ relPath: string; gate: string; dirty: string }> =
        [
          {
            relPath: dispRel,
            gate: "dispositions-worktree-drift",
            dirty: "dirty-dispositions-counterexample\n",
          },
          {
            relPath: reportRel,
            gate: "report-worktree-drift",
            dirty: "dirty-report-counterexample\n",
          },
          {
            relPath: derRel,
            gate: "derivative-worktree-drift",
            dirty: "dirty-derivative-counterexample\n",
          },
        ];

      for (const c of driftCases) {
        resetFixtureWorktree();
        // HEAD stays fixed; only live bytes are dirtied.
        assert.equal(
          execFileSync("git", ["-C", fixtureRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          currentHead,
        );
        writeFileSync(join(fixtureRoot, c.relPath), c.dirty);
        const { exitCode, payload } = runExistingChild(`out-${c.gate}.json`);
        assert.notEqual(exitCode, 0, `${c.gate} must be nonzero`);
        assert.equal(payload.ok, false);
        assert.equal(payload.gate, c.gate);
        assert.equal(payload.path, c.relPath);
        assert.equal(payload.commit, currentHead);
      }

      // Required-universe path: delete one disposition-derived required file and
      // commit while leaving the disposition reference intact; child must fail
      // closed via requireGitTuple (not verifier-local tuple resolution).
      resetFixtureWorktree();
      execFileSync("git", ["-C", fixtureRoot, "rm", "-f", "--", reportRel], {
        stdio: "ignore",
      });
      execFileSync(
        "git",
        [
          "-C",
          fixtureRoot,
          "-c",
          "user.email=child-seam@test",
          "-c",
          "user.name=child-seam",
          "commit",
          "-m",
          "temp: delete required report for child-seam red proof",
        ],
        { stdio: "ignore" },
      );
      const tempCommit = execFileSync(
        "git",
        ["-C", fixtureRoot, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      assert.notEqual(tempCommit, currentHead);
      // Disposition still names the deleted path.
      const dispAfter = JSON.parse(
        execFileSync("git", ["-C", fixtureRoot, "show", `${tempCommit}:${dispRel}`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      ) as {
        items: Array<{ evidence?: { redactionReportPath?: string } }>;
      };
      assert.equal(
        dispAfter.items.some(
          (d) =>
            d.evidence?.redactionReportPath ===
            sample!.evidence!.redactionReportPath,
        ),
        true,
        "disposition reference remains after required-path deletion",
      );

      const unres = runExistingChild("out-required-tuple-unresolvable.json");
      assert.notEqual(unres.exitCode, 0, "unresolvable must be nonzero");
      assert.equal(unres.payload.ok, false);
      assert.equal(unres.payload.gate, "required-tuple-unresolvable");
      assert.equal(unres.payload.path, reportRel);
      assert.equal(unres.payload.commit, tempCommit);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  // All seven reference dispositions produce matching reference tuples.
  assert.ok(summary.identityLedger.referenceTuples, "referenceTuples ledgered");
  assert.equal(summary.identityLedger.referenceTuples!.length, 7);
  const refByKey = new Map(
    summary.identityLedger.referenceTuples!.map((r) => [r.itemKey, r]),
  );
  for (const d of referenceDisps) {
    const got = refByKey.get(d.itemKey);
    assert.ok(got, `reference tuple for ${d.basename}`);
    assert.equal(got!.disposition, "reference");
    const exp = gitTuple(
      d.evidence!.reference!.commitSha,
      d.evidence!.reference!.path,
    );
    assert.deepEqual(got!.tuple, exp);
    assert.equal(ledgerKeySet.has(tupleKey(exp)), true, d.basename);
  }

  // Independently verify all 277 external seals against frozen metadata only.
  const extByKey = new Map(
    summary.identityLedger.externalSources.map((e) => [e.itemKey, e]),
  );
  for (const d of admittedFromExec) {
    const ext = extByKey.get(d.itemKey);
    assert.ok(ext, `external seal ${d.basename}`);
    assert.equal(ext!.basename, d.basename);
    assert.equal(ext!.frozenIdentity?.itemKey, d.itemKey);
    assert.equal(ext!.frozenIdentity?.disposition, d.disposition);
    if (d.evidence?.sourceSha256) {
      assert.equal(ext!.sourceSha256, d.evidence.sourceSha256);
    }
    assert.equal(/^[0-9a-f]{64}$/.test(ext!.sourceSha256), true);
  }
  // No raw-source duplication under the recorder-closure seam.
  for (const f of listFilesRecursive(evidenceDir)) {
    const rel = relative(evidenceDir, f);
    assert.equal(rel.includes("case-a-rescue"), false);
    assert.equal(rel.endsWith(".jsonl"), false);
  }

  // RED gates recorded as exercised (child path proves failure modes).
  for (const key of [
    "tuplePerturbation",
    "requiredTupleOmission",
    "scannerSrcHash",
    "scannerDistHash",
    "scannerDistPreImport",
    "scannerSrcDistDistinct",
    "selectionIdentity",
    "sourceSeal",
    "hitReport",
    "cutoffIdentity",
    "namespaceBinding",
    "referenceTuplesComplete",
    "redaction42a9fc",
    "redactionAf289a",
    "dispositionsFromExecutionHead",
    "requiredUniverseFailClosed",
    "immutableReportDerivativeAgreement",
  ]) {
    assert.equal(summary.redGates[key], true, `red gate ${key}`);
  }

  // repair-002 seals remain exact; no shared implementation.
  assert.equal(
    sha256(
      readFileSync(
        join(REPO_ROOT, RECORDER_002, "exhibits/corroboration-scan-implementation"),
      ),
    ),
    REPAIR_002_IMPL_SHA,
  );
  assert.equal(
    sha256(
      readFileSync(
        join(REPO_ROOT, RECORDER_002, "inputs/corroboration-scan-summary"),
      ),
    ),
    REPAIR_002_RESULT_SHA,
  );
  assert.notEqual(sha256(implBytes), REPAIR_002_IMPL_SHA);
});

test("historical nonconformance closure seals original and 49807d4 successor identities", () => {
  assert.equal(gitIsAncestor(ORIGINAL_APPLY_COMMIT), true);
  assert.equal(gitIsAncestor(NONCONFORMING_SUCCESSOR_COMMIT), true);
  assert.equal(gitIsAncestor(REPAIR_002_COMMIT), true);
  assert.equal(gitIsAncestor(IMMUTABLE), true);

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
      recorderImplementation: { path: string; sha256: string };
      recorderResult: { path: string; sha256: string };
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
  assert.equal(record.bindings.recorderImplementation.sha256, REPAIR_002_IMPL_SHA);
  assert.equal(record.bindings.recorderResult.sha256, REPAIR_002_RESULT_SHA);

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

  const manual = readFileSync(
    join(REPO_ROOT, record.bindings.manualReconciliation.path),
    "utf8",
  );
  assert.match(manual, /exact/i);
});

liveSourceTest("red oracle probes: synthetic violations are detectable from committed shape", () => {
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
