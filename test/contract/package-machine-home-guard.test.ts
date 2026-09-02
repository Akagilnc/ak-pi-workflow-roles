/**
 * #604 F2/F3: shortest real cross-process proofs for the machine-home guard.
 * - Two competitors cannot occupy the critical section at once.
 * - Crashed holder (process.exit inside section, not SIGKILL) leaves stale
 *   lock/backup; next entry restores original config bytes OR absence.
 * - Multiple stale reclaimers serialize; none deletes a successor's lock.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function spawnWorker(
  args: string[],
  envExtra?: Record<string, string>,
): {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
} {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: envExtra === undefined ? process.env : { ...process.env, ...envExtra },
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

test("machine-home guard: crash-exit holder restores original config bytes on next entry", async () => {
  const coordDir = await mkdtemp(join(tmpdir(), "ak-guard-crash-"));
  const packageHome = packageMachineHome();
  const { configPath, lockPath, backupPath } = residuePaths(packageHome);
  const prior = await readOptional(configPath);
  const priorSha = prior === undefined ? null : sha256(prior);
  try {
    const { done } = spawnWorker(["hold-and-mutate-exit", coordDir]);
    await waitForFile(join(coordDir, "inside"));
    const crashed = await done;
    assert.equal(crashed.signal, null, "must not use signal kill");
    assert.equal(crashed.code, 99, `expected crash exit 99, stderr=${crashed.stderr}`);

    // Residue must remain so the next entry can recover.
    assert.equal(await pathExists(lockPath), true, "stale lock remains after crash exit");
    assert.equal(await pathExists(backupPath), true, "backup remains after crash exit");

    const mid = await readOptional(configPath);
    assert.ok(mid !== undefined && mid.includes("akGuardProbe"), "crash left mutated config");

    // Next entry recovers via leftover backup (presence or absence).
    await withPackageMachineHomeGuard(async () => {
      const inside = await readOptional(configPath);
      if (priorSha === null) {
        assert.equal(inside, undefined, "absence backup restored missing config before scenario");
      } else {
        assert.equal(sha256(inside!), priorSha, "stale backup restored before scenario");
      }
    });

    const after = await readOptional(configPath);
    assert.equal(
      after === undefined ? null : sha256(after),
      priorSha,
      "host public-cli.json restored after crashed holder",
    );
    assert.equal(await pathExists(lockPath), false, "no lock residue");
    assert.equal(await pathExists(backupPath), false, "no backup residue");
  } finally {
    await rm(coordDir, { recursive: true, force: true });
    // Belt: one more restore if prior existed and something failed mid-test.
    if (priorSha !== null) {
      const now = await readOptional(configPath);
      if (now === undefined || sha256(now) !== priorSha) {
        await withPackageMachineHomeGuard(async () => undefined);
      }
    } else {
      const now = await readOptional(configPath);
      if (now !== undefined && now.includes("akGuardProbe")) {
        await withPackageMachineHomeGuard(async () => undefined);
      }
    }
  }
});

test("machine-home guard: absence-coded backup restores missing config after crash exit", async () => {
  // Hermetic package home: prior config is genuinely absent; crash must not leave
  // a seat table behind after the next entry restores the absence-coded backup.
  const hermeticHome = await mkdtemp(join(tmpdir(), "ak-guard-absent-home-"));
  const coordDir = await mkdtemp(join(tmpdir(), "ak-guard-absent-"));
  const { configPath, lockPath, backupPath } = residuePaths(hermeticHome);
  const envExtra = { AK_GUARD_PACKAGE_HOME: hermeticHome };
  try {
    assert.equal(await readOptional(configPath), undefined, "precondition: no config");

    const { done } = spawnWorker(["hold-and-mutate-exit", coordDir], envExtra);
    await waitForFile(join(coordDir, "inside"));
    const crashed = await done;
    assert.equal(crashed.signal, null, "must not use signal kill");
    assert.equal(crashed.code, 99, `stderr=${crashed.stderr}`);
    assert.ok(await pathExists(configPath), "crash created config");
    assert.ok(await pathExists(lockPath), "stale lock remains");
    const backup = await readOptional(backupPath);
    assert.ok(backup?.startsWith("A"), `backup encodes absence, got ${JSON.stringify(backup)}`);

    await withPackageMachineHomeGuard({ packageHome: hermeticHome }, async () => {
      assert.equal(
        await readOptional(configPath),
        undefined,
        "absence restored before nested scenario",
      );
    });

    assert.equal(await readOptional(configPath), undefined, "config remains absent");
    assert.equal(await pathExists(lockPath), false);
    assert.equal(await pathExists(backupPath), false);
  } finally {
    await rm(coordDir, { recursive: true, force: true });
    await rm(hermeticHome, { recursive: true, force: true });
  }
});

test("machine-home guard: concurrent stale reclaimers serialize; successor lock survives", async () => {
  // Hermetic package home so multi-reclaim never plants locks on the host seat table.
  const hermeticHome = await mkdtemp(join(tmpdir(), "ak-guard-reclaim-home-"));
  const coordDir = await mkdtemp(join(tmpdir(), "ak-guard-reclaim-"));
  const { configPath, lockPath, backupPath } = residuePaths(hermeticHome);
  const seedConfig = `${JSON.stringify({ seats: { seed: true }, tag: "reclaim-prior" }, null, 2)}\n`;
  await mkdir(join(hermeticHome, ".ak-roles"), { recursive: true });
  await writeFile(configPath, seedConfig, "utf8");
  const priorSha = sha256(seedConfig);
  const envExtra = { AK_GUARD_PACKAGE_HOME: hermeticHome };

  // Plant a stale lock from a definitely-dead pid with unique payload.
  const deadPid = 2 ** 22 + (randomBytes(2).readUInt16BE(0) % 100_000);
  const stalePayload = `${deadPid}\n0\nstale-${randomBytes(4).toString("hex")}\n`;
  await writeFile(lockPath, stalePayload, "utf8");

  try {
    const a = spawnWorker(["reclaim-stale", coordDir, "r1"], envExtra);
    const b = spawnWorker(["reclaim-stale", coordDir, "r2"], envExtra);
    const c = spawnWorker(["reclaim-stale", coordDir, "r3"], envExtra);
    const results = await Promise.all([a.done, b.done, c.done]);
    for (const result of results) {
      assert.equal(result.code, 0, `reclaimer failed: ${result.stderr}`);
    }

    const logText = await readFile(join(coordDir, "reclaim.jsonl"), "utf8");
    const events = logText
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; event: string; t: number });
    assert.equal(events.filter((e) => e.event === "entered").length, 3);
    assert.equal(events.filter((e) => e.event === "left").length, 3);

    const byId = new Map<string, { enter?: number; exit?: number }>();
    for (const event of events) {
      const row = byId.get(event.id) ?? {};
      if (event.event === "entered") row.enter = event.t;
      if (event.event === "left") row.exit = event.t;
      byId.set(event.id, row);
    }
    const intervals = [...byId.values()].map((row) => {
      assert.ok(typeof row.enter === "number" && typeof row.exit === "number");
      return { enter: row.enter, exit: row.exit };
    });
    intervals.sort((x, y) => x.enter - y.enter);
    for (let i = 0; i < intervals.length - 1; i += 1) {
      assert.ok(
        intervals[i]!.exit <= intervals[i + 1]!.enter,
        `reclaim overlap: ${JSON.stringify(intervals)}`,
      );
    }

    const after = await readOptional(configPath);
    assert.equal(sha256(after!), priorSha, "config bytes unchanged after multi-reclaim");
    assert.equal(await pathExists(lockPath), false, "no lock residue after multi-reclaim");
    assert.equal(await pathExists(backupPath), false, "no backup residue after multi-reclaim");
  } finally {
    await rm(coordDir, { recursive: true, force: true });
    await rm(hermeticHome, { recursive: true, force: true });
  }
});
