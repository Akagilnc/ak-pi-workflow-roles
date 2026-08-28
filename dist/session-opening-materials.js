/**
 * Session opening materials (#443 / #524): factory constitution + role soul +
 * role-owned extras, composed at the three existing loader seams. Missing files
 * fail as native readFile errors — no exists/hash/empty guards, no second loader.
 *
 * Public main-role materials and metadata derive from PUBLIC_ROLE_RECORDS
 * (packaged-role-registry). Gatekeeper province stays independent except notary,
 * which reuses the same NOTARY_SESSION_MATERIALS definition. Navigator is a
 * name-only resident seat — materials here, not a public role record.
 *
 * Auditor composition stays owned by loadAuditorSoul (blank-soul identity);
 * main roles and gatekeeper family share joinPackageMaterials here.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NOTARY_SESSION_MATERIALS, PUBLIC_ROLE_RECORDS, } from "./packaged-role-registry.js";
const packageRootUrl = new URL("..", import.meta.url);
/** Self-locate one package-relative material. Native I/O errors propagate. */
export async function readPackageMaterial(relativePath) {
    return readFile(fileURLToPath(new URL(relativePath, packageRootUrl)), "utf8");
}
/** Read materials in order and join with a blank line. */
export async function joinPackageMaterials(relativePaths) {
    const chunks = [];
    for (const relativePath of relativePaths) {
        chunks.push(await readPackageMaterial(relativePath));
    }
    return chunks.join("\n\n");
}
/** Navigator resident seat — name-only materials; not a public role record. */
const NAVIGATOR_SESSION_MATERIALS = ["CLAUDE.md", "souls/navigator.md"];
const PUBLIC_MAIN_ROLE_SESSION_MATERIALS = Object.fromEntries(PUBLIC_ROLE_RECORDS.map((record) => [record.role, record.sessionMaterials]));
/**
 * Read-only derived projection: public role materials from PUBLIC_ROLE_RECORDS
 * plus navigator name-only materials.
 */
export const MAIN_ROLE_SESSION_MATERIALS = {
    ...PUBLIC_MAIN_ROLE_SESSION_MATERIALS,
    navigator: NAVIGATOR_SESSION_MATERIALS,
};
export function loadMainRoleSessionMaterials(role) {
    return joinPackageMaterials(MAIN_ROLE_SESSION_MATERIALS[role]);
}
/**
 * Gatekeeper province seats. Institution set is independent; notary references
 * the same NOTARY_SESSION_MATERIALS definition as the public notary record.
 */
export const GATEKEEPER_SESSION_MATERIALS = {
    gatekeeper: ["CLAUDE.md", "souls/gatekeeper.md", "souls/gate-output-guide.md"],
    inspector: [
        "CLAUDE.md",
        "souls/inspector.md",
        "souls/quality-law.md",
        "souls/gate-output-guide.md",
    ],
    notary: NOTARY_SESSION_MATERIALS,
};
export function loadGatekeeperSessionMaterials(role) {
    return joinPackageMaterials(GATEKEEPER_SESSION_MATERIALS[role]);
}
