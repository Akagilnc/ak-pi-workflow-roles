import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCollectorManifest } from "../../src/collector-config.ts";

test("request identities preserve non-empty caller strings without legacy leg-id format limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-request-id-"));
  const path = join(root, "requests.json");
  const ids = ["UPPER_CASE", `Long-${"x".repeat(80)}`, "request with spaces/符号"];
  await writeFile(path, JSON.stringify({ requests: ids.map((id) => ({ id, body: "Review this." })) }));

  const manifest = await loadCollectorManifest(path);
  assert.deepEqual(manifest.requests.map(({ id }) => id), ids);
});

test("request identities remain non-empty and unique by their real string mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-request-unique-"));
  const path = join(root, "requests.json");
  await writeFile(path, JSON.stringify({ requests: [{ id: "Same", body: "one" }, { id: "Same", body: "two" }] }));
  await assert.rejects(() => loadCollectorManifest(path), /duplicate request id/);
  await writeFile(path, JSON.stringify({ requests: [{ id: "", body: "one" }] }));
  await assert.rejects(() => loadCollectorManifest(path), /requests\[0\] is invalid/);
});
