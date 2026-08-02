import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const AUDITOR_SOUL_ROLES = [
  "judge",
  "fixer",
  "reviewer",
  "doctor",
] as const;

export type AuditorSoulRole = (typeof AUDITOR_SOUL_ROLES)[number];

export const AUDITOR_SOUL_PATHS: Readonly<Record<AuditorSoulRole, string>> = {
  judge: fileURLToPath(new URL("../souls/judge-auditor.md", import.meta.url)),
  fixer: fileURLToPath(new URL("../souls/fixer-auditor.md", import.meta.url)),
  reviewer: fileURLToPath(
    new URL("../souls/reviewer-auditor.md", import.meta.url),
  ),
  doctor: fileURLToPath(new URL("../souls/doctor-auditor.md", import.meta.url)),
};

/** Load one complete auditor Soul afresh for each audit invocation. */
export async function loadAuditorSoul(role: AuditorSoulRole): Promise<string> {
  const soul = await readFile(AUDITOR_SOUL_PATHS[role], "utf8");
  if (soul.trim().length === 0) {
    throw new Error(`The ${role} auditor Soul is blank`);
  }
  return soul;
}
