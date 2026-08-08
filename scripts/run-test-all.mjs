#!/usr/bin/env node
// Sole scheduling owner for `npm run test:all` (Issue #160).
// Discovers test/{unit,contract,integration,package}/**/*.test.ts, partitions
// the exact heavyweight real-Pi/Navigator manifest into a serial child, and
// runs ordinary files first under default Node file parallelism.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const HEAVYWEIGHT_MANIFEST = Object.freeze([
  "test/integration/audit-failure-subprocess.test.ts",
  "test/integration/public-cli-judge-run.test.ts",
  "test/package/package-entrypoint.integration.test.ts",
]);

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

function partition(discovered) {
  const unique = new Set(discovered);
  if (unique.size !== discovered.length) {
    const seen = new Set();
    const dupes = [];
    for (const file of discovered) {
      if (seen.has(file)) dupes.push(file);
      seen.add(file);
    }
    fail(`duplicate discovered test files: ${dupes.join(", ")}`);
  }

  const discoveredSet = unique;
  const heavySet = new Set();
  for (const entry of HEAVYWEIGHT_MANIFEST) {
    if (heavySet.has(entry)) {
      fail(`heavyweight manifest entry duplicated: ${entry}`);
    }
    heavySet.add(entry);
    if (!discoveredSet.has(entry)) {
      fail(
        `heavyweight manifest entry missing from discovery: ${entry}`,
      );
    }
  }

  const ordinary = [];
  const heavy = [];
  for (const file of discovered) {
    if (heavySet.has(file)) heavy.push(file);
    else ordinary.push(file);
  }

  // Preserve manifest order for the heavy child (deterministic serial lane).
  const heavyOrdered = HEAVYWEIGHT_MANIFEST.filter((f) => heavy.includes(f));
  if (heavyOrdered.length !== HEAVYWEIGHT_MANIFEST.length) {
    fail("heavyweight partition lost manifest entries");
  }

  const ordinarySet = new Set(ordinary);
  for (const file of heavyOrdered) {
    if (ordinarySet.has(file)) {
      fail(`file present in both ordinary and heavy: ${file}`);
    }
  }
  if (ordinary.length + heavyOrdered.length !== discovered.length) {
    fail(
      `partition union size ${ordinary.length + heavyOrdered.length} !== discovered ${discovered.length}`,
    );
  }

  return { ordinary, heavy: heavyOrdered };
}

function fail(message) {
  console.error(`run-test-all: ${message}`);
  process.exit(1);
}

function runNodeTest(files, { concurrency } = {}) {
  if (files.length === 0) return Promise.resolve(0);

  const args = ["--import", "tsx", "--test"];
  if (concurrency !== undefined) {
    args.push(`--test-concurrency=${concurrency}`);
  }
  args.push(...files);

  // Resolve `node` from PATH so lawful tests may intercept children via an
  // isolated PATH seam. No test-only env hook is accepted here.
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

const discovered = discoverTestFiles(root);
const { ordinary, heavy } = partition(discovered);

const ordinaryCode = await runNodeTest(ordinary);
if (ordinaryCode !== 0) {
  process.exit(ordinaryCode);
}

const heavyCode = await runNodeTest(heavy, { concurrency: 1 });
process.exit(heavyCode);
