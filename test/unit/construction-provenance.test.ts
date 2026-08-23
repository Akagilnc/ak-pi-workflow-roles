import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { constructionProvenance, packageRoot } from "../helpers/pi-test-harness.ts";

test("construction provenance fingerprints nested untracked file bytes", async () => {
  const root = join(packageRoot, ".construction-provenance-test");
  const file = join(root, "nested", "fixture.txt");
  await mkdir(join(root, "nested"), { recursive: true });
  try {
    await writeFile(file, "first");
    const first = constructionProvenance().fingerprint;
    await writeFile(file, "second");
    assert.notEqual(constructionProvenance().fingerprint, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
