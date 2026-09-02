import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCollectorManifest } from "../../src/collector-config.ts";

/** #612: fixture roots are create-and-delete. */
async function withTempRoot<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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
