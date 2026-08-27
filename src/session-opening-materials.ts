/**
 * Session opening materials (#443): factory constitution + role soul + role-owned
 * extras, composed at the three existing loader seams. Missing files fail as
 * native readFile errors — no exists/hash/empty guards, no second loader.
 *
 * Auditor composition stays owned by loadAuditorSoul (blank-soul identity);
 * main roles and gatekeeper family share joinPackageMaterials here.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRootUrl = new URL("..", import.meta.url);

/** Self-locate one package-relative material. Native I/O errors propagate. */
export async function readPackageMaterial(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, packageRootUrl)), "utf8");
}

/** Read materials in order and join with a blank line. */
export async function joinPackageMaterials(
  relativePaths: readonly string[],
): Promise<string> {
  const chunks: string[] = [];
  for (const relativePath of relativePaths) {
    chunks.push(await readPackageMaterial(relativePath));
  }
  return chunks.join("\n\n");
}

/** Seven public main roles + Navigator. Ticket #443 injection roster. */
export const MAIN_ROLE_SESSION_MATERIALS = {
  judge: [
    "CLAUDE.md",
    "souls/judge.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
    "souls/judge-output-guide.md",
  ],
  fixer: [
    "CLAUDE.md",
    "souls/fixer.md",
    "souls/quality-law.md",
    "souls/fixer-output-guide.md",
  ],
  coder: [
    "CLAUDE.md",
    "souls/coder.md",
    "souls/quality-law.md",
    "souls/coder-output-guide.md",
  ],
  reviewer: [
    "CLAUDE.md",
    "souls/reviewer.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
  ],
  collector: ["CLAUDE.md", "souls/collector.md"],
  doctor: ["CLAUDE.md", "souls/doctor.md"],
  merger: ["CLAUDE.md", "souls/merger.md"],
  notary: ["CLAUDE.md", "souls/notary.md", "souls/gate-output-guide.md"],
  navigator: ["CLAUDE.md", "souls/navigator.md"],
} as const;

export type MainRoleSession = keyof typeof MAIN_ROLE_SESSION_MATERIALS;

export function loadMainRoleSessionMaterials(
  role: MainRoleSession,
): Promise<string> {
  return joinPackageMaterials(MAIN_ROLE_SESSION_MATERIALS[role]);
}

/** Gatekeeper province + Inspector/Notary officer sessions. */
export const GATEKEEPER_SESSION_MATERIALS = {
  gatekeeper: ["CLAUDE.md", "souls/gatekeeper.md", "souls/gate-output-guide.md"],
  inspector: [
    "CLAUDE.md",
    "souls/inspector.md",
    "souls/quality-law.md",
    "souls/gate-output-guide.md",
  ],
  notary: ["CLAUDE.md", "souls/notary.md", "souls/gate-output-guide.md"],
} as const;

export type GatekeeperSessionRole = keyof typeof GATEKEEPER_SESSION_MATERIALS;

export function loadGatekeeperSessionMaterials(
  role: GatekeeperSessionRole,
): Promise<string> {
  return joinPackageMaterials(GATEKEEPER_SESSION_MATERIALS[role]);
}
