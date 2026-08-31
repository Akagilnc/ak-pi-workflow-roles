/**
 * Production grok isolation binding (#580): bindProductionGrokIsolation is the
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
  openProductionGrokHome,
  settleProductionGrokHomeCleanup,
  withProductionGrokIsolation,
} from "../../src/grok/production-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const CONTROLLED_HOME_PREFIX = "ak-grok-home-";
/** Path whose recursive rm fails with EPERM on macOS/Linux — cleanup-failure oracle. */
const UNREMOVABLE_HOME = "/dev/null";
const TURN_CLEANUP_MESSAGE = "production grok isolation turn and cleanup failed";
const OPEN_CLEANUP_MESSAGE = "production grok home open failed and its cleanup also failed";

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

test("production isolation binding shares one home for GROK_HOME, auth, and binary outside the operator home", async () => {
  const operatorHome = await seedOperatorHome();
  let controlledHome: string | undefined;
  try {
    const binding = await bindProductionGrokIsolation(operatorHome, packageRoot);
    controlledHome = binding.controlledHome;

    // Single root: auth copy === child GROK_HOME/HOME.
    assert.equal(binding.env.GROK_HOME, binding.controlledHome);
    assert.equal(binding.env.HOME, binding.controlledHome);
    assert.equal(binding.env.AK_PACKAGE_ROOT, packageRoot);
    assert.equal(
      await readFile(join(binding.controlledHome, "auth.json"), "utf8"),
      "SECRET-AUTH\n",
    );

    // Ephemeral root is not the operator home; binary still resolves from operator home.
    assert.notEqual(binding.controlledHome, operatorHome);
    assert.equal(binding.operatorHome, operatorHome);
    assert.equal(binding.binary, join(operatorHome, ".grok", "bin", "grok"));
    assert.equal(under(binding.controlledHome, binding.binary), false);
  } finally {
    if (controlledHome !== undefined) {
      await rm(controlledHome, { recursive: true, force: true });
    }
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("withProductionGrokIsolation removes the auth-bearing controlled home after success", async () => {
  const operatorHome = await seedOperatorHome();
  let observedHome = "";
  try {
    await withProductionGrokIsolation(operatorHome, packageRoot, async (binding) => {
      observedHome = binding.controlledHome;
      assert.equal(
        await readFile(join(binding.controlledHome, "auth.json"), "utf8"),
        "SECRET-AUTH\n",
      );
      return "ok";
    });
    assert.notEqual(observedHome, "");
    await assert.rejects(access(observedHome));
    await assert.rejects(access(join(observedHome, "auth.json")));
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("withProductionGrokIsolation preserves the primary failure and still removes controlled home", async () => {
  const operatorHome = await seedOperatorHome();
  let observedHome = "";
  try {
    await assert.rejects(
      () =>
        withProductionGrokIsolation(operatorHome, packageRoot, async (binding) => {
          observedHome = binding.controlledHome;
          throw new Error("turn-primary-failure");
        }),
      (error: unknown) =>
        error instanceof Error
        && error.message === "turn-primary-failure"
        && !(error instanceof AggregateError),
    );
    assert.notEqual(observedHome, "");
    await assert.rejects(access(observedHome));
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("openProductionGrokHome cleans a partial root when auth copy fails", async () => {
  const operatorHome = await mkdtemp(join(tmpdir(), "ak-grok-op-noauth-"));
  try {
    // No .grok/auth.json — prepareControlledGrokHome must fail after mkdtemp.
    const before = await listControlledHomeTemps();
    await assert.rejects(() => openProductionGrokHome(operatorHome));
    const after = await listControlledHomeTemps();
    // External visible result: no new ak-grok-home-* leaked under tmpdir.
    const leaked = after.filter((name) => !before.includes(name));
    assert.deepEqual(leaked, []);
    // Operator home must not absorb auth.json from the failed open (no .grok was seeded).
    await assert.rejects(access(join(operatorHome, "auth.json")));
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test("settleProductionGrokHomeCleanup surfaces cleanup failure alone", async () => {
  // Sole rm settlement authority for with/open — wrapping rm in .catch(()=>{}) goes red here.
  await assert.rejects(
    () => settleProductionGrokHomeCleanup(UNREMOVABLE_HOME, undefined, TURN_CLEANUP_MESSAGE),
    (error: unknown) =>
      error instanceof Error
      && (error as NodeJS.ErrnoException).code === "EPERM"
      && !(error instanceof AggregateError),
  );
});

test("settleProductionGrokHomeCleanup aggregates primary failure with cleanup failure", async () => {
  const primary = new Error("turn-primary-failure");
  await assert.rejects(
    () => settleProductionGrokHomeCleanup(UNREMOVABLE_HOME, primary, TURN_CLEANUP_MESSAGE),
    (error: unknown) =>
      error instanceof AggregateError
      && error.message === TURN_CLEANUP_MESSAGE
      && error.errors[0] === primary
      && error.errors.length === 2
      && error.cause === primary,
  );
});

test("settleProductionGrokHomeCleanup aggregates open primary failure with cleanup failure", async () => {
  const primary = new Error("auth-copy-failed");
  await assert.rejects(
    () => settleProductionGrokHomeCleanup(UNREMOVABLE_HOME, primary, OPEN_CLEANUP_MESSAGE),
    (error: unknown) =>
      error instanceof AggregateError
      && error.message === OPEN_CLEANUP_MESSAGE
      && error.errors[0] === primary
      && error.errors.length === 2,
  );
});
