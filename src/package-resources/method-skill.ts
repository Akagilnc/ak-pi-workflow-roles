/**
 * Package-owned role method Skill seam (ADR 0052 / #109).
 * Forced methods load from the installed package copy — never ambient home discovery.
 *
 * This module is intentionally free of @earendil-works/pi-coding-agent so the
 * public ak-role bin can load provenance/path without bundling peer runtime.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../sha256.ts";

/** Package-side unavailable method Skill (mirrors CanonicalSkillUnavailableError identity). */
export class PackagedMethodSkillUnavailableError extends Error {
  readonly code = "canonical-skill-unavailable" as const;
  constructor(
    readonly skillName: PackagedMethodSkillName,
    path: string,
    cause: unknown,
  ) {
    super(`Canonical ${skillName} Skill is unavailable at ${path}`, { cause });
    this.name = "CanonicalSkillUnavailableError";
  }
}

/** Method Skill names shipped as package resources under resources/methods/. */
export type PackagedMethodSkillName =
  | "tdd"
  | "diagnosing-bugs"
  | "code-review"
  | "resolving-merge-conflicts";

export type PackagedMethodFileProvenance = Readonly<{
  sha256: string;
  byteLength: number;
  /** Independent upstream git blob OID (sha1) for the exact file bytes. */
  gitBlob: string;
}>;

export type PackagedMethodUpstreamProvenance = Readonly<{
  repository: string;
  path: string;
  /** Immutable upstream commit (full lowercase git object id). */
  commit: string;
  /** Immutable upstream release tag when the snapshot is tag-addressable. */
  tag?: string;
  /** Immutable upstream version label when no single tag is the pin. */
  version?: string;
  license: string;
  copyright: string;
  attribution: string;
}>;

/** Exact upstream provenance + per-file digests recorded beside the skill body. */
export type PackagedMethodSkillProvenance = Readonly<{
  name: PackagedMethodSkillName;
  kind: "role-method-skill";
  upstream: PackagedMethodUpstreamProvenance;
  packageAdaptation: string;
  files: Readonly<Record<string, PackagedMethodFileProvenance>>;
}>;

export type PackagedMethodSkillMaterial = Readonly<{
  name: PackagedMethodSkillName;
  /** Absolute directory containing SKILL.md and companions. */
  rootDirectory: string;
  /** Absolute SKILL.md path (pass to Pi `--skill`). */
  skillPath: string;
  raw: string;
  body: string;
  provenance: PackagedMethodSkillProvenance;
  /** Companion relative paths present beside SKILL.md (tests/mocking/...). */
  companionRelativePaths: readonly string[];
}>;

const METHOD_SKILL_RELATIVE_ROOT = "resources/methods" as const;
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
const GIT_BLOB_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const REQUIRED_COMPANIONS: Readonly<
  Record<PackagedMethodSkillName, readonly string[]>
> = {
  tdd: ["tests.md", "mocking.md", "agents/openai.yaml"],
  "diagnosing-bugs": ["agents/openai.yaml", "scripts/hitl-loop.template.sh"],
  "code-review": ["agents/openai.yaml"],
  "resolving-merge-conflicts": ["agents/openai.yaml"],
};

