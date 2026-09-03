/**
 * Issue #552 / #556 / #629: acquire autopsies a contested writer.lock and
 * reclaims only a verified-dead holder pid. Call sites match instanceof only.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  acquireRunWriterLease,
  RunWriterLeaseHeldError,
} from "../../src/public-cli/run-lifecycle.ts";

const LOCK_NAME = "writer.lock";

async function withRunDirectory<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ak-writer-lease-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A verifiably dead pid: spawned, SIGKILLed, and reaped before returning. */
async function firstDeadPid(): Promise<number> {
  const child = spawn("sleep", ["30"]);
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0, "spawn failed to produce a pid");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return pid;
}

test("reclaims a stale lock whose holder pid is dead, records the new writer, and declares the orphan-pi residual", async () => {
  await withRunDirectory(async (dir) => {
    const deadPid = await firstDeadPid();
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, `${deadPid}\n`, "utf8");

    const diagnostics: string[] = [];
    const lease = await acquireRunWriterLease(dir, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    try {
      assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);
    } finally {
      await lease.release();
    }
    await assert.rejects(readFile(lockPath, "utf8"));
    assert.equal(diagnostics.length, 1);
    const declaration = diagnostics[0];
    assert.ok(declaration !== undefined);
    assert.ok(declaration.includes(String(deadPid)));
    assert.ok(declaration.includes(lockPath));
    assert.ok(declaration.endsWith("\n"));
  });
});

test("a clean first acquire emits no diagnostic", async () => {
  await withRunDirectory(async (dir) => {
    const diagnostics: string[] = [];
    const lease = await acquireRunWriterLease(dir, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    await lease.release();
    assert.equal(diagnostics.length, 0);
  });
});

test("rejects an empty lock without touching it — emptiness proves no dead holder", async () => {
  await withRunDirectory(async (dir) => {
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, "", "utf8");

    await assert.rejects(
      acquireRunWriterLease(dir),
      (error: unknown) => error instanceof RunWriterLeaseHeldError,
    );
    assert.equal(await readFile(lockPath, "utf8"), "");
  });
});

test("rejects an unparseable lock without touching it", async () => {
  await withRunDirectory(async (dir) => {
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, "not-a-pid\n", "utf8");

    await assert.rejects(
      acquireRunWriterLease(dir),
      (error: unknown) => error instanceof RunWriterLeaseHeldError,
    );
    assert.equal(await readFile(lockPath, "utf8"), "not-a-pid\n");
  });
});

test("rejects a live holder", async () => {
  await withRunDirectory(async (dir) => {
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, `${process.pid}\n`, "utf8");

    await assert.rejects(
      acquireRunWriterLease(dir),
      (error: unknown) => error instanceof RunWriterLeaseHeldError,
    );
    assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);
  });
});

test("a second acquire while the first lease is unreleased stays rejected", async () => {
  await withRunDirectory(async (dir) => {
    const lease = await acquireRunWriterLease(dir);
    try {
      await assert.rejects(
        acquireRunWriterLease(dir),
        (error: unknown) => error instanceof RunWriterLeaseHeldError,
      );
    } finally {
      await lease.release();
    }
    const second = await acquireRunWriterLease(dir);
    await second.release();
  });
});
