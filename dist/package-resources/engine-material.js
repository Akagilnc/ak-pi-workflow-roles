/**
 * Packaged engine method-material seam (#356 T1 / ADR 0069 / #376).
 * Engine names are owner pool-directive labels — not a closed material catalog.
 * Material body is optional data for the LLM, not a code contract.
 * Only path-safety syntax is checked at real I/O seams.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const ENGINE_MATERIAL_RELATIVE_ROOT = "resources/engines";
/** Non-empty, trimmed; reject only real path hazards at the I/O seam. */
export function isEngineNameSyntax(name) {
    if (typeof name !== "string")
        return false;
    if (name.length === 0 || name.trim() !== name)
        return false;
    // Exact "." / ".." are directory aliases; consecutive dots inside a label are not.
    if (name === "." || name === "..")
        return false;
    if (name.includes("/") || name.includes("\\") || name.includes("\0"))
        return false;
    return true;
}
export function engineMaterialRelativeDirectory() {
    return ENGINE_MATERIAL_RELATIVE_ROOT;
}
export function resolveEngineMaterialDirectory(packageRoot) {
    return join(packageRoot, ENGINE_MATERIAL_RELATIVE_ROOT);
}
/**
 * Enumerate packaged engine notes stems (discovery only — not a legal-name gate).
 * Only `*.md` stems that pass name syntax are listed.
 */
export function listEngineMaterialNames(packageRoot) {
    const dir = resolveEngineMaterialDirectory(packageRoot);
    if (!existsSync(dir))
        return Object.freeze([]);
    const names = readdirSync(dir)
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => entry.slice(0, -".md".length))
        .filter((stem) => isEngineNameSyntax(stem))
        .sort();
    return Object.freeze([...names]);
}
/**
 * Build the packaged notes path for a syntax-legal engine name.
 * Does not require the file to exist (material is optional data).
 */
export function resolveEngineMaterialPath(packageRoot, name) {
    const legal = assertLegalEngineName(name);
    return join(resolveEngineMaterialDirectory(packageRoot), `${legal}.md`);
}
/**
 * Path-safety syntax gate for engine labels at real I/O seams.
 * Returns the canonical name on success; throws Error on illegal syntax.
 * Does not consult any material catalog (ADR 0069 pool-directive axis).
 */
export function assertLegalEngineName(name) {
    if (!isEngineNameSyntax(name)) {
        throw new Error(`illegal engine name: ${name}`);
    }
    return name;
}
/**
 * Resolve optional engine options into session material coordinates.
 * No engine → undefined (caller keeps default prompt bytes).
 * Engine with packaged notes → name + absolute material path.
 * Engine without notes → name only (pass-through; no warning).
 */
export function engineSessionMaterialFromOptions(options) {
    if (options.engine === undefined)
        return undefined;
    if (options.packageRoot === undefined || options.packageRoot.trim() === "") {
        throw new Error("packageRoot is required when engine is configured");
    }
    const name = assertLegalEngineName(options.engine);
    const materialPath = resolveEngineMaterialPath(options.packageRoot, name);
    if (existsSync(materialPath)) {
        return Object.freeze({ name, materialPath });
    }
    return Object.freeze({ name });
}
/**
 * Append engine method-material delivery to session initial material lines.
 * No engine → identity copy (byte-stable when joined the same way).
 * With engine → Chinese neutral header + engine name; notes also carry absolute material path.
 * Never delivers material body.
 */
export function appendEngineSessionMaterial(lines, engineMaterial) {
    if (engineMaterial === undefined) {
        return [...lines];
    }
    const out = [...lines];
    out.push("");
    out.push("本次配置的劳务引擎及其手册：");
    out.push(`- engine: ${engineMaterial.name}`);
    if (engineMaterial.materialPath !== undefined) {
        out.push(`- ${engineMaterial.materialPath}`);
    }
    return out;
}