/** Git blob OID for raw file bytes (sha1 of `blob <size>\\0` + content). */
export function gitBlobOid(bytes: string | Uint8Array): string {
  const body =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  const header = Buffer.from(`blob ${body.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(body).digest("hex");
}

/** Minimal frontmatter strip — body after closing `---` fence (or full text). */
export function stripSkillFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.slice(end + "\n---".length);
  return after.replace(/^\r?\n/, "");
}

export function packagedMethodSkillRelativeDirectory(
  name: PackagedMethodSkillName,
): string {
  return `${METHOD_SKILL_RELATIVE_ROOT}/${name}`;
}

export function resolvePackagedMethodSkillRoot(
  packageRoot: string,
  name: PackagedMethodSkillName,
): string {
  return join(packageRoot, packagedMethodSkillRelativeDirectory(name));
}

export function resolvePackagedMethodSkillPath(
  packageRoot: string,
  name: PackagedMethodSkillName,
): string {
  return join(resolvePackagedMethodSkillRoot(packageRoot, name), "SKILL.md");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProvenance(
  raw: unknown,
  expectedName: PackagedMethodSkillName,
): PackagedMethodSkillProvenance {
  if (!isRecord(raw)) {
    throw new Error(`Packaged method provenance must be an object for ${expectedName}`);
  }
  if (raw.name !== expectedName) {
    throw new Error(
      `Packaged method provenance name mismatch: expected ${expectedName}, got ${String(raw.name)}`,
    );
  }
  if (raw.kind !== "role-method-skill") {
    throw new Error(`Packaged method provenance kind must be role-method-skill`);
  }
  if (typeof raw.packageAdaptation !== "string" || raw.packageAdaptation.trim() === "") {
    throw new Error(`Packaged method provenance packageAdaptation must be nonblank`);
  }
  if (!isRecord(raw.upstream)) {
    throw new Error(`Packaged method provenance upstream must be an object`);
  }
  const upstream = raw.upstream;
  for (const key of [
    "repository",
    "path",
    "license",
    "copyright",
    "attribution",
  ] as const) {
    if (typeof upstream[key] !== "string" || upstream[key].trim() === "") {
      throw new Error(`Packaged method provenance upstream.${key} must be nonblank`);
    }
  }
  if (typeof upstream.commit !== "string" || !GIT_COMMIT_RE.test(upstream.commit)) {
    throw new Error(
      `Packaged method provenance upstream.commit must be a 40-char lowercase git object id`,
    );
  }
  const tag =
    typeof upstream.tag === "string" && upstream.tag.trim() !== ""
      ? upstream.tag.trim()
      : undefined;
  const version =
    typeof upstream.version === "string" && upstream.version.trim() !== ""
      ? upstream.version.trim()
      : undefined;
  if (tag === undefined && version === undefined) {
    throw new Error(
      `Packaged method provenance upstream must include nonblank tag or version`,
    );
  }
  if (!isRecord(raw.files)) {
    throw new Error(`Packaged method provenance files must be an object`);
  }
  const files: Record<string, PackagedMethodFileProvenance> = {};
  for (const [rel, entry] of Object.entries(raw.files)) {
    if (!isRecord(entry)) {
      throw new Error(`Packaged method provenance file entry must be an object: ${rel}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw new Error(`Packaged method provenance file sha256 invalid: ${rel}`);
    }
    if (
      typeof entry.byteLength !== "number" ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength < 0
    ) {
      throw new Error(`Packaged method provenance file byteLength invalid: ${rel}`);
    }
    if (typeof entry.gitBlob !== "string" || !GIT_BLOB_RE.test(entry.gitBlob)) {
      throw new Error(
        `Packaged method provenance file gitBlob must be a 40-char lowercase git object id: ${rel}`,
      );
    }
    files[rel] = {
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      gitBlob: entry.gitBlob,
    };
  }
  if (files["SKILL.md"] === undefined) {
    throw new Error(`Packaged method provenance must include SKILL.md`);
  }
  return Object.freeze({
    name: expectedName,
    kind: "role-method-skill",
    packageAdaptation: raw.packageAdaptation,
    upstream: Object.freeze({
      repository: upstream.repository as string,
      path: upstream.path as string,
      commit: upstream.commit,
      ...(tag === undefined ? {} : { tag }),
      ...(version === undefined ? {} : { version }),
      license: upstream.license as string,
      copyright: upstream.copyright as string,
      attribution: upstream.attribution as string,
    }),
    files: Object.freeze(files),
  });
}

/**
 * Load a package-owned method Skill and verify per-file provenance digests.
 * Does not consult HOME or ambient Skill discovery paths.
 */
