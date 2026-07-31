import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { parseSkillBlock, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { reviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

export type CanonicalSkillName = "tdd" | "code-review";

export type CanonicalSkillSnapshot = Readonly<{
  raw: string;
  path: string;
  baseDir: string;
  body: string;
  snapshotIdentity: ReviewerPromptIdentity;
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
    prompt: string,
    originalRequest: string,
  ): CanonicalSkillEvidence<Name> | undefined;
}>;

export type AnyCanonicalSkillBinding =
  | CanonicalSkillBinding<"tdd">
  | CanonicalSkillBinding<"code-review">;

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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Canonical ${name} Skill is unavailable at ${configuredPath}: ${message}`,
      { cause: error },
    );
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
    snapshotIdentity: reviewerPromptIdentity(raw),
  });
  const binding: CanonicalSkillBinding<typeof name> = {
    name,
    snapshot,
    invocation(originalRequest) {
      return `/skill:${name} ${originalRequest}`;
    },
    captureExpansion(prompt, originalRequest) {
      const parsed = parseSkillBlock(prompt);
      const matchedPath =
        parsed?.location === configuredPath
          ? configuredPath
          : parsed?.location === snapshot.path
            ? snapshot.path
            : undefined;
      const expectedContent = matchedPath === undefined
        ? undefined
        : `References are relative to ${dirname(matchedPath)}.\n\n${snapshot.body}`;
      const userMessage = parsed?.userMessage ?? "";
      if (
        parsed?.name !== name ||
        matchedPath === undefined ||
        parsed.content !== expectedContent ||
        userMessage !== originalRequest
      ) {
        return undefined;
      }
      return Object.freeze({
        name,
        location: parsed.location,
        content: parsed.content,
        userMessage,
      });
    },
  };
  return Object.freeze(binding) as AnyCanonicalSkillBinding;
}
