/**
 * #1088: collector handbook is session material (not a runtime seed loader).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { packagedRoleSessionMaterials } from "../../src/packaged-role-registry.ts";
import {
  loadMainRoleReferenceMaterials,
  loadMainRoleSessionMaterials,
} from "../../src/session-opening-materials.ts";

test("collector session materials declare handbook and load it with references", async () => {
  assert.deepEqual(packagedRoleSessionMaterials("collector"), [
    "CLAUDE.md",
    "souls/collector.md",
    "resources/collector-bot-handbook.md",
  ]);
  const soul = await loadMainRoleSessionMaterials("collector");
  const refs = await loadMainRoleReferenceMaterials("collector");
  assert.match(soul, /Collector Soul/);
  assert.match(refs, /宿主 CLI/);
});
