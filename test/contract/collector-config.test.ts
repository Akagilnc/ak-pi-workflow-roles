import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadCollectorManifest } from "../../src/collector-config.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("request identities preserve non-empty caller strings without legacy leg-id format limits", async () => {
  await withTempRoot("collector-request-id-", async (root) => {
    const path = join(root, "requests.json");
    const ids = ["UPPER_CASE", `Long-${"x".repeat(80)}`, "request with spaces/符号"];
    await writeFile(path, JSON.stringify({ requests: ids.map((id) => ({ id, body: "Review this." })) }));

    const manifest = await loadCollectorManifest(path);
    assert.deepEqual(manifest.requests.map(({ id }) => id), ids);
  });
});

test("request identities remain non-empty and unique by their real string mapping", async () => {
  await withTempRoot("collector-request-unique-", async (root) => {
    const path = join(root, "requests.json");
    await writeFile(path, JSON.stringify({ requests: [{ id: "Same", body: "one" }, { id: "Same", body: "two" }] }));
    await assert.rejects(() => loadCollectorManifest(path), /duplicate request id/);
    await writeFile(path, JSON.stringify({ requests: [{ id: "", body: "one" }] }));
    await assert.rejects(() => loadCollectorManifest(path), /requests\[0\] is invalid/);
  });
});
