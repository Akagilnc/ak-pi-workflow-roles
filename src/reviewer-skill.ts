import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { parseSkillBlock, stripFrontmatter } from "@earendil-works/pi-coding-agent";

export type CanonicalReviewerSkill = {
  raw: string;
  path: string;
  baseDir: string;
  body: string;
};

export type ReviewerSkillEvidence = {
  name: "code-review";
  location: string;
  content: string;
  userMessage: string;
};

export async function loadCanonicalReviewerSkill(): Promise<CanonicalReviewerSkill> {
  const configuredPath = resolve(
    homedir(),
    ".agents/skills/code-review/SKILL.md",
  );
  let path: string;
  let raw: string;
  try {
    path = await realpath(configuredPath);
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Canonical code-review Skill is unavailable at ${configuredPath}: ${message}`,
      { cause: error },
    );
  }
  const body = stripFrontmatter(raw).trim();
  if (body.length === 0) {
    throw new Error(`Canonical code-review Skill is empty at ${path}`);
  }
  return { raw, path, baseDir: dirname(path), body };
}

export function captureCanonicalReviewerSkillExpansion(
  prompt: string,
  originalRequest: string,
  skill: CanonicalReviewerSkill,
): ReviewerSkillEvidence | undefined {
  const parsed = parseSkillBlock(prompt);
  const expectedContent =
    `References are relative to ${skill.baseDir}.\n\n${skill.body}`;
  if (
    parsed?.name !== "code-review" ||
    parsed.location !== skill.path ||
    parsed.content !== expectedContent ||
    parsed.userMessage !== originalRequest
  ) {
    return undefined;
  }
  return {
    name: "code-review",
    location: parsed.location,
    content: parsed.content,
    userMessage: originalRequest,
  };
}
