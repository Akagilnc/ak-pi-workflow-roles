import {
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
 * Load one complete auditor session (constitution + soul) afresh for each
 * audit invocation. Sole auditor opening-materials authority (#443): one
 * relative path source, one soul read, shared package material reader.
 */
export async function loadAuditorSoul(role: AuditorSoulRole): Promise<string> {
  const soul = await readPackageMaterial(auditorSoulRelativePath(role));
  if (soul.trim().length === 0) {
    throw new Error(`The ${role} auditor Soul is blank`);
  }
  const constitution = await readPackageMaterial("CLAUDE.md");
  return `${constitution}\n\n${soul}`;
}
