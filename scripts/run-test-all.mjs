#!/usr/bin/env node
// Sole scheduling owner for `npm run test:all` (Issue #160).
// Discovers test/{unit,contract,integration,package}/**/*.test.ts, partitions
// any remaining heavyweight entries into a concurrency=2 child, and runs
// ordinary files first under default Node file parallelism.
// #685: real-host Pi/install cases culled per quality-law (真宿主以真跑为证).
// Remaining heavy entries need concurrency=2 isolation (withInProcessPi multi-
// second packaged sessions flake under ordinary file-parallelism).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, relative } from "node:path";

import { isolatedTestProcessEnv } from "./test-process-env.mjs";

const HEAVYWEIGHT_MANIFEST = Object.freeze([
  // #685 heavy = ledger-319 🔒 gates + ADR 0019/0052 install/activation face +
  // multi-second packaged sessions that flake under ordinary file-parallelism.
  // Bound exceptions to quality-law「真宿主以真跑为证」: preservation-ledger 🔒
  // rows and ADR 0019 illegal-activation / ADR 0052 public install face — not
  // "keep until true-run appears". Non-locked bulk culled.
  "test/integration/audit-failure-subprocess.test.ts",
  "test/integration/public-cli-judge-run.test.ts",
  "test/integration/public-cli-coder-installed-run.test.ts",
  "test/integration/activation-envelope-contract.test.ts",
  "test/package/package-entrypoint-navigator.integration.test.ts",
  "test/package/package-entrypoint-cold-help.integration.test.ts",
  "test/package/package-entrypoint-observation.integration.test.ts",
  "test/package/package-entrypoint-packaged-workers.integration.test.ts",
  "test/package/doctor-package-lifecycle.test.ts",
  "test/package/public-cli-install.test.ts",
  "test/package/public-cli-cold-matrix.test.ts",
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

  // Preserve manifest order for the heavy child (deterministic argv order).
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
const { ordinary, heavy } = partition(discovered);

const ordinaryCode = await runNodeTest(ordinary);
if (ordinaryCode !== 0) {
  process.exit(ordinaryCode);
}

const heavyCode = await runNodeTest(heavy, { concurrency: 2 });
process.exit(heavyCode);
