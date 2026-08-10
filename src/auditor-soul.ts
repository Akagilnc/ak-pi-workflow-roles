import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Active auditor seats. Fixer LLM auditor retired by #242; souls/fixer-auditor.md retained on disk for possible re-enable. */
export const AUDITOR_SOUL_ROLES = [
  "judge",
  "reviewer",
  "doctor",
] as const;

export type AuditorSoulRole = (typeof AUDITOR_SOUL_ROLES)[number];

const auditorSoulPaths: Readonly<Record<AuditorSoulRole, string>> = Object.freeze({
  judge: fileURLToPath(new URL("../souls/judge-auditor.md", import.meta.url)),
  reviewer: fileURLToPath(
    new URL("../souls/reviewer-auditor.md", import.meta.url),
  ),
  doctor: fileURLToPath(new URL("../souls/doctor-auditor.md", import.meta.url)),
});

/** Load one complete auditor Soul afresh for each audit invocation. */
export async function loadAuditorSoul(role: AuditorSoulRole): Promise<string> {
  const soul = await readFile(auditorSoulPaths[role], "utf8");
  if (soul.trim().length === 0) {
    throw new Error(`The ${role} auditor Soul is blank`);
  }
  return soul;
}
