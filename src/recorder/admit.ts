import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  GitReferenceDeclaration,
  RecorderConfig,
} from "./config.ts";
import { RecorderError } from "./errors.ts";
import { requireCanonicalGitWorktree } from "./paths.ts";
import {
  combineReports,
  scanBytes,
  scanJsonValue,
  scanString,
  type ScanReport,
} from "./scanner.ts";

export type ReferenceIdentity = {
  identity: "reference";
  repositoryRoot: string;
  commit: string;
  path: string;
  blobOid: string;
  sha256: string;
  mode: "100644" | "100755";
};

export type StoredIdentity = {
  identity: "stored";
  path: string;
  sha256: string;
  byteLength: number;
};

export type AdmittedArtifact = {
  id: string;
  kind:
    | "authority"
    | "task"
    | "input"
    | "exhibit"
    | "receipt"
    | "audit-observation";
  redactionStatus: "clean" | "redacted" | "sanitized-derivative";
  reference?: ReferenceIdentity;
  stored?: StoredIdentity;
};

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new RecorderError(
      "reference-failed",
      "git reference verification failed",
      { cause: error },
    );
  }
}

/**
 * Verify one exact path as mode 100644|100755, type blob, exact path/OID/hash.
 * Never accepts the first recursive descendant of a directory.
 */
export function verifyGitReference(
  ref: GitReferenceDeclaration,
): { artifact: AdmittedArtifact; report: ScanReport } {
  const repositoryRoot = requireCanonicalGitWorktree(
    ref.repositoryRoot,
    `gitReference ${ref.id} repositoryRoot`,
  );
  // Full resolvable commit only (already shape-checked as 40 hex).
  const resolved = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${ref.commit}^{commit}`,
  ]);
  if (resolved.toLowerCase() !== ref.commit.toLowerCase()) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} commit does not resolve exactly`,
    );
  }

  // Exact path listing without recursion into trees as blobs.
  const ls = git(repositoryRoot, [
    "ls-tree",
    "--full-tree",
    ref.commit,
    "--",
    ref.path,
  ]);
  if (ls.length === 0) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} path is not present at commit`,
    );
  }
  const lines = ls.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} path is not a single exact tree entry`,
    );
  }
  const first = lines[0]!;
  const tab = first.indexOf("\t");
  const meta = tab === -1 ? first : first.slice(0, tab);
  const listedPath = tab === -1 ? "" : first.slice(tab + 1);
  if (listedPath !== ref.path) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} path mismatch`,
    );
  }
  const parts = meta.split(/\s+/);
  const mode = parts[0];
  const objType = parts[1];
  const blobOid = parts[2];
  if (objType !== "blob") {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} is not a blob`,
    );
  }
  if (mode !== "100644" && mode !== "100755") {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} has unlawful mode`,
    );
  }
  if (
    blobOid === undefined ||
    blobOid.toLowerCase() !== ref.blobOid.toLowerCase()
  ) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} blobOid mismatch`,
    );
  }
  const bytes = Buffer.from(
    execFileSync("git", ["-C", repositoryRoot, "cat-file", "blob", blobOid], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const digest = sha256Hex(bytes);
  if (digest !== ref.sha256.toLowerCase()) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} sha256 mismatch`,
    );
  }

  // Dirty, deleted, renamed, or untracked worktree state cannot satisfy a
  // committed reference — even when the declaration names the committed bytes.
  const worktreeState = git(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--",
    ref.path,
  ]);
  if (worktreeState.length > 0) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} path is dirty, deleted, or untracked in the worktree`,
    );
  }

  const repoScan = scanString(
    repositoryRoot,
    `gitReference.${ref.id}.repositoryRoot`,
  );
  const pathScan = scanString(ref.path, `gitReference.${ref.id}.path`);
  const report = combineReports(repoScan.report, pathScan.report);

  // Identity coordinates are exact verified facts. Scanner hits may prove a
  // secret shape was present, but must never rewrite ReferenceIdentity fields.
  if (
    repoScan.value !== repositoryRoot ||
    pathScan.value !== ref.path ||
    repoScan.report.redacted ||
    pathScan.report.redacted
  ) {
    throw new RecorderError(
      "reference-failed",
      `git reference ${ref.id} identity coordinates must not contain redactable material`,
    );
  }

  return {
    artifact: {
      id: ref.id,
      kind: ref.kind,
      redactionStatus: "clean",
      reference: {
        identity: "reference",
        repositoryRoot,
        commit: ref.commit.toLowerCase(),
        path: ref.path,
        blobOid: ref.blobOid.toLowerCase(),
        sha256: digest,
        mode,
      },
    },
    report,
  };
}

