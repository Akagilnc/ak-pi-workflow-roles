/**
 * #685 C3: auditor Soul missing/blank/unreadable fail-closed at loadAuditorSoul.
 * Real entry on the package material seam (same readPackageMaterial as production).
 * Mutates only the judge-auditor soul path under packageRoot inside try/finally;
 * does not start a host session.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadAuditorSoul } from "../../src/auditor-soul.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("loadAuditorSoul fails closed on missing, blank, and unreadable soul files", async () => {
  const soulPath = join(packageRoot, "souls/judge-auditor.md");
  const original = await readFile(soulPath, "utf8");
  try {
    await rm(soulPath, { force: true });
    await assert.rejects(
      () => loadAuditorSoul("judge"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT",
      "missing auditor Soul must preserve ENOENT",
    );

    await writeFile(soulPath, " \n", "utf8");
    await assert.rejects(
      () => loadAuditorSoul("judge"),
      /judge auditor Soul is blank/,
    );

    await rm(soulPath, { force: true });
    await mkdir(soulPath);
    await assert.rejects(
      () => loadAuditorSoul("judge"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EISDIR",
      "unreadable auditor Soul must preserve EISDIR",
    );
  } finally {
    await rm(soulPath, { recursive: true, force: true });
    await writeFile(soulPath, original, "utf8");
  }
});
