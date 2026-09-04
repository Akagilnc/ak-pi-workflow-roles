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
    writeFileSync(lockFile, `${process.pid}\n`, "utf8");

    const script = `
      import { appendSitianRecord } from ${JSON.stringify(join(packageRoot, "src/sitian-appender.ts"))};
      process.stdout.write("attempting\\n");
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
    const attempting = new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`live-lock contender exited ${String(code)}: ${stderr}`));
      });
    });

    await withPrimaryAwareCleanup(
      async () => {
        await attempting;
        // Contender is inside the wait loop; live lock must remain ours.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        assert.equal(
          readFileSync(lockFile, "utf8").trim(),
          String(process.pid),
          "live lock must not be stolen",
        );
        assert.equal(existsSync(recordFile), false, "contender must not append while live lock held");

        // Release as a graceful unlock (not SIGKILL); contender may proceed.
        const { unlinkSync } = await import("node:fs");
        unlinkSync(lockFile);
        await done;

        assert.match(readFileSync(recordFile, "utf8"), /live-holder-proof/);
      },
      async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await done.then(
          () => undefined,
          () => undefined,
        );
      },
    );
  });
});
