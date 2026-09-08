/**
 * #549 HOME redirect + #685 worktree-internal default home with exit cleanup.
 * Owner 2026-09-06: may only delete inside this worktree; default home is a
 * self-owned sibling root under the worktree (no shared .test-tmp parent);
 * #612: process exit removes the default home so the worktree returns to pre-run state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let defaultTestHome;
let defaultTestHomeCleanupRegistered = false;

function registerDefaultTestHomeCleanup() {
  if (defaultTestHomeCleanupRegistered) return;
  defaultTestHomeCleanupRegistered = true;
  // #612 / failure-honesty: cleanup failure must not exit green. exit listeners
  // cannot block termination; mark a non-zero exitCode and land the cause on stderr.
  process.on("exit", () => {
    if (defaultTestHome === undefined) return;
    try {
      rmSync(defaultTestHome, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      try {
        process.stderr.write(
          `[test-process-env] failed to remove default test home ${defaultTestHome}: ${detail}\n`,
        );
      } catch {
        // stderr may already be closed during process teardown
      }
      if (typeof process.exitCode !== "number" || process.exitCode === 0) {
        process.exitCode = 1;
      }
    }
  });
}

function defaultIsolatedTestHome() {
  if (defaultTestHome === undefined) {
    // Self-owned sibling root — no shared parent other processes try to rmdir.
    defaultTestHome = mkdtempSync(join(PACKAGE_ROOT, ".test-tmp-ak-roles-test-home-"));
    registerDefaultTestHomeCleanup();
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
  const home = options.home !== undefined ? options.home : defaultIsolatedTestHome();
  redirectHomeEnv(env, home);
  if (options.agentDir !== undefined) env.PI_CODING_AGENT_DIR = options.agentDir;
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
