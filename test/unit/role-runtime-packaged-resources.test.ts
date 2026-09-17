/**
 * #962 — packaged handbook/playbook resolve under the injected packageRoot.
 * Bundle entry (dist/headless-host|acp-host/production-host.js) cannot use
 * import.meta.url-relative ../resources/; packageRoot is the sole authority.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("loadCollectorHandbookSeed reads only under injected packageRoot", async () => {
  await withTempRoot("ak-962-resources-", async (root) => {
    const deps = createRoleRuntimeDependencies(root);

    // Empty packageRoot must not fall back to the real install tree via import.meta.url.
    await assert.rejects(
      () => deps.loadCollectorHandbookSeed!(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        String((error as NodeJS.ErrnoException).path ?? "").includes(root),
    );

    const marker = "handbook-marker-962-unique";
    await mkdir(join(root, "resources"));
    await writeFile(join(root, "resources/collector-bot-handbook.md"), marker, "utf8");
    assert.equal(await deps.loadCollectorHandbookSeed!(), marker);
  });
});
