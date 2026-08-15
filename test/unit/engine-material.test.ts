/**
 * #356 T1 — packaged engine method-material is the sole legal-name source.
 * Tests never treat material body CLI text as a contract.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEngineSessionMaterial,
  assertLegalEngineName,
  engineSessionMaterialFromOptions,
  listEngineMaterialNames,
  resolveEngineMaterialPath,
} from "../../src/package-resources/engine-material.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("packaged engine material directory enumerates legal names only", () => {
  const names = listEngineMaterialNames(packageRoot);
  assert.deepEqual([...names].sort(), ["codex", "cursor", "kimi"]);
  for (const name of names) {
    assert.equal(assertLegalEngineName(packageRoot, name), name);
    const path = resolveEngineMaterialPath(packageRoot, name);
    assert.equal(path.endsWith(`resources/engines/${name}.md`), true);
  }
});

test("unknown and illegal engine names are rejected at the material seam", () => {
  assert.throws(
    () => assertLegalEngineName(packageRoot, "no-such-engine"),
    /unknown engine: no-such-engine/,
  );
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

test("engine session material resolves name + absolute path without reading body as contract", async () => {
  const material = engineSessionMaterialFromOptions({
    packageRoot,
    engine: "kimi",
  });
  assert.equal(material?.name, "kimi");
  assert.equal(
    material?.materialPath,
    resolveEngineMaterialPath(packageRoot, "kimi"),
  );
  await access(material!.materialPath);
  // Presence only — never assert material body CLI invocation text.
  assert.equal(engineSessionMaterialFromOptions({}), undefined);
});

test("appendEngineSessionMaterial is identity without engine and stable with engine", () => {
  const base = ["task instruction"];
  assert.deepEqual(appendEngineSessionMaterial(base), ["task instruction"]);
  assert.equal(appendEngineSessionMaterial(base).join("\n"), "task instruction");

  const withEngine = appendEngineSessionMaterial(base, {
    name: "kimi",
    materialPath: "/pkg/resources/engines/kimi.md",
  });
  assert.deepEqual(withEngine, [
    "task instruction",
    "",
    "Engine method material (read these bytes and follow them):",
    "- engine: kimi",
    "- /pkg/resources/engines/kimi.md",
  ]);
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
