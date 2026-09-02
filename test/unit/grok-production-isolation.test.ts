/**
 * Production grok isolation binding (#580 / #594): bindProductionGrokIsolation is the
 * authority createProductionGrokRoleTurnHost consumes for GROK_HOME/HOME, auth
 * root, and binary resolve. S6 seatbelt hang-on-request.home is covered by
 * grok-role-turn-host tests — this file proves the binding and cleanup settlement,
 * not executeTurn home rewrite or end-to-end seatbelt installation.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindProductionGrokIsolation,
  NO_PRODUCTION_GROK_PRIMARY_FAILURE,
  openProductionGrokHome,
  settleProductionGrokHomeCleanup,
  withProductionGrokIsolation,
} from "../../src/grok/production-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const CONTROLLED_HOME_PREFIX = "ak-grok-home-";
/** Path whose auth.json rm fails — cleanup-failure oracle (errno is platform-local). */
const UNREMOVABLE_HOME = "/dev/null";
const TURN_CLEANUP_MESSAGE = "production grok isolation turn and cleanup failed";

function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Snapshot of production controlled-home temp dirs currently under os.tmpdir(). */
async function listControlledHomeTemps(): Promise<string[]> {
  const names = await readdir(tmpdir());
  return names.filter((name) => name.startsWith(CONTROLLED_HOME_PREFIX)).sort();
}

async function seedOperatorHome(): Promise<string> {
  const operatorHome = await mkdtemp(join(tmpdir(), "ak-grok-op-"));
  await mkdir(join(operatorHome, ".grok"), { recursive: true });
  await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", "utf8");
  return operatorHome;
}

async function seedRunDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ak-grok-run-"));
}

