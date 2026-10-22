import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withPrimaryAwareCleanup } from "./primary-aware-cleanup.ts";
export { withPrimaryAwareCleanup } from "./primary-aware-cleanup.ts";

export const worktreePackageRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

export function worktreeTempPrefix(label: string): string {
  return join(worktreePackageRoot, label.startsWith(".test-tmp-") ? label : `.test-tmp-${label}`);
}

function hasNodeModulesInAncestry(start: string): boolean {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "node_modules"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function outsideWorktreeTempPrefix(
  label: string,
  options: { isolateNodeAncestors?: boolean } = {},
): string {
  const bases = [...new Set([tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])])];
  for (const base of bases) {
    if (base === worktreePackageRoot || base.startsWith(`${worktreePackageRoot}/`) || base.startsWith(`${worktreePackageRoot}\\`)) continue;
    if (options.isolateNodeAncestors && hasNodeModulesInAncestry(base)) continue;
    return join(base, label);
  }
  throw new Error(`No outside-worktree temp base available: ${bases.join(", ")}`);
}

/** Callback consumers share the same allocation seam during runner migration. */
export async function withTempRoot<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(worktreeTempPrefix(prefix));
  return withPrimaryAwareCleanup(() => body(root), () => rm(root, { recursive: true, force: true }));
}

export async function withTempHome<T>(
  scenario: (home: string) => Promise<T>,
  options: { prefix?: string } = {},
): Promise<T> {
  return withTempRoot(options.prefix ?? "ak-test-home-", scenario);
}

// Preloads run before a test framework exists. The process owns this fallback;
// per-case callers always pass their own home, including to production APIs.
let defaultTestHome: string | undefined;
function defaultIsolatedTestHome(): string {
  if (defaultTestHome === undefined) {
    defaultTestHome = mkdtempSync(worktreeTempPrefix("ak-roles-test-home-"));
    process.on("exit", () => {
      try {
        rmSync(defaultTestHome!, { recursive: true, force: true });
      } catch (error) {
        console.error("Failed to remove default test home", defaultTestHome, error);
        if (typeof process.exitCode !== "number" || process.exitCode === 0) process.exitCode = 1;
      }
    });
  }
  return defaultTestHome;
}

type ProcessEnvOptions = { env?: NodeJS.ProcessEnv; home?: string; agentDir?: string };
export function isolatedTestProcessEnv(options: ProcessEnvOptions = {}): NodeJS.ProcessEnv {
  const home = options.home ?? defaultIsolatedTestHome();
  return {
    ...(options.env ?? process.env),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    AK_ROLE_RUN_DIR: undefined,
    AK_ROLE_COURT_ATTEMPT: undefined,
    PI_CODING_AGENT_DIR: options.agentDir,
    AK_ROLE_ENGINE: undefined,
    AK_ROLE_RECEIPT_DELIVERY_LIMIT: undefined,
  };
}

export function applyIsolatedTestProcessEnv(options: ProcessEnvOptions = {}): void {
  const next = isolatedTestProcessEnv(options);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PATH", "AK_ROLE_RUN_DIR", "AK_ROLE_COURT_ATTEMPT", "PI_CODING_AGENT_DIR", "AK_ROLE_ENGINE", "AK_ROLE_RECEIPT_DELIVERY_LIMIT"]) {
    if (next[key] === undefined) delete process.env[key];
    else process.env[key] = next[key];
  }
}

const USER_PROFILE_PRELOAD = fileURLToPath(new URL("../../scripts/test-user-profile-preload.cjs", import.meta.url));
export type UnavailableTestUserProfile = { mode: "unavailable"; preloadPath?: string };

/** Encode one NODE_OPTIONS token, including when the preload path has spaces. */
export function withTestUserProfileEnv(
  env: NodeJS.ProcessEnv,
  packageHomeOrOptions: string | UnavailableTestUserProfile,
  preloadPath = USER_PROFILE_PRELOAD,
): NodeJS.ProcessEnv {
  const resolvedPreload = typeof packageHomeOrOptions === "object"
    ? (packageHomeOrOptions.preloadPath ?? USER_PROFILE_PRELOAD) : preloadPath;
  const requireFlag = `--require=${JSON.stringify(resolvedPreload)}`;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  return {
    ...env,
    NODE_OPTIONS: nodeOptions.includes(resolvedPreload) ? nodeOptions
      : nodeOptions.length > 0 ? `${requireFlag} ${nodeOptions}` : requireFlag,
    ...(typeof packageHomeOrOptions === "string"
      ? { AK_TEST_USER_PROFILE_HOME: packageHomeOrOptions }
      : { AK_TEST_USER_PROFILE_MODE: "unavailable" }),
  };
}

// Existing callback consumers can nest cwd changes while holding this lock.
let processGlobalChain: Promise<void> = Promise.resolve();
const holdingProcessGlobal = new AsyncLocalStorage<boolean>();
async function withProcessGlobalLock<T>(scenario: () => Promise<T>): Promise<T> {
  if (holdingProcessGlobal.getStore()) return scenario();
  let release!: () => void;
  const prior = processGlobalChain;
  processGlobalChain = new Promise<void>((resolveLock) => { release = resolveLock; });
  await prior;
  try {
    return await holdingProcessGlobal.run(true, scenario);
  } finally {
    release();
  }
}

export async function withHermeticHome<T>(
  options: { prefix?: string },
  scenario: (fixture: { home: string; agentDir: string }) => Promise<T>,
): Promise<T> {
  return withProcessGlobalLock(() => withTempRoot(options.prefix ?? "ak-pi-test-", async (home) => {
    const agentDir = resolve(home, ".pi-agent");
    await mkdir(agentDir, { recursive: true });
    const previous = { ...process.env };
    applyIsolatedTestProcessEnv({ home, agentDir });
    process.env.PI_OFFLINE = "1";
    return withPrimaryAwareCleanup(() => scenario({ home, agentDir }), async () => {
      for (const key of new Set([...Object.keys(previous), ...Object.keys(process.env)])) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
  }));
}

export function seedGitRepository(cwd: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
}

export async function withActivationHome<T>(
  options: { prefix?: string },
  scenario: (fixture: { home: string; agentDir: string }) => Promise<T>,
): Promise<T> {
  return withHermeticHome(options, async (fixture) => {
    seedGitRepository(fixture.home);
    return scenario(fixture);
  });
}

export async function withProcessCwd<T>(cwd: string, scenario: () => Promise<T>): Promise<T> {
  return withProcessGlobalLock(async () => {
    const previous = process.cwd();
    process.chdir(cwd);
    return withPrimaryAwareCleanup(scenario, async () => { process.chdir(previous); });
  });
}

/** Native test.extend definitions, lazy and test-scoped; no template/copy layer. */
export const environmentFixtures = {
  home: async ({}, use: (home: string) => Promise<void>) => {
    await withTempHome(use);
  },
  agentDir: async ({ home }: { home: string }, use: (path: string) => Promise<void>) => {
    const path = join(home, ".pi-agent");
    await mkdir(path, { recursive: true });
    await use(path);
  },
  ledgerHome: async ({ home }: { home: string }, use: (path: string) => Promise<void>) => {
    const path = join(home, ".ak-roles");
    await mkdir(path, { recursive: true });
    await use(path);
  },
  gitRepo: async ({ home }: { home: string }, use: (path: string) => Promise<void>) => {
    const path = join(home, "repo");
    await mkdir(path);
    seedGitRepository(path);
    await use(path);
  },
};
