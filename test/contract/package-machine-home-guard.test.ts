/**
 * #604 F2: shortest real cross-process proofs for the machine-home guard.
 * - Two competitors cannot occupy the critical section at once.
 * - Killed holder leaves stale lock/backup; next entry restores original config bytes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { packageMachineHome } from "../../src/activation-ledger-topology.ts";
import {
  pathExists,
  withPackageMachineHomeGuard,
} from "../helpers/package-machine-home-guard.ts";

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../helpers/package-machine-home-guard-worker.ts",
);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function spawnWorker(args: string[]): {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
} {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
  return { child, done };
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pathExists(path))) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function residuePaths(packageHome: string): {
  lockPath: string;
  backupPath: string;
  configPath: string;
} {
  const dot = join(packageHome, ".ak-roles");
  return {
    configPath: join(dot, "public-cli.json"),
    lockPath: join(dot, "public-cli.json.ak-roles-test.lock"),
    backupPath: join(dot, "public-cli.json.ak-roles-test-backup"),
  };
}

test("machine-home guard: two cross-process competitors never overlap critical section", async () => {
  const coordDir = await mkdtemp(join(tmpdir(), "ak-guard-critical-"));
  const packageHome = packageMachineHome();
  const { configPath, lockPath, backupPath } = residuePaths(packageHome);
  const prior = await readOptional(configPath);
  const priorSha = prior === undefined ? null : sha256(prior);
  try {
    const a = spawnWorker(["critical", coordDir, "a"]);
    const b = spawnWorker(["critical", coordDir, "b"]);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, `worker a: ${ra.stderr}`);
    assert.equal(rb.code, 0, `worker b: ${rb.stderr}`);

    const logText = await readFile(join(coordDir, "log.jsonl"), "utf8");
    const events = logText
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; event: string; t: number });
    const byId = new Map<string, { enter?: number; exit?: number }>();
    for (const event of events) {
      const row = byId.get(event.id) ?? {};
      if (event.event === "enter") row.enter = event.t;
      if (event.event === "exit") row.exit = event.t;
      byId.set(event.id, row);
    }
    assert.equal(byId.size, 2);
    const intervals = [...byId.values()].map((row) => {
      assert.ok(typeof row.enter === "number" && typeof row.exit === "number");
      assert.ok(row.exit >= row.enter);
      return { enter: row.enter, exit: row.exit };
    });
    // No overlap: one fully exits before the other enters (lock serializes).
    intervals.sort((x, y) => x.enter - y.enter);
    assert.ok(
      intervals[0]!.exit <= intervals[1]!.enter,
      `overlap: ${JSON.stringify(intervals)}`,
    );

    const after = await readOptional(configPath);
    assert.equal(
      after === undefined ? null : sha256(after),
      priorSha,
      "host public-cli.json bytes unchanged",
    );
    assert.equal(await pathExists(lockPath), false, "no lock residue");
    assert.equal(await pathExists(backupPath), false, "no backup residue");
  } finally {
    await rm(coordDir, { recursive: true, force: true });
  }
});

test("machine-home guard: killed holder restores original config bytes on next entry", async () => {
  const coordDir = await mkdtemp(join(tmpdir(), "ak-guard-kill-"));
  const packageHome = packageMachineHome();
  const { configPath, lockPath, backupPath } = residuePaths(packageHome);
  const prior = await readOptional(configPath);
  const priorSha = prior === undefined ? null : sha256(prior);
  try {
    const { child, done } = spawnWorker(["hold-and-mutate", coordDir]);
    await waitForFile(join(coordDir, "inside"));
    // Config must have been mutated under the lock.
    const mid = await readOptional(configPath);
    assert.ok(mid !== undefined && mid.includes("akGuardProbe"));
    if (priorSha !== null) {
      assert.notEqual(sha256(mid), priorSha);
    }
    // Hard-kill before finally: lock + backup residue must still recover.
    const killedPromise = done;
    child.kill("SIGKILL");
    const killed = await killedPromise;
    assert.ok(
      killed.signal === "SIGKILL" || killed.code !== 0,
      `expected kill termination, got code=${String(killed.code)} signal=${String(killed.signal)} stderr=${killed.stderr}`,
    );

    // Next entry recovers via leftover backup and leaves host bytes identical.
    await withPackageMachineHomeGuard(async () => {
      const inside = await readOptional(configPath);
      if (priorSha === null) {
        // No prior host config: recovery may leave empty seats from child mutate
        // only until we finish; finally deletes when restoreFromBackup is false
        // after stale backup path. Stale backup from child should restore prior
        // absence by rewriting then... child had prior undefined → no backup →
        // parent sees mutated file as prior. Accept any value here; final check
        // below is authoritative when prior existed.
        assert.ok(inside !== undefined);
      } else {
        assert.equal(sha256(inside!), priorSha, "stale backup restored before scenario");
      }
    });

    const after = await readOptional(configPath);
    assert.equal(
      after === undefined ? null : sha256(after),
      priorSha,
      "host public-cli.json restored after killed holder",
    );
    assert.equal(await pathExists(lockPath), false, "no lock residue");
    assert.equal(await pathExists(backupPath), false, "no backup residue");
  } finally {
    await rm(coordDir, { recursive: true, force: true });
    // Belt: if prior existed and something failed, try one more guard restore.
    if (priorSha !== null) {
      const now = await readOptional(configPath);
      if (now === undefined || sha256(now) !== priorSha) {
        await withPackageMachineHomeGuard(async () => undefined);
      }
    }
  }
});
