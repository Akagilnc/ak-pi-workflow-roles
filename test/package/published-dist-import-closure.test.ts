/**
 * #603 / #852: published dist relative-import graph must stay closed.
 * Fresh build is the sole inventory — every real relative edge from a shipped
 * dist JS/MJS module (including bundled artifacts) must resolve under that
 * same dist tree. Syntax-aware resolution reuses the build wheel (esbuild);
 * comments, JSDoc type imports, and embedded diagnostic strings are not edges.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { materializePackageTree } from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);

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

/**
 * Syntax-aware relative-import closure over every fresh dist JS/MJS entry.
 * Reuses esbuild (same resolver the package build already owns): bundle
 * resolution follows real relative edges; write:false keeps this a check.
 * Missing real targets reject; JSDoc/comments/strings are not edges.
 */
async function assertRelativeImportClosure(distRoot: string): Promise<void> {
  const files = await listJsFiles(distRoot);
  assert.ok(files.length > 0, "dist emitted no JS/MJS entries");
  await build({
    absWorkingDir: distRoot,
    entryPoints: files,
    // outdir required for multi-entry even with write:false
    outdir: join(distRoot, ".closure-check-out"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
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
      await assertRelativeImportClosure(distRoot);

      // Loadable proof for the attendance root that failed on clean publish.
      await import(
        pathToFileURL(resolve(distRoot, "navigator-attendance.js")).href
      );
    });
  },
);
