/**
 * Public CLI + Grok production build/package seam (ADR 0052 / #106 / #511):
 * package.json#bin executes dist/public-cli/main.js, and the Grok composition
 * root prefers dist/grok/production-host.js when present — committed artifacts
 * must match a fresh bundle from source, or installs ship a stale path.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { packageRoot } from "../helpers/pi-test-harness.ts";

async function loadBuildPackage(): Promise<{
  buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
  buildGrokProductionHost: (outfile?: string) => Promise<void>;
}> {
  const url = pathToFileURL(resolve(packageRoot, "scripts/build-package.mjs")).href;
  return (await import(url)) as {
    buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
    buildGrokProductionHost: (outfile?: string) => Promise<void>;
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertCommittedMatchesFreshBuild(options: {
  committedRelativePath: string;
  prefix: string;
  freshFileName: string;
  build: (freshPath: string) => Promise<void>;
  driftMessage: string;
}): Promise<void> {
  const committedPath = resolve(packageRoot, options.committedRelativePath);
  const committed = await readFile(committedPath);

  const dir = await mkdtemp(join(tmpdir(), options.prefix));
  const freshPath = join(dir, options.freshFileName);
  try {
    // Build from the package root so entryPoints resolve like prepack/build.
    const previousCwd = process.cwd();
    process.chdir(packageRoot);
    try {
      await options.build(freshPath);
    } finally {
      process.chdir(previousCwd);
    }

    const fresh = await readFile(freshPath);
    assert.equal(sha256(fresh), sha256(committed), options.driftMessage);
    // Byte equality with a fresh source build is the sole artifact oracle
    // (#420: committedText marker array deleted — behavioral coverage lives in
    // the real-install tracers; prose staring violates ADR 0052).
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("committed ak-role bin matches fresh public-cli bundle from source", async () => {
  const { buildPublicAkRoleBin } = await loadBuildPackage();
  await assertCommittedMatchesFreshBuild({
    committedRelativePath: "dist/public-cli/main.js",
    prefix: "ak-public-cli-bin-",
    freshFileName: "main.js",
    build: buildPublicAkRoleBin,
    driftMessage:
      "dist/public-cli/main.js drifted from src/public-cli — run: node scripts/build-package.mjs",
  });
});

test("committed grok production-host matches fresh bundle from source", async () => {
  const { buildGrokProductionHost } = await loadBuildPackage();
  await assertCommittedMatchesFreshBuild({
    committedRelativePath: "dist/grok/production-host.js",
    prefix: "ak-grok-production-host-",
    freshFileName: "production-host.js",
    build: buildGrokProductionHost,
    driftMessage:
      "dist/grok/production-host.js drifted from src/grok — run: node scripts/build-package.mjs",
  });
});