test("production isolation binding shares one home for GROK_HOME, auth, and binary outside the operator home under runDirectory", async () => {
  const operatorHome = await seedOperatorHome();
  const runDirectory = await seedRunDirectory();
  try {
    const binding = await bindProductionGrokIsolation(runDirectory, operatorHome, packageRoot);

    // Single root: auth copy === child GROK_HOME/HOME under runDirectory.
    assert.equal(binding.controlledHome, join(runDirectory, "grok-home"));
    assert.equal(under(runDirectory, binding.controlledHome), true);
    assert.equal(binding.env.GROK_HOME, binding.controlledHome);
    assert.equal(binding.env.HOME, binding.controlledHome);
    assert.equal(binding.env.AK_PACKAGE_ROOT, packageRoot);
    assert.equal(
      await readFile(join(binding.controlledHome, "auth.json"), "utf8"),
      "SECRET-AUTH\n",
    );

    // Controlled root is not the operator home; binary still resolves from operator home.
    assert.notEqual(binding.controlledHome, operatorHome);
    assert.equal(binding.operatorHome, operatorHome);
    assert.equal(binding.binary, join(operatorHome, ".grok", "bin", "grok"));
    assert.equal(under(binding.controlledHome, binding.binary), false);
    assert.equal(under(runDirectory, binding.binary), false);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("withProductionGrokIsolation scrubs auth.json after success while preserving the session dossier", async () => {
  const operatorHome = await seedOperatorHome();
  const runDirectory = await seedRunDirectory();
  let observedHome = "";
  try {
    await withProductionGrokIsolation(runDirectory, operatorHome, packageRoot, async (binding) => {
      observedHome = binding.controlledHome;
      assert.equal(
        await readFile(join(binding.controlledHome, "auth.json"), "utf8"),
        "SECRET-AUTH\n",
      );
      // Simulate native grok live session dossier written during turn
      const sessionDir = join(binding.controlledHome, "sessions", "cwd-encoded", "session-123");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "updates.jsonl"), '{"type":"message","text":"hello"}\n', "utf8");
      return "ok";
    });
    assert.notEqual(observedHome, "");
    // Controlled home directory remains under runDirectory
    await access(observedHome);
    // auth.json is scrubbed
    await assert.rejects(access(join(observedHome, "auth.json")));
    // Session dossier survives settlement (#594 acceptance bite)
    const sessionFile = join(observedHome, "sessions", "cwd-encoded", "session-123", "updates.jsonl");
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"message","text":"hello"}\n');
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("withProductionGrokIsolation preserves the primary failure, scrubs auth.json, and preserves session dossier", async () => {
  const operatorHome = await seedOperatorHome();
  const runDirectory = await seedRunDirectory();
  let observedHome = "";
  try {
    await assert.rejects(
      () =>
        withProductionGrokIsolation(runDirectory, operatorHome, packageRoot, async (binding) => {
          observedHome = binding.controlledHome;
          const sessionDir = join(binding.controlledHome, "sessions", "cwd-encoded", "session-456");
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "updates.jsonl"), '{"type":"message","text":"failed-turn"}\n', "utf8");
          throw new Error("turn-primary-failure");
        }),
      (error: unknown) =>
        error instanceof Error
        && error.message === "turn-primary-failure"
        && !(error instanceof AggregateError),
    );
    assert.notEqual(observedHome, "");
    await access(observedHome);
    await assert.rejects(access(join(observedHome, "auth.json")));
    const sessionFile = join(observedHome, "sessions", "cwd-encoded", "session-456", "updates.jsonl");
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"message","text":"failed-turn"}\n');
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("withProductionGrokIsolation rethrows undefined primary, scrubs auth.json, and preserves controlled home", async () => {
  const operatorHome = await seedOperatorHome();
  const runDirectory = await seedRunDirectory();
  let observedHome = "";
  try {
    let rejected: { settled: false } | { settled: true; value: unknown } = { settled: false };
    try {
      await withProductionGrokIsolation(runDirectory, operatorHome, packageRoot, async (binding) => {
        observedHome = binding.controlledHome;
        return Promise.reject(undefined);
      });
    } catch (error) {
      rejected = { settled: true, value: error };
    }
    assert.deepEqual(rejected, { settled: true, value: undefined });
    assert.notEqual(observedHome, "");
    await access(observedHome);
    await assert.rejects(access(join(observedHome, "auth.json")));
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("openProductionGrokHome does not leak auth or tmpdir when auth copy fails", async () => {
  const operatorHome = await mkdtemp(join(tmpdir(), "ak-grok-op-noauth-"));
  const runDirectory = await seedRunDirectory();
  try {
    // No .grok/auth.json — prepareControlledGrokHome must fail.
    const before = await listControlledHomeTemps();
    await assert.rejects(() => openProductionGrokHome(runDirectory, operatorHome));
    const after = await listControlledHomeTemps();
    // External visible result: no new ak-grok-home-* leaked under tmpdir.
    const leaked = after.filter((name) => !before.includes(name));
    assert.deepEqual(leaked, []);
    // Controlled home under runDirectory has no leaked auth.json.
    await assert.rejects(access(join(runDirectory, "grok-home", "auth.json")));
    // Operator home must not absorb auth.json from the failed open (no .grok was seeded).
    await assert.rejects(access(join(operatorHome, "auth.json")));
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("settleProductionGrokHomeCleanup surfaces cleanup failure alone", async () => {
  // Sole rm settlement authority for with/open — silent catch goes red here.
  // Contract is non-Aggregate cleanup failure; platform errno is not part of it.
  await assert.rejects(
    () =>
      settleProductionGrokHomeCleanup(
        UNREMOVABLE_HOME,
        NO_PRODUCTION_GROK_PRIMARY_FAILURE,
        TURN_CLEANUP_MESSAGE,
      ),
    (error: unknown) => error instanceof Error && !(error instanceof AggregateError),
  );
});

test("settleProductionGrokHomeCleanup aggregates undefined primary with cleanup failure", async () => {
  // Shortest primary+cleanup proof; primary=undefined is the sentinel-collision case.
  await assert.rejects(
    () =>
      settleProductionGrokHomeCleanup(
        UNREMOVABLE_HOME,
        { present: true, value: undefined },
        TURN_CLEANUP_MESSAGE,
      ),
    (error: unknown) =>
      error instanceof AggregateError
      && error.errors.length === 2
      && error.errors[0] === undefined
      && error.errors[1] instanceof Error
      && error.cause === undefined,
  );
});
