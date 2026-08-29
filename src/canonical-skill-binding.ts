import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HostSkillExpansionEvidence } from "./host-contracts.ts";
export type CanonicalSkillName = "tdd" | "code-review";

export type CanonicalSkillSnapshot = Readonly<{
  raw: string;
  path: string;
  baseDir: string;
  body: string;
  /** Plain skill text — no length/digest identity shell (ADR 0031). */
  snapshotIdentity: Readonly<{ text: string }>;
}>;

export type CanonicalSkillEvidence<Name extends CanonicalSkillName = CanonicalSkillName> = Readonly<{
  name: Name;
  location: string;
  content: string;
  userMessage: string;
}>;

export type CanonicalSkillBinding<Name extends CanonicalSkillName = CanonicalSkillName> = Readonly<{
  name: Name;
  snapshot: CanonicalSkillSnapshot;
  invocation(originalRequest: string): string;
  captureExpansion(
    evidence: HostSkillExpansionEvidence | undefined,
    originalRequest: string,
  ): CanonicalSkillEvidence<Name> | undefined;
}>;

export type AnyCanonicalSkillBinding =
  | CanonicalSkillBinding<"tdd">
  | CanonicalSkillBinding<"code-review">;

export function captureCanonicalSkillExpansion<Name extends CanonicalSkillName>(
  name: Name,
  snapshot: CanonicalSkillSnapshot,
  configuredPath: string,
  evidence: HostSkillExpansionEvidence | undefined,
  originalRequest: string,
): CanonicalSkillEvidence<Name> | undefined {
  const matchedPath =
    evidence?.location === configuredPath
      ? configuredPath
      : evidence?.location === snapshot.path
        ? snapshot.path
        : undefined;
  const expectedContent = matchedPath === undefined
    ? undefined
    : `References are relative to ${dirname(matchedPath)}.\n\n${snapshot.body}`;
  if (
    evidence?.name !== name
    || matchedPath === undefined
    || evidence.content !== expectedContent
    || evidence.userMessage !== originalRequest
  ) {
    return undefined;
  }
  return Object.freeze({ ...evidence, name });
}

export class CanonicalSkillUnavailableError extends Error {
  readonly code = "canonical-skill-unavailable" as const;
  constructor(readonly skillName: CanonicalSkillName, path: string, cause: unknown) {
    super(`Canonical ${skillName} Skill is unavailable at ${path}`, { cause });
    this.name = "CanonicalSkillUnavailableError";
  }
}

export async function loadCanonicalSkillBinding(
  name: CanonicalSkillName,
): Promise<AnyCanonicalSkillBinding> {
  const configuredPath = resolve(
    homedir(),
    `.agents/skills/${name}/SKILL.md`,
  );
  let path: string;
  let raw: string;
  try {
    path = await realpath(configuredPath);
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new CanonicalSkillUnavailableError(name, configuredPath, error);
  }
  const body = stripFrontmatter(raw).trim();
  if (body.length === 0) {
    throw new Error(`Canonical ${name} Skill is empty at ${path}`);
  }
  const snapshot: CanonicalSkillSnapshot = Object.freeze({
    raw,
    path,
    baseDir: dirname(path),
    body,
    snapshotIdentity: Object.freeze({ text: raw }),
  });
  const binding: CanonicalSkillBinding<typeof name> = {
    name,
    snapshot,
    invocation(originalRequest) {
      return `/skill:${name} ${originalRequest}`;
    },
    captureExpansion(evidence, originalRequest) {
      return captureCanonicalSkillExpansion(
        name,
        snapshot,
        configuredPath,
        evidence,
        originalRequest,
      );
    },
  };
  return Object.freeze(binding) as AnyCanonicalSkillBinding;
}
