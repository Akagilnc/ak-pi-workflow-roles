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
 * #470 auditor session materials. Judge/reviewer carry audit-law; doctor does
 * not (御批四: 参审四席 = 大理寺/御史台主会话 + 两审计席; 太医线不动).
 */
export const AUDITOR_SESSION_MATERIALS = {
  judge: [
    "CLAUDE.md",
    "souls/judge-auditor.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
  ],
  reviewer: ["CLAUDE.md", "souls/reviewer-auditor.md", "souls/audit-law.md"],
  doctor: ["CLAUDE.md", "souls/doctor-auditor.md"],
} as const satisfies Record<
  AuditorSoulRole,
  readonly [string, string, ...(readonly string[])]
>;

/**
 * Load one complete auditor session afresh for each audit invocation.
 * Blank-soul identity stays owned here; composition reuses joinPackageMaterials.
 */
export async function loadAuditorSoul(role: AuditorSoulRole): Promise<string> {
  const materials = AUDITOR_SESSION_MATERIALS[role];
  const soulPath = auditorSoulRelativePath(role);
  const soul = await readPackageMaterial(soulPath);
  if (soul.trim().length === 0) {
    throw new Error(`The ${role} auditor Soul is blank`);
  }
  return joinPackageMaterials(materials);
}