export async function loadPackagedMethodSkillMaterial(
  packageRoot: string,
  name: PackagedMethodSkillName,
): Promise<PackagedMethodSkillMaterial> {
  const rootDirectory = resolvePackagedMethodSkillRoot(packageRoot, name);
  const skillPathConfigured = join(rootDirectory, "SKILL.md");
  const provenancePath = join(rootDirectory, "provenance.json");

  let provenanceRaw: string;
  try {
    provenanceRaw = await readFile(provenancePath, "utf8");
  } catch (error) {
    throw new PackagedMethodSkillUnavailableError(name, provenancePath, error);
  }
  let provenanceJson: unknown;
  try {
    provenanceJson = JSON.parse(provenanceRaw);
  } catch (error) {
    throw new Error(`Packaged method provenance is not valid JSON at ${provenancePath}`, {
      cause: error,
    });
  }
  const provenance = parseProvenance(provenanceJson, name);

  // Verify every declared file digest + independent git blob against package bytes (no network).
  for (const [rel, expected] of Object.entries(provenance.files)) {
    const absolute = join(rootDirectory, rel);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      throw new PackagedMethodSkillUnavailableError(name, absolute, error);
    }
    const actualSha = sha256Hex(bytes);
    const actualBlob = gitBlobOid(bytes);
    if (
      actualSha !== expected.sha256 ||
      bytes.byteLength !== expected.byteLength ||
      actualBlob !== expected.gitBlob
    ) {
      throw new Error(
        `Packaged method file digest mismatch for ${name}/${rel}: expected sha256=${expected.sha256} byteLength=${expected.byteLength} gitBlob=${expected.gitBlob}, got sha256=${actualSha} byteLength=${bytes.byteLength} gitBlob=${actualBlob}`,
      );
    }
  }

  let skillPath: string;
  let raw: string;
  try {
    skillPath = await realpath(skillPathConfigured);
    raw = await readFile(skillPath, "utf8");
  } catch (error) {
    throw new PackagedMethodSkillUnavailableError(name, skillPathConfigured, error);
  }
  const body = stripSkillFrontmatter(raw).trim();
  if (body.length === 0) {
    throw new Error(`Canonical ${name} Skill is empty at ${skillPath}`);
  }

  const companionRelativePaths = REQUIRED_COMPANIONS[name].filter(
    (rel) => provenance.files[rel] !== undefined,
  );
  for (const rel of REQUIRED_COMPANIONS[name]) {
    if (provenance.files[rel] === undefined) {
      throw new Error(
        `Packaged method ${name} missing required companion in provenance: ${rel}`,
      );
    }
  }

  return Object.freeze({
    name,
    rootDirectory,
    skillPath,
    raw,
    body,
    provenance,
    companionRelativePaths: Object.freeze([...companionRelativePaths]),
  });
}

/** Observed Pi-native method Skill expansion (structured skill block, not free prose). */
export type ObservedPackagedMethodSkillInvocation = Readonly<{
  name: PackagedMethodSkillName;
  location: string;
}>;

/**
 * Observe one Pi-native packaged method Skill expansion from a user-turn text.
 * Matches the structured `<skill name location>` block format only; rejects ambient
 * home locations that are not in the allowed package path set.
 */
export function observePackagedMethodSkillInvocation(
  text: string,
  expected: {
    readonly name: PackagedMethodSkillName;
    readonly allowedLocations: readonly string[];
  },
): ObservedPackagedMethodSkillInvocation | undefined {
  // Structured skill-block grammar (same shape Pi expands); not free-text classification.
  if (!text.startsWith("<skill name=\"")) return undefined;
  const nameStart = "<skill name=\"".length;
  const nameEnd = text.indexOf("\"", nameStart);
  if (nameEnd <= nameStart) return undefined;
  const name = text.slice(nameStart, nameEnd);
  if (name !== expected.name) return undefined;
  const locationMarker = "\" location=\"";
  if (!text.startsWith(locationMarker, nameEnd)) return undefined;
  const locationStart = nameEnd + locationMarker.length;
  const locationEnd = text.indexOf("\"", locationStart);
  if (locationEnd <= locationStart) return undefined;
  const location = text.slice(locationStart, locationEnd);
  const openTail = ">\n";
  if (!text.startsWith(openTail, locationEnd + 1)) return undefined;
  const closeTag = "\n</skill>";
  const closeAt = text.indexOf(closeTag, locationEnd + 1 + openTail.length);
  if (closeAt === -1) return undefined;
  const afterClose = text.slice(closeAt + closeTag.length);
  if (afterClose.length > 0 && !afterClose.startsWith("\n")) return undefined;
  if (!expected.allowedLocations.includes(location)) return undefined;
  return Object.freeze({ name: expected.name, location });
}
