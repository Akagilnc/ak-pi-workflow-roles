/**
 * Canonical Skill binding built from package-owned method material.
 * Lives beside the method seam but may import Pi skill parsers — used by the
 * Internal role runtime, not the public ak-role bin bundle.
 */
import { dirname } from "node:path";

import { parseSkillBlock } from "@earendil-works/pi-coding-agent";

import {
  type CanonicalSkillBinding,
  type CanonicalSkillEvidence,
  type CanonicalSkillName,
} from "../canonical-skill-binding.ts";
import { reviewerPromptIdentity } from "../reviewer-prompt-identity.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillName,
} from "./method-skill.ts";

/**
 * Build a CanonicalSkillBinding from package-owned material.
 * captureExpansion accepts the package skill path (configured or realpath).
 */
export async function loadPackagedCanonicalSkillBinding(
  packageRoot: string,
  name: PackagedMethodSkillName,
): Promise<CanonicalSkillBinding<Extract<CanonicalSkillName, PackagedMethodSkillName>>> {
  const material = await loadPackagedMethodSkillMaterial(packageRoot, name);
  const configuredPath = resolvePackagedMethodSkillPath(packageRoot, name);
  const snapshot = Object.freeze({
    raw: material.raw,
    path: material.skillPath,
    baseDir: dirname(material.skillPath),
    body: material.body,
    snapshotIdentity: reviewerPromptIdentity(material.raw),
  });

  const binding: CanonicalSkillBinding<"tdd"> = {
    name: "tdd",
    snapshot,
    invocation(originalRequest) {
      return `/skill:tdd ${originalRequest}`;
    },
    captureExpansion(prompt, originalRequest): CanonicalSkillEvidence<"tdd"> | undefined {
      const parsed = parseSkillBlock(prompt);
      const matchedPath =
        parsed?.location === configuredPath
          ? configuredPath
          : parsed?.location === snapshot.path
            ? snapshot.path
            : undefined;
      const expectedContent =
        matchedPath === undefined
          ? undefined
          : `References are relative to ${dirname(matchedPath)}.\n\n${snapshot.body}`;
      const userMessage = parsed?.userMessage ?? "";
      if (
        parsed?.name !== "tdd" ||
        matchedPath === undefined ||
        parsed.content !== expectedContent ||
        userMessage !== originalRequest
      ) {
        return undefined;
      }
      return Object.freeze({
        name: "tdd" as const,
        location: parsed.location,
        content: parsed.content,
        userMessage,
      });
    },
  };
  return Object.freeze(binding);
}
