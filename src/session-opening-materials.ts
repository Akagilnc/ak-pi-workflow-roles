/**
 * Session opening materials (#443 / #524). Missing files fail as native readFile
 * errors. Main-role materials derive from PUBLIC_ROLE_RECORDS; gatekeeper seats
 * stay independent except notary (shared NOTARY_SESSION_MATERIALS). Navigator is
 * name-only here, not a public role record. Auditor composition stays in
 * loadAuditorSoul; loaders share joinPackageMaterials.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NOTARY_SESSION_MATERIALS,
  PUBLIC_ROLE_RECORDS,
  type PackagedRole,
} from "./packaged-role-registry.ts";

/**
 * Resolve the install package root from this module's location.
 * Works for src/ layout and for bundled artifacts under dist/ (walk up until
 * package.json + souls/ — the shipped material tree).
 */
function resolvePackageRootDir(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "souls"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Legacy fallback: module lived directly under src/.
  return fileURLToPath(new URL("..", moduleUrl));
}

const packageRootUrl = pathToFileURL(resolvePackageRootDir() + "/").href;

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

type PublicRoleMaterials = {
  readonly [Role in PackagedRole]: Extract<
    (typeof PUBLIC_ROLE_RECORDS)[number],
    { role: Role }
  >["sessionMaterials"];
};

/** Derived projection: public records + navigator name-only materials. */
export const MAIN_ROLE_SESSION_MATERIALS = {
  ...(Object.fromEntries(
    PUBLIC_ROLE_RECORDS.map((record) => [record.role, record.sessionMaterials]),
  ) as PublicRoleMaterials),
  navigator: ["CLAUDE.md", "souls/navigator.md"] as const,
} as const;

export type MainRoleSession = keyof typeof MAIN_ROLE_SESSION_MATERIALS;

export function loadMainRoleSessionMaterials(
  role: MainRoleSession,
): Promise<string> {
  return joinPackageMaterials(MAIN_ROLE_SESSION_MATERIALS[role]);
}

/** Gatekeeper province; notary reuses the public notary materials definition. */
export const GATEKEEPER_SESSION_MATERIALS = {
  gatekeeper: [
    "CLAUDE.md",
    "souls/gatekeeper.md",
    "souls/quality-law.md",
    "souls/gate-output-guide.md",
  ],
  inspector: [
    "CLAUDE.md",
    "souls/inspector.md",
    "souls/quality-law.md",
    "souls/gate-output-guide.md",
  ],
  notary: NOTARY_SESSION_MATERIALS,
} as const;

export type GatekeeperSessionRole = keyof typeof GATEKEEPER_SESSION_MATERIALS;

export function loadGatekeeperSessionMaterials(
  role: GatekeeperSessionRole,
): Promise<string> {
  return joinPackageMaterials(GATEKEEPER_SESSION_MATERIALS[role]);
}
