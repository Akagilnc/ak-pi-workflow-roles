/**
 * #356 T1 / #376 — engine material is optional notes, not a closed name catalog.
 * Entry-reachable delivery is covered by public-cli-engine-axis tracer.
 * This file keeps helper seams: path-safety syntax + optional notes attach.
 * Tests never treat material body CLI text as a contract.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEngineSessionMaterial,
  assertLegalEngineName,
  engineSessionMaterialFromOptions,
  listEngineMaterialNames,
} from "../../src/package-resources/engine-material.ts";

test("assertLegalEngineName rejects only real path hazards; consecutive dots pass", () => {
  // Real hazards: traversal parents, separators, NUL, exact "." / "..".
  // Well-formed names (incl. company..opus) are never rejected for missing notes (#376).
  assert.throws(
    () => assertLegalEngineName("../escape"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName("has/slash"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName("has\\slash"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName("has\0nul"),
    /illegal engine name/,
  );
  assert.throws(() => assertLegalEngineName("."), /illegal engine name/);
  assert.throws(() => assertLegalEngineName(".."), /illegal engine name/);
  assert.throws(
    () => assertLegalEngineName(""),
    /illegal engine name/,
  );
  assert.equal(assertLegalEngineName("nope-engine"), "nope-engine");
  assert.equal(assertLegalEngineName("opus"), "opus");
  assert.equal(assertLegalEngineName("company..opus"), "company..opus");
});

test("appendEngineSessionMaterial: name-only omits read-these-bytes; notes keep it", () => {
  const nameOnly = appendEngineSessionMaterial(["base"], { name: "company..opus" });
  const nameOnlyText = nameOnly.join("\n");
  assert.equal(nameOnlyText.includes("company..opus"), true);
  assert.equal(
    nameOnlyText.includes("Engine method material (read these bytes"),
    false,
    "name-only path must not claim packaged bytes to read",
  );

  const withNotes = appendEngineSessionMaterial(["base"], {
    name: "cursor",
    materialPath: "/abs/resources/engines/cursor.md",
  });
  const withNotesText = withNotes.join("\n");
  assert.equal(
    withNotesText.includes("Engine method material (read these bytes"),
    true,
  );
  assert.equal(withNotesText.includes("/abs/resources/engines/cursor.md"), true);
});

test("packaged notes directory is discovery-only; missing notes is not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-engine-empty-"));
  try {
    assert.deepEqual(listEngineMaterialNames(root), []);
    await mkdir(join(root, "resources", "engines"), { recursive: true });
    await writeFile(join(root, "resources", "engines", "only.md"), "x\n", "utf8");
    assert.deepEqual(listEngineMaterialNames(root), ["only"]);

    // With notes → name + path.
    const withNotes = engineSessionMaterialFromOptions({
      engine: "only",
      packageRoot: root,
    });
    assert.equal(withNotes?.name, "only");
    assert.equal(
      withNotes?.materialPath,
      join(root, "resources", "engines", "only.md"),
    );

    // Without notes → name only, no path, no throw.
    const bare = engineSessionMaterialFromOptions({
      engine: "opus",
      packageRoot: root,
    });
    assert.deepEqual(bare, { name: "opus" });
    assert.equal(bare && "materialPath" in bare && bare.materialPath !== undefined, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
