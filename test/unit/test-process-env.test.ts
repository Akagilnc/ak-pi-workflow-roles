/**
 * Owning seam for scripts/test-process-env.mjs pure option contract (#549 AC5).
 * #685: default process test home is create-and-leave under system tmpdir.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isolatedTestProcessEnv } from "../../scripts/test-process-env.mjs";

const HOST_HOME = userInfo().homedir;

test("isolatedTestProcessEnv: options.home wins over default and env.HOME", () => {
  const custom = mkdtempSync(join(tmpdir(), "ak-549-explicit-home-"));
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
});

test("isolatedTestProcessEnv: default home is under system tmpdir", () => {
  const env = isolatedTestProcessEnv({ env: { ...process.env, HOME: HOST_HOME } });
  assert.ok(typeof env.HOME === "string" && env.HOME.length > 0);
  assert.ok(
    env.HOME.startsWith(tmpdir()) || env.HOME.startsWith("/tmp"),
    `default home must be under system tmpdir, got ${env.HOME}`,
  );
  assert.notEqual(env.HOME, HOST_HOME);
});
