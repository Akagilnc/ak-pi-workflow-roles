/**
 * Build an environment for test-owned processes without inheriting machine
 * role-ledger or Pi-home pointers. Right-hand masks survive downstream env
 * remerges; Node spawn omits undefined values.
 *
 * Default (#549): HOME + XDG_* point at a per-process temp directory so
 * fixtures that resolve through $HOME cannot touch the host ~/.pi tree.
 * Explicit options.home wins over that default.
 *
 * #612 / owner 2026-09-05: the default home is process-owned under tmpdir and
 * left for OS cleanup (tests/fixtures must not delete directories). Callers that
 * pass options.home own that path themselves.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, agentDir?: string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Per-process default temp HOME for this test run (Scope 1). Not exported. */
let defaultTestHome;
/** Process-owned PATH bin with default hermes stub (#635 seat ticket resolution). */
let sharedHermesBinDir;

function defaultIsolatedTestHome() {
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

/**
 * Default hermes stub matching installHermesFixture resolver default
 * (`{"assertion":"true-unbound"}`). Seat self-ticket (#635) makes hermes a
 * four-seat runtime dependency; CI/Pi-only dispatch surfaces get this stub on
 * PATH once per process. Tests that need a different face still prepend their
 * own installHermesFixture bin ahead of this entry.
 */
function ensureSharedHermesFixtureBin() {
  if (sharedHermesBinDir !== undefined) return sharedHermesBinDir;
  const home = defaultIsolatedTestHome();
  sharedHermesBinDir = join(home, ".ak-test-path-bin");
  mkdirSync(sharedHermesBinDir, { recursive: true });
  const hermesPath = join(sharedHermesBinDir, "hermes");
  writeFileSync(
    hermesPath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ assertion: "true-unbound" }));
process.exit(0);
`,
    "utf8",
  );
  chmodSync(hermesPath, 0o755);
  return sharedHermesBinDir;
}

function withSharedHermesOnPath(env) {
  // PATH omitted → leave omitted so spawn keeps Node platform-default lookup
  // (explicit-internal PI_BINARY=bash case). Only decorate an already-present PATH.
  if (env.PATH === undefined) return;
  const bin = ensureSharedHermesFixtureBin();
  const prior = env.PATH;
  // Keep an existing leading installHermesFixture bin ahead of the shared stub.
  if (prior.split(delimiter).includes(bin)) return;
  env.PATH = prior.length > 0 ? `${bin}${delimiter}${prior}` : bin;
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
  withSharedHermesOnPath(env);
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
  if (next.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = next.PATH;

  if (next.AK_ROLE_RUN_DIR === undefined) delete process.env.AK_ROLE_RUN_DIR;
  else process.env.AK_ROLE_RUN_DIR = next.AK_ROLE_RUN_DIR;

  if (next.PI_CODING_AGENT_DIR === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = next.PI_CODING_AGENT_DIR;
  }
}
