/**
 * Packaged engine method-material seam (#356 T1 / ADR 0069).
 * Legal engine names = directory stems under resources/engines/ — no code whitelist.
 * Material body is data for the LLM, not a code contract.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ENGINE_MATERIAL_RELATIVE_ROOT = "resources/engines" as const;

export type EngineSessionMaterial = Readonly<{
  name: string;
  materialPath: string;
}>;

/** Non-empty, trimmed, no path separators or traversal. */
export function isEngineNameSyntax(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.trim() !== name) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name.includes("..")) return false;
  return true;
}

export function engineMaterialRelativeDirectory(): string {
  return ENGINE_MATERIAL_RELATIVE_ROOT;
}

export function resolveEngineMaterialDirectory(packageRoot: string): string {
  return join(packageRoot, ENGINE_MATERIAL_RELATIVE_ROOT);
}

/**
 * Enumerate legal engine names from packaged material files.
 * Only `*.md` stems that pass name syntax are legal.
 */
export function listEngineMaterialNames(packageRoot: string): readonly string[] {
  const dir = resolveEngineMaterialDirectory(packageRoot);
  if (!existsSync(dir)) return Object.freeze([]);
  const names = readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length))
    .filter((stem) => isEngineNameSyntax(stem))
    .sort();
  return Object.freeze([...names]);
}

export function resolveEngineMaterialPath(
  packageRoot: string,
  name: string,
): string {
  const legal = assertLegalEngineName(packageRoot, name);
  return join(resolveEngineMaterialDirectory(packageRoot), `${legal}.md`);
}

/**
 * Assert `name` is a legal engine material stem under packageRoot.
 * Returns the canonical name on success; throws Error on illegal.
 */
export function assertLegalEngineName(packageRoot: string, name: string): string {
  if (!isEngineNameSyntax(name)) {
    throw new Error(`illegal engine name: ${name}`);
  }
  const legal = listEngineMaterialNames(packageRoot);
  if (!legal.includes(name)) {
    throw new Error(
      `unknown engine: ${name} (known: ${legal.length === 0 ? "(none)" : legal.join(", ")})`,
    );
  }
  return name;
}

/**
 * Resolve optional engine options into session material coordinates.
 * No engine → undefined (caller keeps default prompt bytes).
 */
export function engineSessionMaterialFromOptions(options: {
  engine?: string;
  packageRoot?: string;
}): EngineSessionMaterial | undefined {
  if (options.engine === undefined) return undefined;
  if (options.packageRoot === undefined || options.packageRoot.trim() === "") {
    throw new Error("packageRoot is required when engine is configured");
  }
  const name = assertLegalEngineName(options.packageRoot, options.engine);
  return Object.freeze({
    name,
    materialPath: resolveEngineMaterialPath(options.packageRoot, name),
  });
}

/**
 * Append engine method-material path delivery to session initial material lines.
 * No material → identity copy (byte-stable when joined the same way).
 * Delivers engine name + absolute material path only — never material body.
 */
export function appendEngineSessionMaterial(
  lines: readonly string[],
  engineMaterial?: EngineSessionMaterial,
): string[] {
  if (engineMaterial === undefined) {
    return [...lines];
  }
  const out = [...lines];
  out.push("");
  out.push("Engine method material (read these bytes and follow them):");
  out.push(`- engine: ${engineMaterial.name}`);
  out.push(`- ${engineMaterial.materialPath}`);
  return out;
}
