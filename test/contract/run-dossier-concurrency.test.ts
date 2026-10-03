/**
 * current.json is written by several processes (a live leg, a manual resume, a
 * gate officer), each a different section. Two real processes interleaving
 * read-modify-write must not drop each other's section (#1161 / 大理寺 J2).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const WRITER = new URL("../fixtures/run-dossier-writer.mjs", import.meta.url).pathname;

function runWriter(runDirectory: string, section: string, tag: string, count: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, runDirectory, section, tag, String(count)], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

test("two processes writing different sections of one current.json lose neither", async () => {
  const run = await mkdtemp(join(tmpdir(), "ak-dossier-race-"));
  try {
    const codes = await Promise.all([
      runWriter(run, "host", "h", 120),
      runWriter(run, "delivery", "d", 120),
    ]);
    assert.deepEqual(codes, [0, 0]);
    const current = JSON.parse(await readFile(join(run, "current.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(current.host, { h: 119 });
    assert.deepEqual(current.delivery, { d: 119 });
    // No lock or temp entry is left behind.
    assert.deepEqual((await readdir(run)).sort(), ["current.json"]);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});
