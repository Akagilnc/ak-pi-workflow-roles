import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #603: published non-bundle dist graph must stay closed under relative imports.
 * After untracking committed dist, prepack rebuild is the sole inventory — every
 * relative edge from a shipped dist module must resolve to a file that build
 * actually emitted (or that the pack carries beside it).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { materializePackageTree } from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);

const RELATIVE_IMPORT_RE =
  /(?:from\s*|import\s*\(\s*)(["'])(\.[^"']+)\1/g;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listJsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        out.push(path);
      }
    }
  };
  await walk(dir);
  return out;
}

async function resolveRelativeTarget(
  fromFile: string,
  specifier: string,
): Promise<string> {
  const base = resolve(dirname(fromFile), specifier);
  if (await pathExists(base)) return base;
  if (await pathExists(`${base}.js`)) return `${base}.js`;
  if (await pathExists(`${base}.mjs`)) return `${base}.mjs`;
  if (await pathExists(join(base, "index.js"))) return join(base, "index.js");
  return base;
}

/**
 * Walk every relative import under dist/. Missing targets are structured
 * facts (importer + specifier + resolved path) — no free-text oracles.
 */
async function missingRelativeImports(distRoot: string): Promise<
  Array<{ from: string; specifier: string; resolved: string }>
> {
  const missing: Array<{ from: string; specifier: string; resolved: string }> =
    [];
  const files = await listJsFiles(distRoot);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      const specifier = match[2]!;
      const resolved = await resolveRelativeTarget(file, specifier);
      if (await pathExists(resolved)) continue;
      missing.push({
        from: relative(distRoot, file).split("\\").join("/"),
        specifier,
        resolved: relative(distRoot, resolved).split("\\").join("/"),
      });
    }
  }
  return missing;
}

test(
  "fresh-build published dist relative-import graph is closed",
  async () => {
    await withTempRoot("ak-dist-closure-", async (root) => {
      await materializePackageTree(root, { nodeModules: "symlink" });
      await execFileAsync("npm", ["run", "build"], {
        cwd: root,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
        },
      });

      const distRoot = resolve(root, "dist");
      const missing = await missingRelativeImports(distRoot);
      assert.deepEqual(
        missing,
        [],
        `published dist relative-import graph has gaps: ${JSON.stringify(missing)}`,
      );

      // Loadable proof for the attendance root that failed on clean publish.
      await import(
        pathToFileURL(resolve(distRoot, "navigator-attendance.js")).href
      );
        });
  },
);
