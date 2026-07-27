import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const soulUrl = new URL("../souls/judge.md", import.meta.url);

test("judge soul keeps toolchain failures outside the three-state verdict", async () => {
  const soul = await readFile(soulUrl, "utf8");

  assert.doesNotMatch(soul, /`toolchain`|→ toolchain/);
  assert.match(soul, /暂时性.*非零退出/);
  assert.match(soul, /owner.*`escalate`/);
});
