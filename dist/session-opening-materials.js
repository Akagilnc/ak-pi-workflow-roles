/**
 * Session opening materials (#443 / #524). Missing files fail as native readFile
 * errors. Main-role materials derive from PUBLIC_ROLE_RECORDS; gatekeeper seats
 * stay independent except notary (shared NOTARY_SESSION_MATERIALS). Navigator is
 * name-only here, not a public role record. Auditor composition stays in
 * loadAuditorSoul; loaders share joinPackageMaterials.
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
/** Derived projection: public records + navigator name-only materials. */
export const MAIN_ROLE_SESSION_MATERIALS = {
    ...Object.fromEntries(PUBLIC_ROLE_RECORDS.map((record) => [record.role, record.sessionMaterials])),
    navigator: ["CLAUDE.md", "souls/navigator.md"],
};
export function loadMainRoleSessionMaterials(role) {
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
};
export function loadGatekeeperSessionMaterials(role) {
    return joinPackageMaterials(GATEKEEPER_SESSION_MATERIALS[role]);
}
