#!/usr/bin/env node
// Sole scheduling owner for `npm run test:all` (Issue #160).
// Discovers test/{unit,contract,integration,package}/**/*.test.ts and runs
// them under default Node file parallelism.
// #685: heavy manifest removed — real-host Pi/install/cold-session cases
// culled per quality-law (真宿主以真跑为证) and imperial ≤1 real-pi order.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, relative } from "node:path";

import { isolatedTestProcessEnv } from "./test-process-env.mjs";

const TIERS = Object.freeze([
  "unit",
  "contract",
  "integration",
  "package",
]);

const root = process.cwd();

function discoverTestFiles(repoRoot) {
  const discovered = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    // Stable walk: directories then files, each group sorted by name.
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (ent.isDirectory()) dirs.push(ent.name);
      else if (ent.isFile()) files.push(ent.name);
    }
    dirs.sort();
    files.sort();
    for (const name of dirs) walk(join(dir, name));
    for (const name of files) {
      if (!name.endsWith(".test.ts")) continue;
      discovered.push(
        relative(repoRoot, join(dir, name)).split("\\").join("/"),
      );
    }
  };

  for (const tier of TIERS) {
    walk(join(repoRoot, "test", tier));
  }
  return discovered;
}

function fail(message) {
  console.error(`run-test-all: ${message}`);
  process.exit(1);
}

function runNodeTest(files) {
  if (files.length === 0) return Promise.resolve(0);

  const unique = new Set(files);
  if (unique.size !== files.length) {
    const seen = new Set();
    const dupes = [];
    for (const file of files) {
      if (seen.has(file)) dupes.push(file);
      seen.add(file);
    }
    fail(`duplicate discovered test files: ${dupes.join(", ")}`);
  }

  const args = ["--import", "tsx", "--test", ...files];

  // Resolve `node` from PATH so lawful tests may intercept children via an
  // isolated PATH seam. No test-only env hook is accepted here.
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", args, {
      cwd: root,
      stdio: "inherit",
      env: isolatedTestProcessEnv(),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        // Preserve signal identity as the conventional 128 + signo status
        // (e.g. SIGTERM => 143) rather than washing to generic 1.
        const signo = osConstants.signals[signal];
        resolvePromise(typeof signo === "number" ? 128 + signo : 1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

const discovered = discoverTestFiles(root);
process.exit(await runNodeTest(discovered));
