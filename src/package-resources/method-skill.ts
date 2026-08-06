/**
 * Package-owned role method Skill seam (ADR 0052 / #109).
 * Forced methods load from the installed package copy — never ambient home discovery.
 *
 * This module is intentionally free of @earendil-works/pi-coding-agent so the
 * public ak-role bin can load provenance/path without bundling peer runtime.
 */
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
export type PackagedMethodSkillName = "tdd";

export type PackagedMethodFileProvenance = Readonly<{
  sha256: string;
  byteLength: number;
}>;

export type PackagedMethodUpstreamProvenance = Readonly<{
  repository: string;
  path: string;
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

const REQUIRED_COMPANIONS: Readonly<
  Record<PackagedMethodSkillName, readonly string[]>
> = {
  tdd: ["tests.md", "mocking.md", "agents/openai.yaml"],
};

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
  if (!isRecord(raw.files)) {
    throw new Error(`Packaged method provenance files must be an object`);
  }
  const files: Record<string, PackagedMethodFileProvenance> = {};
  for (const [rel, entry] of Object.entries(raw.files)) {
    if (!isRecord(entry)) {
      throw new Error(`Packaged method provenance file entry must be an object: ${rel}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Packaged method provenance file sha256 invalid: ${rel}`);
    }
    if (typeof entry.byteLength !== "number" || !Number.isInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new Error(`Packaged method provenance file byteLength invalid: ${rel}`);
    }
    files[rel] = { sha256: entry.sha256, byteLength: entry.byteLength };
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

  // Verify every declared file digest against package bytes (no network).
  for (const [rel, expected] of Object.entries(provenance.files)) {
    const absolute = join(rootDirectory, rel);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      throw new PackagedMethodSkillUnavailableError(name, absolute, error);
    }
    const actualSha = sha256Hex(bytes);
    if (actualSha !== expected.sha256 || bytes.byteLength !== expected.byteLength) {
      throw new Error(
        `Packaged method file digest mismatch for ${name}/${rel}: expected ${expected.sha256}/${expected.byteLength}, got ${actualSha}/${bytes.byteLength}`,
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
