import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execa } from "execa";
import { withPrimaryAwareCleanup } from "./primary-aware-cleanup.ts";
export { withPrimaryAwareCleanup } from "./primary-aware-cleanup.ts";

export const packageRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

// Native bound method, not a subprocess wrapper. Callers supply their complete
// environment so deleted parent variables cannot be inherited again.
export const testExeca = execa({
  reject: false,
  forceKillAfterDelay: false,
  extendEnv: false,
});

export function worktreeTempPrefix(label: string): string {
  return join(packageRoot, label.startsWith(".test-tmp-") ? label : `.test-tmp-${label}`);
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
    if (base === packageRoot || base.startsWith(`${packageRoot}/`) || base.startsWith(`${packageRoot}\\`)) continue;
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
    const agentDir = await createAgentDir(home);
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

/** Sole machine ledger home under a hermetic process home (ADR 0048). */
export function machineLedgerHome(home: string): string {
  return join(home, ".ak-roles");
}

/** Package-home ledger topology for callers that need synchronous disposal. */
export function createTempPackageHomeLedger(input: {
  prefix: string;
  runName?: string;
}): {
  home: string;
  bookKey: string;
  ledgerHome: string;
  runDirectory: string;
  sessionDirectory: string;
  sessionFile: string;
  dispose(): void;
} {
  const home = mkdtempSync(worktreeTempPrefix(input.prefix));
  try {
    const bookKey = basename(home);
    const ledgerHome = machineLedgerHome(home);
    const runDirectory = join(ledgerHome, "books", bookKey, "runs", input.runName ?? "test-run");
    const sessionDirectory = join(runDirectory, "session");
    mkdirSync(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, "session.jsonl");
    return {
      home, bookKey, ledgerHome, runDirectory, sessionDirectory, sessionFile,
      dispose() {
        rmSync(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Preserve the setup primary if cleanup also fails.
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Test failed and cleanup failed", { cause: error });
    }
    throw error;
  }
}

/** Git-visible package inputs eligible for private materialization. */
export function trackedPackageInputPaths(): string[] {
  return execFileSync(
    "git", ["-C", packageRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  ).split("\0").filter(Boolean);
}

export interface MaterializePackageOptions {
  /** Default symlink; copy preserves the historical full tree copy. */
  nodeModules?: boolean | "symlink" | "copy";
  /** Initialize a git repo and commit the seeded tree. Default false. */
  gitSeed?: boolean;
}

/** Private checkout: lifecycle scripts must not rewrite the shared worktree. */
export async function materializePackageTree(
  dest: string,
  options: MaterializePackageOptions = {},
): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const rel of trackedPackageInputPaths()) {
    const src = resolve(packageRoot, rel);
    if (!existsSync(src)) continue;
    const dst = resolve(dest, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
  const nodeModulesMode = options.nodeModules === undefined || options.nodeModules === true
    ? "symlink" : options.nodeModules;
  if (nodeModulesMode === "copy") {
    await cp(resolve(packageRoot, "node_modules"), resolve(dest, "node_modules"), { recursive: true, force: true });
  } else if (nodeModulesMode === "symlink") {
    const target = resolve(dest, "node_modules");
    if (!existsSync(target)) await symlink(resolve(packageRoot, "node_modules"), target, "dir");
  }
  if (options.gitSeed) {
    seedGitRepository(dest);
    execFileSync("git", ["config", "user.email", "lifecycle@test.local"], { cwd: dest });
    execFileSync("git", ["config", "user.name", "Lifecycle Test"], { cwd: dest });
    execFileSync("git", ["add", "-A"], { cwd: dest });
    execFileSync("git", ["commit", "-m", "seed clean package checkout"], { cwd: dest });
  }
}

export interface IsolatedPackResult {
  /** Private materialization root, removed before return. */
  root: string;
  /** Absolute path to the packed tarball under the caller-owned destination. */
  tarball: string;
  filename: string;
  files: Array<{ path: string }>;
}

const execFileAsync = promisify(execFile);

/** Real prepack/build in a private checkout, never the shared dist/. */
export async function packIsolatedPackage(
  packDestination: string,
  options: { nodeModules?: MaterializePackageOptions["nodeModules"] } = {},
): Promise<IsolatedPackResult> {
  await mkdir(packDestination, { recursive: true });
  return withTempRoot("ak-pack-mat-", async (root) => {
    await materializePackageTree(root, { nodeModules: options.nodeModules ?? "symlink" });
    const { stdout } = await execFileAsync(
      "npm", ["pack", "--json", "--pack-destination", packDestination],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    const [entry] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    return { root, tarball: resolve(packDestination, entry!.filename), filename: entry!.filename, files: entry!.files };
  });
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

async function createAgentDir(home: string): Promise<string> {
  const path = resolve(home, ".pi-agent");
  await mkdir(path, { recursive: true });
  return path;
}

/** Native test.extend definitions, lazy and test-scoped; no template/copy layer. */
export const environmentFixtures = {
  home: async ({}, use: (home: string) => Promise<void>) => {
    await withTempHome(use);
  },
  agentDir: async ({ home }: { home: string }, use: (path: string) => Promise<void>) => {
    await use(await createAgentDir(home));
  },
  ledgerHome: async ({ home }: { home: string }, use: (path: string) => Promise<void>) => {
    const path = machineLedgerHome(home);
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
