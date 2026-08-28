import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  NOTARY_SESSION_MATERIALS,
  PUBLIC_ROLE_RECORDS
} from "./packaged-role-registry.js";
const packageRootUrl = new URL("..", import.meta.url);
async function readPackageMaterial(relativePath) {
  return readFile(fileURLToPath(new URL(relativePath, packageRootUrl)), "utf8");
}
async function joinPackageMaterials(relativePaths) {
  const chunks = [];
  for (const relativePath of relativePaths) {
    chunks.push(await readPackageMaterial(relativePath));
  }
  return chunks.join("\n\n");
}
const MAIN_ROLE_SESSION_MATERIALS = {
  ...Object.fromEntries(
    PUBLIC_ROLE_RECORDS.map((record) => [record.role, record.sessionMaterials])
  ),
  navigator: ["CLAUDE.md", "souls/navigator.md"]
};
function loadMainRoleSessionMaterials(role) {
  return joinPackageMaterials(MAIN_ROLE_SESSION_MATERIALS[role]);
}
const GATEKEEPER_SESSION_MATERIALS = {
  gatekeeper: ["CLAUDE.md", "souls/gatekeeper.md", "souls/gate-output-guide.md"],
  inspector: [
    "CLAUDE.md",
    "souls/inspector.md",
    "souls/quality-law.md",
    "souls/gate-output-guide.md"
  ],
  notary: NOTARY_SESSION_MATERIALS
};
function loadGatekeeperSessionMaterials(role) {
  return joinPackageMaterials(GATEKEEPER_SESSION_MATERIALS[role]);
}
export {
  GATEKEEPER_SESSION_MATERIALS,
  MAIN_ROLE_SESSION_MATERIALS,
  joinPackageMaterials,
  loadGatekeeperSessionMaterials,
  loadMainRoleSessionMaterials,
  readPackageMaterial
};
