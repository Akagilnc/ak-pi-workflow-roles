/**
 * Canonical Skill binding built from package-owned method material.
 * Lives beside and reuses the package-owned method Skill observation seam.
 */
import { dirname } from "node:path";

import {
  type CanonicalSkillBinding,
  type CanonicalSkillEvidence,
  type CanonicalSkillName,
} from "../canonical-skill-binding.ts";
import { reviewerPromptIdentity } from "../reviewer-prompt-identity.ts";
import {
  loadPackagedMethodSkillMaterial,
  observePackagedMethodSkillInvocation,
  resolvePackagedMethodSkillPath,
  type PackagedMethodSkillName,
} from "./method-skill.ts";

type PackagedCanonicalSkillName = Extract<
  PackagedMethodSkillName,
  CanonicalSkillName
>;

/**
 * Build a CanonicalSkillBinding from package-owned material.
 * captureExpansion accepts the package skill path (configured or realpath).
 */
export async function loadPackagedCanonicalSkillBinding<
  Name extends PackagedCanonicalSkillName,
>(
  packageRoot: string,
  name: Name,
): Promise<CanonicalSkillBinding<Name>> {
  // Forced expansion bindings are only defined for canonical completion-gated skills.
  // Optional Fixer diagnosing-bugs stays available via --skill without this binding.
  const material = await loadPackagedMethodSkillMaterial(packageRoot, name);
  const configuredPath = resolvePackagedMethodSkillPath(packageRoot, name);
  const snapshot = Object.freeze({
    raw: material.raw,
    path: material.skillPath,
    baseDir: dirname(material.skillPath),
    body: material.body,
    snapshotIdentity: reviewerPromptIdentity(material.raw),
  });

  const binding: CanonicalSkillBinding<Name> = {
    name,
    snapshot,
    invocation(originalRequest) {
      return `/skill:${name} ${originalRequest}`;
    },
    captureExpansion(
      prompt,
      originalRequest,
    ): CanonicalSkillEvidence<Name> | undefined {
      const parsed = observePackagedMethodSkillInvocation(prompt, {
        name,
        allowedLocations: [configuredPath, snapshot.path],
        includeExpansionIdentity: true,
      });
      const matchedPath = parsed?.location;
      const expectedContent =
        matchedPath === undefined
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
        content: parsed.content!,
        userMessage,
      });
    },
  };
  return Object.freeze(binding);
}
