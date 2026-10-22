/**
 * #443 — session opening materials: a missing injected material fails loudly.
 * Real material delivery is proven at the envelope entry (role-envelope-engine-axis).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { joinPackageMaterials } from "../../src/session-opening-materials.ts";

test("missing injected material fails as native ENOENT, not a soft empty", async () => {
  await assert.rejects(
    () => joinPackageMaterials(["souls/__no_such_opening_material__.md"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});
