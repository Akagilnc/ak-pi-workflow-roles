/**
 * Public CLI build/package seam (ADR 0052 / #106):
 * package.json#bin executes dist/public-cli/main.js — the committed artifact
 * must match a fresh bundle from src/public-cli, or installs and local bins
 * ship a stale Terminal encoder / settlement path.
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
}> {
  const url = pathToFileURL(resolve(packageRoot, "scripts/build-package.mjs")).href;
  return (await import(url)) as {
    buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("committed ak-role bin matches fresh public-cli bundle from source", async () => {
  const { buildPublicAkRoleBin } = await loadBuildPackage();
  const committedPath = resolve(packageRoot, "dist/public-cli/main.js");
  const committed = await readFile(committedPath);

  const dir = await mkdtemp(join(tmpdir(), "ak-public-cli-bin-"));
  const freshPath = join(dir, "main.js");
  try {
    // Build from the package root so entryPoints resolve like prepack/build.
    const previousCwd = process.cwd();
    process.chdir(packageRoot);
    try {
      await buildPublicAkRoleBin(freshPath);
    } finally {
      process.chdir(previousCwd);
    }

    const fresh = await readFile(freshPath);
    assert.equal(
      sha256(fresh),
      sha256(committed),
      "dist/public-cli/main.js drifted from src/public-cli — run: node scripts/build-package.mjs",
    );
    // Byte equality with a fresh source build is the sole artifact oracle
    // (#420: committedText marker array deleted — behavioral coverage lives in
    // the real-install tracers; prose staring violates ADR 0052).
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
