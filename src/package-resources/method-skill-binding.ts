/**
 * Canonical Skill binding built from package-owned method material.
 * Lives beside the method seam — used by the Internal role runtime, not the
 * public ak-role bin bundle.
 */
import { dirname } from "node:path";

import {
  captureCanonicalSkillExpansion,
  type CanonicalSkillBinding,
  type CanonicalSkillName,
} from "../canonical-skill-binding.ts";
import {
  loadPackagedMethodSkillMaterial,
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
    snapshotIdentity: Object.freeze({ text: material.raw }),
  });

  const binding: CanonicalSkillBinding<Name> = {
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
  return Object.freeze(binding);
}
