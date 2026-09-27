/**
 * #1088: collector handbook is session material (not a runtime seed loader).
 * Assert path roster + exact package-material load — no prose regex.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { packagedRoleSessionMaterials } from "../../src/packaged-role-registry.ts";
import {
  joinPackageMaterials,
  loadMainRoleReferenceMaterials,
  loadMainRoleSessionMaterials,
  readPackageMaterial,
} from "../../src/session-opening-materials.ts";

test("collector session materials declare handbook and load it with references", async () => {
  const materials = [
    "CLAUDE.md",
    "souls/collector.md",
    "resources/collector-bot-handbook.md",
  ] as const;
  assert.deepEqual(packagedRoleSessionMaterials("collector"), [...materials]);
  const soul = await loadMainRoleSessionMaterials("collector");
  const refs = await loadMainRoleReferenceMaterials("collector");
  assert.equal(soul, await readPackageMaterial("souls/collector.md"));
  assert.equal(
    refs,
    await joinPackageMaterials(["CLAUDE.md", "resources/collector-bot-handbook.md"]),
  );
});
