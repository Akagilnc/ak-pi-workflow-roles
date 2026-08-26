import {
  joinPackageMaterials,
  readPackageMaterial,
} from "./session-opening-materials.ts";

/** Active auditor seats. Fixer LLM auditor retired by #242; souls/fixer-auditor.md retained on disk for possible re-enable. */
export const AUDITOR_SOUL_ROLES = [
  "judge",
  "reviewer",
  "doctor",
] as const;

export type AuditorSoulRole = (typeof AUDITOR_SOUL_ROLES)[number];

function auditorSoulRelativePath(role: AuditorSoulRole): string {
  return `souls/${role}-auditor.md`;
}

/**
 * Load one complete auditor session afresh for each audit invocation.
 * Roster (#470): factory constitution + role auditor soul + audit-law.
 * Blank-soul identity stays owned here; composition reuses joinPackageMaterials.
 */
export async function loadAuditorSoul(role: AuditorSoulRole): Promise<string> {
  const soulPath = auditorSoulRelativePath(role);
  const soul = await readPackageMaterial(soulPath);
  if (soul.trim().length === 0) {
    throw new Error(`The ${role} auditor Soul is blank`);
  }
  return joinPackageMaterials(["CLAUDE.md", soulPath, "souls/audit-law.md"]);
}
