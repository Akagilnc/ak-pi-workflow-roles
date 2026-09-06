import {
  joinPackageMaterials,
  readPackageMaterial,
} from "./session-opening-materials.ts";

/**
 * Active auditor seats.
 * Fixer LLM auditor retired by #242; reviewer-side 审刑院 gate retired by #495 S6.
 * souls/fixer-auditor.md and souls/reviewer-auditor.md retained-or-deleted on disk as owner decisions; not active.
 */
export const AUDITOR_SOUL_ROLES = [
  "judge",
  "doctor",
] as const;

export type AuditorSoulRole = (typeof AUDITOR_SOUL_ROLES)[number];

/**
 * Audited-subject input for public 审刑院 (#675 owner):
 * 「审的是谁」is an input selecting judge-auditor.md / doctor-auditor.md —
 * not a caller-identity fork. Same env for direct `ak-role auditor --subject`
 * and nested compliance summons.
 */
export const AK_ROLE_AUDITOR_SUBJECT_ENV = "AK_ROLE_AUDITOR_SUBJECT" as const;

function auditorSoulRelativePath(role: AuditorSoulRole): string {
  return `souls/${role}-auditor.md`;
}

/**
 * #470 auditor session materials. Judge carries audit-law + quality-law; doctor does
 * not (御批四: 参审席 = 大理寺主会话 + 其审计席; 太医线不动).
 * Reviewer auditor roster removed with #495 S6 gate retirement.
 * #675 owner: no generic auditor.md — subject selects this table.
 */
export const AUDITOR_SESSION_MATERIALS = {
  judge: [
    "CLAUDE.md",
    "souls/judge-auditor.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
  ],
  doctor: ["CLAUDE.md", "souls/doctor-auditor.md"],
} as const satisfies Record<
  AuditorSoulRole,
  readonly [string, string, ...(readonly string[])]
>;

export function isAuditorSoulRole(value: unknown): value is AuditorSoulRole {
  return value === "judge" || value === "doctor";
}

/** Resolve audited subject from explicit value or the subject-input env. */
export function resolveAuditorSubject(raw?: string): AuditorSoulRole {
  const value =
    typeof raw === "string" && raw.trim() !== ""
      ? raw.trim()
      : typeof process.env[AK_ROLE_AUDITOR_SUBJECT_ENV] === "string"
        ? process.env[AK_ROLE_AUDITOR_SUBJECT_ENV].trim()
        : "";
  if (!isAuditorSoulRole(value)) {
    throw new Error(
      `auditor subject must be judge|doctor (input --subject / ${AK_ROLE_AUDITOR_SUBJECT_ENV}), got ${value === "" ? "(missing)" : value}`,
    );
  }
  return value;
}

/**
 * Load one complete auditor session afresh for each audit invocation.
 * Blank-soul identity stays owned here; composition reuses joinPackageMaterials.
 * Subject selects the materials table (#675 owner — same for direct and nested).
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

/** Runtime loader: subject input decides which soul file to assemble. */
export async function loadAuditorSoulFromSubjectInput(raw?: string): Promise<string> {
  return loadAuditorSoul(resolveAuditorSubject(raw));
}
