/**
 * Issue #552 (owner 2026-08-29): a killed run leaves writer.lock behind with a
 * dead holder pid, and acquire rejected unconditionally — every kill→resume
 * chain forced the caller to hand-remove the lock. Contract now: acquire
 * performs a holder autopsy on EEXIST — a dead or absent holder pid (the
 * create-to-write crash window leaves an empty lock) is reclaimed and the
 * create retried; a live holder rejects as RunWriterLeaseHeldError naming the
 * pid and path. No caller-visible message-text coupling exists outside this
 * error type (call sites pattern-match instanceof only).
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

test("reclaims a stale lock whose holder pid is dead and records the new writer", async () => {
  await withRunDirectory(async (dir) => {
    const deadPid = await firstDeadPid();
    await writeFile(join(dir, LOCK_NAME), `${deadPid}\n`, "utf8");

    const lease = await acquireRunWriterLease(dir);
    try {
      assert.equal(await readFile(join(dir, LOCK_NAME), "utf8"), `${process.pid}\n`);
    } finally {
      await lease.release();
    }
    await assert.rejects(readFile(join(dir, LOCK_NAME), "utf8"));
  });
});

test("reclaims an empty lock left by the create-to-write crash window", async () => {
  await withRunDirectory(async (dir) => {
    await writeFile(join(dir, LOCK_NAME), "", "utf8");

    const lease = await acquireRunWriterLease(dir);
    try {
      assert.equal(await readFile(join(dir, LOCK_NAME), "utf8"), `${process.pid}\n`);
    } finally {
      await lease.release();
    }
  });
});

test("reclaims an unparseable lock as holder-absent", async () => {
  await withRunDirectory(async (dir) => {
    await writeFile(join(dir, LOCK_NAME), "not-a-pid\n", "utf8");

    const lease = await acquireRunWriterLease(dir);
    await lease.release();
  });
});

test("rejects a live holder with the pid and lock path named in the message", async () => {
  await withRunDirectory(async (dir) => {
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, `${process.pid}\n`, "utf8");

    await assert.rejects(
      acquireRunWriterLease(dir),
      (error: unknown) => {
        assert.ok(error instanceof RunWriterLeaseHeldError, "expected RunWriterLeaseHeldError");
        assert.match(error.message, new RegExp(`live pid ${process.pid}`));
        assert.ok(error.message.includes(lockPath), `message should name the lock path: ${error.message}`);
        return true;
      },
    );
    // The live holder's lock is untouched by the rejected acquire.
    assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);
  });
});

test("a second acquire while the first lease is unreleased stays rejected", async () => {
  await withRunDirectory(async (dir) => {
    const lease = await acquireRunWriterLease(dir);
    try {
      await assert.rejects(
        acquireRunWriterLease(dir),
        (error: unknown) => {
          assert.ok(error instanceof RunWriterLeaseHeldError, "expected RunWriterLeaseHeldError");
          assert.match(error.message, new RegExp(`live pid ${process.pid}`));
          return true;
        },
      );
    } finally {
      await lease.release();
    }
    // Release reopens acquisition.
    const second = await acquireRunWriterLease(dir);
    await second.release();
  });
});