function isCommittedInContainingRepo(
  sourcePath: string,
): boolean {
  try {
    const toplevel = execFileSync(
      "git",
      ["-C", dirname(sourcePath), "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const rel = execFileSync(
      "git",
      ["-C", toplevel, "ls-files", "--error-unmatch", "--", sourcePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return rel.length > 0;
  } catch {
    return false;
  }
}

function storeOnce(
  sourcePath: string,
  expectedSha256: string,
  destRelative: string,
  stageRoot: string,
  location: string,
  id: string,
): { stored: StoredIdentity; report: ScanReport } {
  // External/exhibit bytes already committed in their containing repository are rejected.
  if (isCommittedInContainingRepo(sourcePath)) {
    throw new RecorderError(
      "admission-failed",
      `external/exhibit ${id} is already committed in its containing repository`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(sourcePath);
  } catch (error) {
    throw new RecorderError(
      "admission-failed",
      `external source unreadable at ${location}`,
      { cause: error },
    );
  }
  const digest = sha256Hex(bytes);
  if (digest !== expectedSha256.toLowerCase()) {
    throw new RecorderError(
      "admission-failed",
      `external source sha256 mismatch at ${location}`,
    );
  }
  const scanned = scanBytes(bytes, location);
  const finalBytes = scanned.value;
  const finalDigest = sha256Hex(finalBytes);
  const destAbs = join(stageRoot, destRelative);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, finalBytes);
  return {
    stored: {
      identity: "stored",
      path: destRelative,
      sha256: finalDigest,
      byteLength: finalBytes.length,
    },
    report: scanned.report,
  };
}

export function admitDeclarations(
  config: RecorderConfig,
  stageRoot: string,
): { artifacts: AdmittedArtifact[]; report: ScanReport } {
  const artifacts: AdmittedArtifact[] = [];
  const reports: ScanReport[] = [];

  // Structural identity and path conflicts are owned by the config boundary.
  const canonicalReferenceIdentities = new Set<string>();
  const storedDigests = new Set<string>();

  for (const ref of config.declarations.gitReferences) {
    const verified = verifyGitReference(ref);
    const reference = verified.artifact.reference!;
    const canonicalIdentity = [
      reference.repositoryRoot,
      reference.commit,
      reference.path,
      reference.blobOid,
    ].join("\0");
    if (canonicalReferenceIdentities.has(canonicalIdentity)) {
      throw new RecorderError(
        "admission-failed",
        `duplicate canonical git reference identity for ${ref.id}`,
      );
    }
    canonicalReferenceIdentities.add(canonicalIdentity);
    artifacts.push(verified.artifact);
    reports.push(verified.report);
  }

  for (const input of config.declarations.externalInputs) {
    const dest = join("inputs", input.id);
    const stored = storeOnce(
      input.sourcePath,
      input.sha256,
      dest,
      stageRoot,
      `externalInput.${input.id}`,
      input.id,
    );
    if (storedDigests.has(stored.stored.sha256)) {
      throw new RecorderError(
        "admission-failed",
        `duplicate stored artifact digest for ${input.id}`,
      );
    }
    storedDigests.add(stored.stored.sha256);
    artifacts.push({
      id: input.id,
      kind: input.kind,
      redactionStatus: stored.report.redacted ? "redacted" : "clean",
      stored: stored.stored,
    });
    reports.push(stored.report);
  }

  for (const exhibit of config.declarations.exhibits) {
    const dest = join("exhibits", exhibit.id);
    const stored = storeOnce(
      exhibit.sourcePath,
      exhibit.sha256,
      dest,
      stageRoot,
      `exhibit.${exhibit.id}`,
      exhibit.id,
    );
    if (storedDigests.has(stored.stored.sha256)) {
      throw new RecorderError(
        "admission-failed",
        `duplicate stored artifact digest for ${exhibit.id}`,
      );
    }
    storedDigests.add(stored.stored.sha256);
    artifacts.push({
      id: exhibit.id,
      kind: "exhibit",
      redactionStatus: stored.report.redacted ? "redacted" : "clean",
      stored: stored.stored,
    });
    reports.push(stored.report);
  }

  // Exactly one identity per artifact is enforced by construction (reference XOR stored).
  for (const artifact of artifacts) {
    const hasRef = artifact.reference !== undefined;
    const hasStored = artifact.stored !== undefined;
    if (hasRef === hasStored) {
      throw new RecorderError(
        "admission-failed",
        `artifact ${artifact.id} must have exactly one identity`,
      );
    }
  }

  return { artifacts, report: combineReports(...reports) };
}

export function storeGeneratedJson(
  stageRoot: string,
  relativePath: string,
  value: unknown,
  location: string,
): { stored: StoredIdentity; report: ScanReport } {
  const scanned = scanJsonValue(value, location);
  const bytes = Buffer.from(
    `${JSON.stringify(scanned.value, null, 2)}\n`,
    "utf8",
  );
  const destAbs = join(stageRoot, relativePath);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, bytes);
  return {
    stored: {
      identity: "stored",
      path: relativePath,
      sha256: sha256Hex(bytes),
      byteLength: bytes.length,
    },
    report: scanned.report,
  };
}
