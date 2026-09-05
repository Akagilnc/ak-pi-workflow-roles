/**
 * Production grok isolation binding (#580 / #594): bindProductionGrokIsolation is the
 * authority createProductionGrokRoleTurnHost consumes for GROK_HOME/HOME, auth
 * root, and binary resolve. S6 seatbelt hang-on-request.home is covered by
 * grok-role-turn-host tests — this file proves the binding and cleanup settlement,
 * including residual auth/hook scrub and symlink refusal (#594 F1/F3/F4).
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { installGrokPreToolUseDeny } from "../../src/grok/bash-seatbelt.ts";
import {
  bindProductionGrokIsolation,
  NO_PRODUCTION_GROK_PRIMARY_FAILURE,
  openProductionGrokHome,
  settleProductionGrokHomeCleanup,
  withProductionGrokIsolation,
} from "../../src/grok/production-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

/** Path whose auth.json rm fails — cleanup-failure oracle (errno is platform-local). */
const UNREMOVABLE_HOME = "/dev/null";
const TURN_CLEANUP_MESSAGE = "production grok isolation turn and cleanup failed";

function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function seedOperatorHome(): Promise<string> {
  const operatorHome = await mkdtemp(worktreeTempPrefix("ak-grok-op-"));
  await mkdir(join(operatorHome, ".grok"), { recursive: true });
  await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", "utf8");
  return operatorHome;
}

async function seedRunDirectory(): Promise<string> {
  return await mkdtemp(worktreeTempPrefix("ak-grok-run-"));
}

/** Own create→assert→cleanup for operator + run roots (exception path too). */
async function withGrokFixtureRoots<T>(
  run: (roots: { operatorHome: string; runDirectory: string }) => Promise<T>,
): Promise<T> {
  const operatorHome = await seedOperatorHome();
  const runDirectory = await seedRunDirectory();
  try {
    return await run({ operatorHome, runDirectory });
  } finally {
    const failures: unknown[] = [];
    for (const path of [operatorHome, runDirectory]) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "grok fixture cleanup failed");
    }
  }
}

test("production isolation binding shares one home for GROK_HOME, auth, and binary outside the operator home under runDirectory", async () => {
  await withGrokFixtureRoots(async ({ operatorHome, runDirectory }) => {
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
  });
});

test("withProductionGrokIsolation scrubs auth.json and AK seatbelt hooks after success while preserving the session dossier", async () => {
  await withGrokFixtureRoots(async ({ operatorHome, runDirectory }) => {
    let observedHome = "";
    await withProductionGrokIsolation(runDirectory, operatorHome, packageRoot, async (binding) => {
      observedHome = binding.controlledHome;
      assert.equal(
        await readFile(join(binding.controlledHome, "auth.json"), "utf8"),
        "SECRET-AUTH\n",
      );
      // Simulate Fixer PreToolUse install + native grok live session dossier.
      await installGrokPreToolUseDeny(binding.controlledHome);
      await access(join(binding.controlledHome, "hooks", "ak-bash-seatbelt.json"));
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
    // AK seatbelt hook residue is scrubbed (#594 F1) so resume inspect stays clean
    await assert.rejects(access(join(observedHome, "hooks", "ak-bash-seatbelt.json")));
    await assert.rejects(access(join(observedHome, "hooks", "ak-bash-seatbelt.mjs")));
    // Session dossier survives settlement (#594 acceptance bite)
    const sessionFile = join(observedHome, "sessions", "cwd-encoded", "session-123", "updates.jsonl");
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"message","text":"hello"}\n');
  });
});

test("withProductionGrokIsolation preserves the primary failure, scrubs auth.json, and preserves session dossier", async () => {
  await withGrokFixtureRoots(async ({ operatorHome, runDirectory }) => {
    let observedHome = "";
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
  });
});

test("withProductionGrokIsolation rethrows undefined primary, scrubs auth.json, and preserves controlled home", async () => {
  await withGrokFixtureRoots(async ({ operatorHome, runDirectory }) => {
    let observedHome = "";
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
  });
});

test("openProductionGrokHome does not leak auth when auth copy fails", async () => {
  const operatorHome = await mkdtemp(worktreeTempPrefix("ak-grok-op-noauth-"));
  const runDirectory = await seedRunDirectory();
  try {
    // No .grok/auth.json — prepareControlledGrokHome must fail.
    await assert.rejects(() => openProductionGrokHome(runDirectory, operatorHome));
    // Controlled home under runDirectory has no leaked auth.json.
    await assert.rejects(access(join(runDirectory, "grok-home", "auth.json")));
    // Operator home must not absorb auth.json from the failed open (no .grok was seeded).
    await assert.rejects(access(join(operatorHome, "auth.json")));
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("openProductionGrokHome scrubs crash-window residual auth before recopying", async () => {
  await withGrokFixtureRoots(async ({ operatorHome, runDirectory }) => {
    const controlledHome = join(runDirectory, "grok-home");
    await mkdir(controlledHome, { recursive: true });
    await writeFile(join(controlledHome, "auth.json"), "STALE-CRASH-AUTH\n", "utf8");
    const opened = await openProductionGrokHome(runDirectory, operatorHome);
    assert.equal(opened, controlledHome);
    assert.equal(await readFile(join(controlledHome, "auth.json"), "utf8"), "SECRET-AUTH\n");
  });
});

test("openProductionGrokHome refuses a symlinked grok-home before auth copy", async () => {
  await withGrokFixtureRoots(async ({ operatorHome, runDirectory }) => {
    const escapeTarget = await mkdtemp(worktreeTempPrefix("ak-grok-escape-"));
    try {
      await symlink(escapeTarget, join(runDirectory, "grok-home"));
      // Refusal is the contract; message prose is not. open primary + settle both refuse → AggregateError.
      await assert.rejects(
        () => openProductionGrokHome(runDirectory, operatorHome),
        (error: unknown) => error instanceof Error,
      );
      // Escape target must not receive operator credentials.
      await assert.rejects(access(join(escapeTarget, "auth.json")));
    } finally {
      await rm(escapeTarget, { recursive: true, force: true });
    }
  });
});

test("settleProductionGrokHomeCleanup refuses symlinked auth destination", async () => {
  const controlledHome = await mkdtemp(worktreeTempPrefix("ak-grok-settle-symlink-"));
  const escapeTarget = await mkdtemp(worktreeTempPrefix("ak-grok-auth-escape-"));
  const escapeAuth = join(escapeTarget, "auth.json");
  try {
    await writeFile(escapeAuth, "OUTSIDE-SECRET\n", "utf8");
    await symlink(escapeAuth, join(controlledHome, "auth.json"));
    // Refusal is the contract; message prose is not.
    await assert.rejects(
      () =>
        settleProductionGrokHomeCleanup(
          controlledHome,
          NO_PRODUCTION_GROK_PRIMARY_FAILURE,
          TURN_CLEANUP_MESSAGE,
        ),
      (error: unknown) => error instanceof Error && !(error instanceof AggregateError),
    );
    // Outside target must survive — settle must not follow the symlink.
    assert.equal(await readFile(escapeAuth, "utf8"), "OUTSIDE-SECRET\n");
  } finally {
    await rm(controlledHome, { recursive: true, force: true });
    await rm(escapeTarget, { recursive: true, force: true });
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
