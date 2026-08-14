/**
 * Issue-mode metric-family discovery (page composition point).
 *
 * B/C-wave slices register by adding one module file under
 * `src/taishi-metric-families/` — they do not edit this loader, entry,
 * ledger, or page envelope skeleton.
 *
 * Each family module exports `default` or `family` as TaishiMetricFamilyModule.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TaishiMetricFamilyModule } from "./taishi-metric-family.ts";

/** Production family-module directory (sibling of this loader). */
export const TAISHI_ISSUE_METRIC_FAMILIES_DIR = fileURLToPath(
  new URL("./taishi-metric-families/", import.meta.url),
);

function isFamilyModuleFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  if (name.includes(".test.")) return false;
  return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
}

function readFamilyExport(
  mod: Record<string, unknown>,
  fileName: string,
): TaishiMetricFamilyModule {
  const candidate = mod.default ?? mod.family;
  if (
    candidate === null
    || typeof candidate !== "object"
    || typeof (candidate as TaishiMetricFamilyModule).contribute !== "function"
    || typeof (candidate as TaishiMetricFamilyModule).id !== "string"
  ) {
    throw new Error(
      `taishi metric family module must export default|family module: ${fileName}`,
    );
  }
  return candidate as TaishiMetricFamilyModule;
}

/**
 * Discover family modules from the production family-module directory.
 * B-slice registration is drop-in: add a file under that directory only.
 */
export async function loadTaishiIssueMetricFamilies(): Promise<
  readonly TaishiMetricFamilyModule[]
> {
  const directory = TAISHI_ISSUE_METRIC_FAMILIES_DIR;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return [];
    }
    throw error;
  }

  const families: TaishiMetricFamilyModule[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (!isFamilyModuleFile(name)) continue;
    const href = pathToFileURL(join(directory, name)).href;
    const mod = (await import(href)) as Record<string, unknown>;
    families.push(readFamilyExport(mod, name));
  }
  return families;
}

/** Production registry — loaded once from the family-module directory. */
export const TAISHI_ISSUE_METRIC_FAMILIES: readonly TaishiMetricFamilyModule[] =
  await loadTaishiIssueMetricFamilies();
