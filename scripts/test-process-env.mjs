/**
 * Build an environment for test-owned processes without inheriting machine
 * role-ledger or Pi-home pointers.
 *
 * Default (#549): HOME + XDG_* point at a per-process temp directory.
 *
 * #685 / owner 2026-09-05 (ticket r10 = 判官 r3 option ②):
 * temps only under system tmpdir; tests/helpers/runners/preloads never delete
 * any directory. #612 no-residue voided on this ticket.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, agentDir?: string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let defaultTestHome;
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
  if (env.PATH === undefined) return;
  const bin = ensureSharedHermesFixtureBin();
  const prior = env.PATH;
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
  if (next.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = next.PI_CODING_AGENT_DIR;
}
