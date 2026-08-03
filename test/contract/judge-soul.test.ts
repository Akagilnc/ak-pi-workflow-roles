import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const soulsDir = resolve(root, "souls");

// Shared carrier-purity denylist (core ~8 patterns; wording fossils dropped).
const sharedForbidden = [
  /Ming/i,
  /容器/,
  /stationReceiptContracts/,
  /--ak-(judge|fixer|coder|reviewer|collector|doctor|merger)/i,
  /next-?role/i,
  /workflow\s*DSL/i,
  /packets\//i,
  /orchestrat/i,
  /ADR\s*\d+/i,
] as const;

test("Soul files exclude process, schema, transport, platform, and issue carriers", async () => {
  const files = (await readdir(soulsDir)).filter((name) => name.endsWith(".md")).sort();
  assert.ok(files.length >= 12, `expected twelve souls, got ${files.length}`);
  for (const file of files) {
    const soul = await readFile(resolve(soulsDir, file), "utf8");
    for (const forbidden of sharedForbidden) {
      assert.doesNotMatch(soul, forbidden, `${file} matched ${forbidden}`);
    }
  }
});
