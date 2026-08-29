/**
 * Issue #552 (owner 2026-08-29): a killed run leaves writer.lock behind with a
 * dead holder pid, and acquire rejected unconditionally — every kill→resume
 * chain forced the caller to hand-remove the lock. Contract (reclaim gate
 * narrowed per the court ruling, judge run
 * 01a04ce8-d356-7f10-a6b5-571a514b3054@judge): acquire performs a holder
 * autopsy on EEXIST and reclaims ONLY a verified-dead holder pid — parseable
 * pid, signal-0 ESRCH, still dead on the pre-unlink re-read. An empty lock (a
 * live creator is mid-acquisition between exclusive create and its pid write)
 * or an unparseable or unreadable one proves no dead holder: typed
 * RunWriterLeaseHeldError naming the path, lock left in place. No
 * caller-visible message-text coupling exists outside this error type (call
 * sites pattern-match instanceof only).
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

test("rejects an empty lock without touching it — emptiness proves no dead holder", async () => {
  await withRunDirectory(async (dir) => {
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, "", "utf8");

    await assert.rejects(
      acquireRunWriterLease(dir),
      (error: unknown) => {
        assert.ok(error instanceof RunWriterLeaseHeldError, "expected RunWriterLeaseHeldError");
        assert.ok(error.message.includes(lockPath), `message should name the lock path: ${error.message}`);
        return true;
      },
    );
    assert.equal(await readFile(lockPath, "utf8"), "", "empty lock must stay in place");
  });
});

test("rejects an unparseable lock without touching it", async () => {
  await withRunDirectory(async (dir) => {
    const lockPath = join(dir, LOCK_NAME);
    await writeFile(lockPath, "not-a-pid\n", "utf8");

    await assert.rejects(
      acquireRunWriterLease(dir),
      (error: unknown) => {
        assert.ok(error instanceof RunWriterLeaseHeldError, "expected RunWriterLeaseHeldError");
        assert.ok(error.message.includes(lockPath), `message should name the lock path: ${error.message}`);
        return true;
      },
    );
    assert.equal(
      await readFile(lockPath, "utf8"),
      "not-a-pid\n",
      "unparseable lock must stay in place",
    );
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
