/**
 * Packaged engine method-material seam (#356 T1 / ADR 0069 / #376 / #1167).
 * Engine names are owner pool-directive labels — not a closed material catalog.
 * Material body is optional data for the LLM, not a code contract.
 * Only path-safety syntax is checked at real I/O seams.
 * Delivery is startup readingMaterial (handbook bodies), never the transport prompt.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE_MATERIAL_RELATIVE_ROOT = "resources/engines" as const;
const ENGINE_DISPATCH_RELATIVE_PATH = "resources/engine-dispatch.md" as const;

export type EngineSessionMaterial = Readonly<{
  name: string;
  /**
   * Optional owner pool-directive model id for multi-model engines (#883).
   * Opaque pass-through coordinate for the seat — not validated against a catalog.
   */
  model?: string;
  /** Packaged per-engine handbook body when notes exist. */
  handbook?: string;
  /** Shared engine-dispatch.md body when the per-engine handbook exists. */
  dispatchHandbook?: string;
}>;

/** Project engine name + optional model for env / request / material spreads. */
export function pickEngineAxis(source: {
  readonly engine?: string | undefined;
  readonly engineModel?: string | undefined;
}): { engine?: string; engineModel?: string } {
  return {
    ...(source.engine === undefined ? {} : { engine: source.engine }),
    ...(source.engineModel === undefined ? {} : { engineModel: source.engineModel }),
  };
}

/** Non-empty trimmed opaque engine model label; empty/whitespace rejected. */
export function assertLegalEngineModel(model: string): string {
  if (typeof model !== "string" || model.trim() === "" || model.trim() !== model) {
    throw new Error(`illegal engine model: ${JSON.stringify(model)}`);
  }
  return model;
}

/** Non-empty, trimmed; reject only real path hazards at the I/O seam. */
export function isEngineNameSyntax(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.trim() !== name) return false;
  // Exact "." / ".." are directory aliases; consecutive dots inside a label are not.
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

export function engineMaterialRelativeDirectory(): string {
  return ENGINE_MATERIAL_RELATIVE_ROOT;
}

export function resolveEngineMaterialDirectory(packageRoot: string): string {
  return join(packageRoot, ENGINE_MATERIAL_RELATIVE_ROOT);
}

export function resolveEngineDispatchMaterialPath(packageRoot: string): string {
  return join(packageRoot, ENGINE_DISPATCH_RELATIVE_PATH);
}

/**
 * Enumerate packaged engine notes stems (discovery only — not a legal-name gate).
 * Only `*.md` stems that pass name syntax are listed.
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

/**
 * Build the packaged notes path for a syntax-legal engine name.
 * Does not require the file to exist (material is optional data).
 */
export function resolveEngineMaterialPath(
  packageRoot: string,
  name: string,
): string {
  const legal = assertLegalEngineName(name);
  return join(resolveEngineMaterialDirectory(packageRoot), `${legal}.md`);
}

/**
 * Path-safety syntax gate for engine labels at real I/O seams.
 * Returns the canonical name on success; throws Error on illegal syntax.
 * Does not consult any material catalog (ADR 0069: 引擎权威是 owner 池令；能力通用可插拔).
 */
export function assertLegalEngineName(name: string): string {
  if (!isEngineNameSyntax(name)) {
    throw new Error(`illegal engine name: ${name}`);
  }
  return name;
}

/**
 * Resolve optional engine options into session material coordinates.
 * No engine → undefined (caller keeps default prompt bytes).
 * Engine with packaged notes → name + handbook body + dispatch handbook body.
 * Engine without notes → name only (pass-through; no warning).
 */
export function engineSessionMaterialFromOptions(options: {
  engine?: string;
  /** Optional pool-directive model id (#883); ignored when engine is absent. */
  engineModel?: string;
  packageRoot?: string;
}): EngineSessionMaterial | undefined {
  if (options.engine === undefined) return undefined;
  if (options.packageRoot === undefined || options.packageRoot.trim() === "") {
    throw new Error("packageRoot is required when engine is configured");
  }
  const name = assertLegalEngineName(options.engine);
  const model =
    options.engineModel === undefined
      ? undefined
      : assertLegalEngineModel(options.engineModel);
  const materialPath = resolveEngineMaterialPath(options.packageRoot, name);
  const modelField = model === undefined ? {} : { model };
  if (!existsSync(materialPath)) {
    return Object.freeze({ name, ...modelField });
  }
  const handbook = readFileSync(materialPath, "utf8");
  const dispatchPath = resolveEngineDispatchMaterialPath(options.packageRoot);
  const dispatchField = existsSync(dispatchPath)
    ? { dispatchHandbook: readFileSync(dispatchPath, "utf8") }
    : {};
  return Object.freeze({ name, handbook, ...dispatchField, ...modelField });
}

/**
 * Typed startup readingMaterial for a resolved engine session material.
 * Undefined engine → undefined (no outsourcing segment).
 */
export function engineSessionReadingMaterial(
  engineMaterial?: EngineSessionMaterial,
):
  | {
      readonly kind: "engine-session-material";
      readonly name: string;
      readonly model?: string;
      readonly handbook?: string;
      readonly dispatchHandbook?: string;
    }
  | undefined {
  if (engineMaterial === undefined) return undefined;
  return {
    kind: "engine-session-material" as const,
    name: engineMaterial.name,
    ...(engineMaterial.model === undefined ? {} : { model: engineMaterial.model }),
    ...(engineMaterial.handbook === undefined ? {} : { handbook: engineMaterial.handbook }),
    ...(engineMaterial.dispatchHandbook === undefined
      ? {}
      : { dispatchHandbook: engineMaterial.dispatchHandbook }),
  };
}
