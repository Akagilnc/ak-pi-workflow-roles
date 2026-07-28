import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { withHermeticHome } from "./helpers/pi-test-harness.ts";

test("hermetic HOME restores the exact prior value and recursively cleans up after a throw", async () => {
  const originalHome = process.env.HOME;
  const priorHome = "/preserved/home/value";
  const sentinel = { reason: "callback sentinel" };
  let allocatedHome: string | undefined;

  process.env.HOME = priorHome;
  try {
    await assert.rejects(
      withHermeticHome({ prefix: "ak-harness-cleanup-" }, async ({ home }) => {
        allocatedHome = home;
        assert.equal(process.env.HOME, home);
        await mkdir(resolve(home, "nested", "tree"), { recursive: true });
        await writeFile(
          resolve(home, "nested", "tree", "evidence.txt"),
          "evidence",
        );
        throw sentinel;
      }),
      (error) => {
        assert.equal(error, sentinel);
        return true;
      },
    );
    assert.equal(process.env.HOME, priorHome);
    assert.ok(allocatedHome);
    await assert.rejects(access(allocatedHome), { code: "ENOENT" });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
