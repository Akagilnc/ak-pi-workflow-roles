/**
 * #356 T1 — packaged engine method-material is the sole legal-name source.
 * Entry-reachable delivery/rejection is covered by public-cli-engine-axis tracer.
 * This file keeps only entry-unreachable helper seams (empty catalog + authority
 * syntax rejects that the public argv surface does not uniquely exercise).
 * Tests never treat material body CLI text as a contract.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertLegalEngineName,
  listEngineMaterialNames,
} from "../../src/package-resources/engine-material.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("assertLegalEngineName rejects syntax-illegal names at the authority seam", () => {
  // Entry tracer covers unknown-but-well-formed names (nope-engine).
  // Path traversal / empty / separators are authority-only rejects.
  assert.throws(
    () => assertLegalEngineName(packageRoot, "../escape"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName(packageRoot, "has/slash"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName(packageRoot, ""),
    /illegal engine name/,
  );
});

test("empty package root without engines directory yields empty catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-engine-empty-"));
  try {
    assert.deepEqual(listEngineMaterialNames(root), []);
    await mkdir(join(root, "resources", "engines"), { recursive: true });
    await writeFile(join(root, "resources", "engines", "only.md"), "x\n", "utf8");
    assert.deepEqual(listEngineMaterialNames(root), ["only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
