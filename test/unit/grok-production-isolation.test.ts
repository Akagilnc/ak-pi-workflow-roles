/**
 * Production grok-build isolation seam (#580): one ephemeral home for
 * GROK_HOME + seatbelt hang + auth copy; never under retained runDirectory.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installGrokPreToolUseDeny } from "../../src/grok/bash-seatbelt.ts";
import { openProductionGrokHome } from "../../src/grok/production-host.ts";
import { controlledGrokChildEnv } from "../../src/grok/role-turn-host.ts";

test("production grok isolation: GROK_HOME, seatbelt root, and auth share one home outside the run ledger", async () => {
  const operatorHome = await mkdtemp(join(tmpdir(), "ak-grok-op-"));
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-grok-run-"));
  let controlledHome: string | undefined;
  try {
    await mkdir(join(operatorHome, ".grok"), { recursive: true });
    await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", "utf8");

    controlledHome = await openProductionGrokHome(operatorHome);

    // Auth lives only in the isolated home — not under the retained run ledger.
    assert.equal(await readFile(join(controlledHome, "auth.json"), "utf8"), "SECRET-AUTH\n");
    await assert.rejects(access(join(runDirectory, "grok-home")));
    await assert.rejects(access(join(runDirectory, "grok-home", "auth.json")));
    assert.equal(
      controlledHome === runDirectory || controlledHome.startsWith(`${runDirectory}/`),
      false,
      "controlled home must not fall under retained runDirectory",
    );

    // Child env and seatbelt hang on the same isolated root (not operator $HOME).
    const env = controlledGrokChildEnv({ PATH: "/bin" }, controlledHome);
    assert.equal(env.GROK_HOME, controlledHome);
    assert.equal(env.HOME, controlledHome);
    await installGrokPreToolUseDeny(controlledHome);
    await readFile(join(controlledHome, "hooks", "ak-bash-seatbelt.json"), "utf8");
    await assert.rejects(access(join(operatorHome, "hooks")));
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
    await rm(runDirectory, { recursive: true, force: true });
    if (controlledHome !== undefined) {
      await rm(controlledHome, { recursive: true, force: true });
    }
  }
});
