/**
 * Build an environment for test-owned processes without inheriting machine
 * role-ledger or Pi-home pointers. Right-hand masks survive downstream env
 * remerges; Node spawn omits undefined values.
 *
 * Default (#549): HOME + XDG_* point at a per-process temp directory so
 * fixtures that resolve through $HOME cannot touch the host ~/.pi tree.
 * Explicit options.home wins over that default.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, agentDir?: string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Per-process default temp HOME for this test run (Scope 1). */
let defaultTestHome;

export function defaultIsolatedTestHome() {
  if (defaultTestHome === undefined) {
    defaultTestHome = mkdtempSync(join(tmpdir(), "ak-roles-test-home-"));
  }
  return defaultTestHome;
}

function redirectHomeEnv(env, home) {
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.XDG_CACHE_HOME = join(home, ".cache");
}

export function isolatedTestProcessEnv(options = {}) {
  const env = {
    ...(options.env ?? process.env),
    AK_ROLE_RUN_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  const home =
    options.home !== undefined ? options.home : defaultIsolatedTestHome();
  redirectHomeEnv(env, home);
  if (options.agentDir !== undefined) env.PI_CODING_AGENT_DIR = options.agentDir;
  return env;
}

/**
 * Apply {@link isolatedTestProcessEnv} onto the current process.env.
 * Used by the bare `node --test` preload so daily entries share the same source.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, agentDir?: string }} [options]
 */
export function applyIsolatedTestProcessEnv(options = {}) {
  const next = isolatedTestProcessEnv(options);
  process.env.HOME = next.HOME;
  process.env.XDG_CONFIG_HOME = next.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = next.XDG_DATA_HOME;
  process.env.XDG_CACHE_HOME = next.XDG_CACHE_HOME;

  if (next.AK_ROLE_RUN_DIR === undefined) delete process.env.AK_ROLE_RUN_DIR;
  else process.env.AK_ROLE_RUN_DIR = next.AK_ROLE_RUN_DIR;

  if (next.PI_CODING_AGENT_DIR === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = next.PI_CODING_AGENT_DIR;
  }
}
