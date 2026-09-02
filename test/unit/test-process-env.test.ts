/**
 * Owning seam for scripts/test-process-env.mjs pure option contract (#549 AC5).
 * Host-miss / preload / package.json wiring live on the real-entry integration seam.
 * #612: default process test home is create-and-delete, not create-and-abandon.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isolatedTestProcessEnv } from "../../scripts/test-process-env.mjs";

const HOST_HOME = userInfo().homedir;
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROCESS_ENV_MODULE = join(REPO_ROOT, "scripts/test-process-env.mjs");

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

/**
 * #612 DK-1: default isolated HOME is a temporary root owned by the process —
 * create under temp, delete on exit. Books written under it must not survive.
 */
test("isolatedTestProcessEnv: default home is removed when owning process exits", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { isolatedTestProcessEnv } from ${JSON.stringify(PROCESS_ENV_MODULE)};
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const env = isolatedTestProcessEnv();
const book = join(env.HOME, ".ak-roles", "books", "probe-book");
mkdirSync(book, { recursive: true });
writeFileSync(join(book, "marker"), "#612");
process.stdout.write(env.HOME);
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const home = child.stdout.trim();
  assert.ok(home.length > 0, "child must report default home path");
  assert.equal(existsSync(home), false, `default test home must be deleted on exit: ${home}`);
});

/** Explicit options.home is caller-owned — process exit must not delete it. */
test("isolatedTestProcessEnv: explicit options.home is not deleted on process exit", () => {
  const custom = mkdtempSync(join(tmpdir(), "ak-612-explicit-survive-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { isolatedTestProcessEnv } from ${JSON.stringify(PROCESS_ENV_MODULE)};
isolatedTestProcessEnv({ home: ${JSON.stringify(custom)} });
`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(custom), true, "caller-owned home must survive child exit");
  } finally {
    rmSync(custom, { recursive: true, force: true });
  }
});
