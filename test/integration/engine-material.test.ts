/**
 * #631 medium: engine material discovery against a real package-root tree.
 * Pure path-safety / session-line attach stays in test/unit/engine-material.test.ts.
 * Model / handbook delivery is covered at the public ak-role seam
 * (public-cli-engine-startup-material / public-cli-engine-axis); no helper-only duplicate.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import {
  listEngineMaterialNames,
} from "../../src/package-resources/engine-material.ts";

test("packaged notes directory is discovery-only; missing notes is not an error", async () => {
  await withTempRoot("ak-engine-empty-", async (root) => {
    assert.deepEqual(listEngineMaterialNames(root), []);
    await mkdir(join(root, "resources", "engines"), { recursive: true });
    await writeFile(join(root, "resources", "engines", "only.md"), "x\n", "utf8");
    assert.deepEqual(listEngineMaterialNames(root), ["only"]);
  });
});
