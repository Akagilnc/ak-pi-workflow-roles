/**
 * #648 Gatekeeper correction — Sitian volume lock live-contention / dead-holder
 * recovery at the lowest real production seam (appendSitianRecord).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendSitianRecord,
  resolveSitianRecordPath,
} from "../../src/sitian-appender.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";


function sleepBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return true;
    sleepBriefly(2);
  }
  return existsSync(path);
}

function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function settleChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already exiting
  }
  // Reuse exitCode/signalCode once the process has settled — do not attach a
  // second 'exit' listener after the test body already consumed childExit().
  while (child.exitCode === null && child.signalCode === null) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

function allocateDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.ok(typeof result.pid === "number" && result.pid > 0);
  try {
    process.kill(result.pid, 0);
    assert.fail(`pid ${result.pid} still alive after exit`);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
  }
  return result.pid;
}

async function withHermeticLedgerRoot<T>(
  run: (ctx: { home: string; cwd: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "sitian-volume-lock-"));
  return withPrimaryAwareCleanup(
    async () => {
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      mkdirSync(cwd, { recursive: true });
      return await run({ home, cwd });
    },
    async () => {
      await rm(root, { recursive: true, force: true });
    },
  );
}

test("dead volume-lock holder cannot permanently block appendSitianRecord", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const input = {
      level: "event" as const,
      kind: "volume-lock-dead-holder",
      identity: "dead-holder-proof",
      home,
      cwd,
      payload: { marker: "after-reclaim" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    const lockFile = `${recordFile}.lock`;
    const deadPid = allocateDeadPid();
    writeFileSync(lockFile, `${deadPid}\n`, "utf8");
    assert.equal(existsSync(lockFile), true);

    const pointer = appendSitianRecord(input);

    assert.equal(pointer.recordFile, recordFile);
    assert.equal(existsSync(lockFile), false, "append must release after dead-holder reclaim");
    const body = readFileSync(recordFile, "utf8");
    assert.match(body, /dead-holder-proof/);
    assert.match(body, /after-reclaim/);
  });
});

test("live volume-lock holder is not stolen by a contending appendSitianRecord", async () => {
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const input = {
      level: "event" as const,
      kind: "volume-lock-live-holder",
      identity: "live-holder-proof",
      home,
      cwd,
      payload: { marker: "after-release" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    const lockFile = `${recordFile}.lock`;
    const seamMarker = join(home, "at-lock-wait.seam");
    mkdirSync(home, { recursive: true });
    writeFileSync(lockFile, `${process.pid}\n`, "utf8");

    // Contender first hits the same open(wx) seam production waits on, signals
    // that observation, then enters appendSitianRecord (which waits on the live lock).
    // No wall-clock sleep stands in for reaching the wait seam.
    const script = `
      import { closeSync, openSync, writeFileSync } from "node:fs";
      import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
      const lockFile = ${JSON.stringify(lockFile)};
      const seamMarker = ${JSON.stringify(seamMarker)};
      for (;;) {
        try {
          const fd = openSync(lockFile, "wx");
          closeSync(fd);
          break;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            writeFileSync(seamMarker, "at-lock-wait\\n", "utf8");
            break;
          }
          throw error;
        }
      }
      appendSitianRecord({
        level: "event",
        kind: ${JSON.stringify(input.kind)},
        identity: ${JSON.stringify(input.identity)},
        home: ${JSON.stringify(home)},
        cwd: ${JSON.stringify(cwd)},
        payload: { marker: "after-release" },
      });
      process.stdout.write("appended\\n");
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = childExit(child);
    exited.catch(() => undefined);
    const done = exited.then((code) => {
      if (code !== 0) {
        throw new Error(`live-lock contender exited ${String(code)}: ${stderr}`);
      }
    });

    await withPrimaryAwareCleanup(
      async () => {
        assert.equal(
          await waitForPath(seamMarker, 10_000),
          true,
          `contender must reach the open(wx) lock-wait seam (stderr=${stderr})`,
        );
        assert.equal(
          readFileSync(lockFile, "utf8").trim(),
          String(process.pid),
          "live lock must not be stolen once contender is at the open(wx) wait seam",
        );
        assert.equal(existsSync(recordFile), false, "contender must not append while live lock held");

        unlinkSync(lockFile);
        await done;

        assert.match(readFileSync(recordFile, "utf8"), /live-holder-proof/);
      },
      async () => {
        await settleChild(child);
      },
    );
  });
});

test("#648 dead reclaim must not unlink a replacement live lock (pathname TOCTOU)", async () => {
  // Cross-process: while reclaim observes a dead holder, an injector replaces the
  // pathname with a live lock. Pathname unlink after a stale dead read steals that
  // live lock; rename-owned reclaim unlinks only the inode it moved.
  await withHermeticLedgerRoot(async ({ home, cwd }) => {
    const input = {
      level: "event" as const,
      kind: "volume-lock-reclaim-toctou",
      identity: "reclaim-toctou-proof",
      home,
      cwd,
      payload: { marker: "after-live-release" },
    };
    const { sessionDir, recordFile } = resolveSitianRecordPath(input);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const lockFile = `${recordFile}.lock`;
    const injectedMarker = join(home, "live-injected.seam");
    const releaseMarker = join(home, "release-live.seam");
    const deadPid = allocateDeadPid();

    let sawProtectedLive = false;
    for (let attempt = 0; attempt < 80 && !sawProtectedLive; attempt += 1) {
      writeFileSync(lockFile, `${deadPid}\n`, "utf8");
      try { unlinkSync(injectedMarker); } catch { /* absent */ }
      try { unlinkSync(releaseMarker); } catch { /* absent */ }

      const injectorScript = `
        import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
        const lockFile = ${JSON.stringify(lockFile)};
        const deadPid = ${JSON.stringify(String(deadPid))};
        const livePid = String(process.pid);
        const injectedMarker = ${JSON.stringify(injectedMarker)};
        const releaseMarker = ${JSON.stringify(releaseMarker)};
        const started = Date.now();
        let injected = false;
        while (Date.now() - started < 4000 && !injected) {
          try {
            const content = readFileSync(lockFile, "utf8").trim();
            if (content === deadPid) {
              try { unlinkSync(lockFile); } catch { /* raced */ }
              writeFileSync(lockFile, livePid + "\\n", "utf8");
              writeFileSync(injectedMarker, livePid + "\\n", "utf8");
              injected = true;
              break;
            }
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
              writeFileSync(lockFile, livePid + "\\n", "utf8");
              writeFileSync(injectedMarker, livePid + "\\n", "utf8");
              injected = true;
              break;
            }
          }
        }
        if (!injected) process.exit(0);
        while (!existsSync(releaseMarker)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        try { unlinkSync(lockFile); } catch { /* appender may own it */ }
      `;
      const appenderScript = `
        import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
        appendSitianRecord({
          level: "event",
          kind: ${JSON.stringify(input.kind)},
          identity: ${JSON.stringify(input.identity)} + "-" + ${attempt},
          home: ${JSON.stringify(home)},
          cwd: ${JSON.stringify(cwd)},
          payload: { marker: "after-live-release", attempt: ${attempt} },
        });
        process.stdout.write("appended\\n");
      `;

      const injector = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", injectorScript],
        { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] },
      );
      sleepBriefly(5);
      const appender = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", appenderScript],
        { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let injectorErr = "";
      let appenderErr = "";
      injector.stderr.setEncoding("utf8").on("data", (c) => { injectorErr += c; });
      appender.stderr.setEncoding("utf8").on("data", (c) => { appenderErr += c; });
      const injectorDone = childExit(injector);
      const appenderDone = childExit(appender);
      injectorDone.catch(() => undefined);
      appenderDone.catch(() => undefined);

      await withPrimaryAwareCleanup(
        async () => {
          const injected = await waitForPath(injectedMarker, 500);
          if (!injected) {
            writeFileSync(releaseMarker, "go\n", "utf8");
            await Promise.all([settleChild(injector), settleChild(appender)]);
            return;
          }
          const livePid = readFileSync(injectedMarker, "utf8").trim();
          assert.match(livePid, /^[1-9]\d*$/);
          assert.equal(
            readFileSync(lockFile, "utf8").trim(),
            livePid,
            "replacement live lock must survive dead-holder reclaim (pathname TOCTOU)",
          );
          sawProtectedLive = true;
          writeFileSync(releaseMarker, "go\n", "utf8");
          const [injectorCode, appenderCode] = await Promise.all([injectorDone, appenderDone]);
          assert.equal(injectorCode, 0, `injector failed: ${injectorErr}`);
          assert.equal(appenderCode, 0, `appender failed: ${appenderErr}`);
        },
        async () => {
          writeFileSync(releaseMarker, "go\n", "utf8");
          await Promise.all([settleChild(injector), settleChild(appender)]);
          try { unlinkSync(lockFile); } catch { /* absent */ }
        },
      );
    }

    assert.equal(
      sawProtectedLive,
      true,
      "injector never installed a live replacement across attempts — race harness failed to hit the reclaim window",
    );
  });
});
