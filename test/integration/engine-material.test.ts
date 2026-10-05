/**
 * #631 medium: engine material discovery against a real package-root tree.
 * Pure path-safety / session-line attach stays in test/unit/engine-material.test.ts.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import {
  engineSessionMaterialFromOptions,
  listEngineMaterialNames,
} from "../../src/package-resources/engine-material.ts";

test("#883 engineSessionMaterialFromOptions: engineModel is optional opaque coordinate", async () => {
  // Typed material.model only — prompt presentation of engineModel is not contract.
  await withTempRoot("ak-engine-model-", async (root) => {
    await mkdir(join(root, "resources", "engines"), { recursive: true });
    await writeFile(join(root, "resources", "engines", "cursor.md"), "x\n", "utf8");
    const material = engineSessionMaterialFromOptions({
      engine: "cursor",
      engineModel: "cursor-grok-4.6-high",
      packageRoot: root,
    });
    assert.equal(material?.name, "cursor");
    assert.equal(material?.model, "cursor-grok-4.6-high");
    const bare = engineSessionMaterialFromOptions({
      engine: "cursor",
      packageRoot: root,
    });
    assert.equal(bare?.name, "cursor");
    assert.equal(bare?.model, undefined);
  });
});

test("packaged notes directory is discovery-only; missing notes is not an error", async () => {
  await withTempRoot("ak-engine-empty-", async (root) => {
    assert.deepEqual(listEngineMaterialNames(root), []);
    await mkdir(join(root, "resources", "engines"), { recursive: true });
    await writeFile(join(root, "resources", "engines", "only.md"), "x\n", "utf8");
    assert.deepEqual(listEngineMaterialNames(root), ["only"]);
    // Handbook / bare-name delivery is asserted at the public ak-role seam
    // (public-cli-engine-startup-material.test.ts); keep discovery-only here.
  });
});
