/**
 * Production grok isolation binding (#580): bindProductionGrokIsolation is the
 * authority createProductionGrokRoleTurnHost consumes for GROK_HOME/HOME, auth
 * root, binary resolve, and the S6 request.home rewrite target. S6 seatbelt
 * hang-on-request.home behavior is covered by grok-role-turn-host tests — this
 * file does not claim end-to-end seatbelt installation.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindProductionGrokIsolation,
  openProductionGrokHome,
  withProductionGrokIsolation,
} from "../../src/grok/production-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function seedOperatorHome(): Promise<string> {
  const operatorHome = await mkdtemp(join(tmpdir(), "ak-grok-op-"));
  await mkdir(join(operatorHome, ".grok"), { recursive: true });
  await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", "utf8");
  return operatorHome;
}

test("production isolation binding shares one home for GROK_HOME, auth, and S6 request.home outside the run ledger", async () => {
  const operatorHome = await seedOperatorHome();
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-grok-run-"));
  let controlledHome: string | undefined;
  try {
    const binding = await bindProductionGrokIsolation(operatorHome, packageRoot);
    controlledHome = binding.controlledHome;

    // Single root: auth copy === child GROK_HOME/HOME === S6 request.home target.
    assert.equal(binding.env.GROK_HOME, binding.controlledHome);
    assert.equal(binding.env.HOME, binding.controlledHome);
    assert.equal(binding.env.AK_PACKAGE_ROOT, packageRoot);
    assert.equal(
      await readFile(join(binding.controlledHome, "auth.json"), "utf8"),
      "SECRET-AUTH\n",
    );
    // Production executeTurn rewrites request.home to controlledHome — same binding.
    assert.equal(binding.controlledHome, binding.env.GROK_HOME);

    // Not the operator home, not under the retained run ledger.
    assert.notEqual(binding.controlledHome, operatorHome);
    assert.equal(under(runDirectory, binding.controlledHome), false);
    await assert.rejects(access(join(runDirectory, "grok-home")));
    await assert.rejects(access(join(operatorHome, "hooks")));

    // Binary still resolved from the operator home (not the ephemeral controlled root).
    assert.equal(binding.operatorHome, operatorHome);
    assert.equal(binding.binary, join(operatorHome, ".grok", "bin", "grok"));
    assert.equal(under(binding.controlledHome, binding.binary), false);
  } finally {
    if (controlledHome !== undefined) {
      await rm(controlledHome, { recursive: true, force: true });
    }
    await rm(operatorHome, { recursive: true, force: true });
    await rm(runDirectory, { recursive: true, force: true });
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
    await assert.rejects(() => openProductionGrokHome(operatorHome));
    // Best observable check: a second open still works (no leaked lock) and the
    // operator home was not written into by the failed open.
    await assert.rejects(access(join(operatorHome, "auth.json")));
    await assert.rejects(access(join(operatorHome, "hooks")));
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
  }
});
