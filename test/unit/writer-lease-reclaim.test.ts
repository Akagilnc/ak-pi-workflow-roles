import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireRunWriterLease,
  reclaimStaleWriterLock,
} from "../../src/public-cli/run-lifecycle.ts";

async function tempRunDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "writer-lease-reclaim-"));
}

async function deadPid(): Promise<number> {
  const child = spawn("sleep", ["30"]);
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0);
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return pid;
}

test("reclaimStaleWriterLock returns false without deleting when the holder is no longer dead", async () => {
  const runDirectory = await tempRunDirectory();
  const lockPath = join(runDirectory, "writer.lock");

  await writeFile(lockPath, "123junk", "utf8");
  assert.equal(await reclaimStaleWriterLock(lockPath, runDirectory), false);
  assert.equal(await readFile(lockPath, "utf8"), "123junk");

  await writeFile(lockPath, `${process.pid}\n`, "utf8");
  assert.equal(await reclaimStaleWriterLock(lockPath, runDirectory), false);
  assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);

  const kinds: Array<string | undefined> = [];
  await assert.rejects(() =>
    acquireRunWriterLease(runDirectory, (_line, kind) => {
      kinds.push(kind);
    }),
  );
  assert.equal(
    kinds.some((kind) => kind === "stale-reclaimed"),
    false,
  );
});

test("reclaimStaleWriterLock returns true only when it unlinks a verified-dead holder", async () => {
  const runDirectory = await tempRunDirectory();
  const lockPath = join(runDirectory, "writer.lock");
  const pid = await deadPid();
  await writeFile(lockPath, `${pid}\n`, "utf8");
  assert.equal(await reclaimStaleWriterLock(lockPath, runDirectory), true);
  await assert.rejects(() => readFile(lockPath, "utf8"));
});
