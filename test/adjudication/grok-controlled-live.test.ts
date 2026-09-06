import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import {
  controlledGrokChildEnv,
  inspectControlledGrok,
  prepareControlledGrokHome,
} from "../../src/grok/role-turn-host.ts";

const binary = join(homedir(), ".grok", "bin", "grok");
const auth = join(homedir(), ".grok", "auth.json");

/** Bare live seam: ordinary tests cannot prove first-party Grok discovery/isolation. */
test("real Grok isolates a personalized authenticated home while retaining AK project material", async (t) => {
  try {
    await Promise.all([access(binary), access(auth)]);
  } catch {
    t.skip("installed authenticated Grok is unavailable");
    return;
  }

  const cwd = resolve(".");
  const personalized = await inspectControlledGrok({
    binary,
    cwd,
    env: process.env,
    packageRoot: cwd,
  });
  assert.ok(personalized.privateActive.length > 0, "fixture home must actually be personalized");

  await withTempRoot("ak-grok-controlled-live-", async (controlledHome) => {
    await prepareControlledGrokHome(homedir(), controlledHome);
    const controlled = await inspectControlledGrok({
      binary,
      cwd,
      env: controlledGrokChildEnv(process.env, controlledHome),
      packageRoot: cwd,
    });
    assert.deepEqual(controlled.privateActive, []);
    assert.ok(controlled.akActive.length > 0, "AK project material must remain active");
    });
});
