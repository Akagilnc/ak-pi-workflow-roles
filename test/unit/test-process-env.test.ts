/**
 * Owning seam for scripts/test-process-env.mjs pure option contract (#549 AC5).
 * Host-miss / preload / package.json wiring live on the real-entry integration seam.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isolatedTestProcessEnv } from "../../scripts/test-process-env.mjs";

const HOST_HOME = userInfo().homedir;

/** AC5: explicit options.home wins over default and over env.HOME. */
test("isolatedTestProcessEnv: options.home wins over default and env.HOME", () => {
  const custom = mkdtempSync(join(tmpdir(), "ak-549-explicit-home-"));
  try {
    const env = isolatedTestProcessEnv({
      env: { ...process.env, HOME: HOST_HOME },
      home: custom,
    });
    assert.equal(env.HOME, custom);
    assert.equal(env.XDG_CONFIG_HOME, join(custom, ".config"));
    assert.equal(env.XDG_DATA_HOME, join(custom, ".local", "share"));
    assert.equal(env.XDG_CACHE_HOME, join(custom, ".cache"));
    assert.equal(env.AK_ROLE_RUN_DIR, undefined);
    assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  } finally {
    rmSync(custom, { recursive: true, force: true });
  }
});
