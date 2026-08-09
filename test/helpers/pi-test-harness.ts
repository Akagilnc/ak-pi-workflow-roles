import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  type FauxProviderHandle,
  InMemoryCredentialStore,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  activationWaitingLedgerPath,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  type AcceptedActivationFact,
} from "../../src/activation-ledger.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE as PACKAGE_INTERNAL_ROLE_ENTRYPOINT } from "../../src/public-cli/registry.ts";

const execFileAsync = promisify(execFile);

export const packageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);
export const piCli = resolve(packageRoot, "node_modules/.bin/pi");

/**
 * Tracked package inputs eligible for private materialization.
 */
export function trackedPackageInputPaths(): string[] {
  const raw = execFileSync("git", ["-C", packageRoot, "ls-files", "-z"], {
    encoding: "buffer",
  }).toString("utf8");
  return raw
    .split("\0")
    .filter(Boolean);
}

export interface MaterializePackageOptions {
  /**
   * Provide package node_modules for offline prepack/install.
   * Default "symlink" (cheap). "copy" keeps the historical full tree copy.
   * false skips node_modules entirely.
   */
  nodeModules?: boolean | "symlink" | "copy";
  /** Initialize a git repo and commit the seeded tree. Default false. */
  gitSeed?: boolean;
}

/**
 * Copy tracked package inputs into an isolated directory so lifecycle scripts
 * (prepack/build) cannot rewrite the shared repository tree.
 */
export async function materializePackageTree(
  dest: string,
  options: MaterializePackageOptions = {},
): Promise<void> {
  const paths = trackedPackageInputPaths();
  await mkdir(dest, { recursive: true });

  for (const rel of paths) {
    const src = resolve(packageRoot, rel);
    if (!existsSync(src)) continue;
    const dst = resolve(dest, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }

  const nodeModulesMode = options.nodeModules === undefined
    ? "symlink"
    : options.nodeModules === true
    ? "symlink"
    : options.nodeModules === false
    ? false
    : options.nodeModules;

  if (nodeModulesMode === "copy") {
    await cp(
      resolve(packageRoot, "node_modules"),
      resolve(dest, "node_modules"),
      { recursive: true, force: true },
    );
  } else if (nodeModulesMode === "symlink") {
    const target = resolve(dest, "node_modules");
    if (!existsSync(target)) {
      await symlink(resolve(packageRoot, "node_modules"), target, "dir");
    }
  }

  if (options.gitSeed) {
    execFileSync("git", ["init", "-b", "main"], { cwd: dest });
    execFileSync("git", ["config", "user.email", "lifecycle@test.local"], {
      cwd: dest,
    });
    execFileSync("git", ["config", "user.name", "Lifecycle Test"], {
      cwd: dest,
    });
    execFileSync("git", ["add", "-A"], { cwd: dest });
    execFileSync("git", ["commit", "-m", "seed clean package checkout"], {
      cwd: dest,
    });
  }
}

export interface IsolatedPackResult {
  /**
   * Private materialization root used for pack.
   * Ephemeral packs remove this before return; shared packs keep a durable cache root.
   */
  root: string;
  /** Absolute path to the packed tarball under packDestination. */
  tarball: string;
  filename: string;
  files: Array<{ path: string }>;
}

/**
 * Materialize a private package tree and run real `npm pack` there so the
 * prepack → retained package build cannot rewrite shared dist/.
 */
export async function packIsolatedPackage(
  packDestination: string,
  options: { nodeModules?: MaterializePackageOptions["nodeModules"] } = {},
): Promise<IsolatedPackResult> {
  await mkdir(packDestination, { recursive: true });
  const root = await mkdtemp(resolve(tmpdir(), "ak-pack-mat-"));
  try {
    await materializePackageTree(root, {
      nodeModules: options.nodeModules ?? "symlink",
    });
    await execFileAsync("pnpm", ["run", "build"], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDestination],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    const pack = JSON.parse(stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const entry = pack[0]!;
    return {
      root,
      tarball: resolve(packDestination, entry.filename),
      filename: entry.filename,
      files: entry.files,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface ConstructionProvenance {
  /** `git rev-parse HEAD` at fixture build time. */
  head: string;
  /** Fingerprint of HEAD + worktree dirty paths + content hashes of dirty paths. */
  fingerprint: string;
  builtAt: string;
}

/**
 * Provenance for the current construction HEAD. Dirty worktrees hash dirty
 * file contents so the shared fixture never reuses a stale artifact.
 */
export function constructionProvenance(): ConstructionProvenance {
  const head = execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["-C", packageRoot, "status", "--porcelain=v1", "-z"],
    { encoding: "buffer" },
  ).toString("utf8");
  const hash = createHash("sha256").update(head).update("\0");
  if (status.length > 0) {
    hash.update(status);
    for (const entry of status.split("\0")) {
      if (!entry) continue;
      // porcelain -z: XY SPACE path, or rename "R  old\0new"
      const pathPart = entry.slice(3);
      if (!pathPart) continue;
      const abs = resolve(packageRoot, pathPart);
      if (!existsSync(abs)) {
        hash.update("missing:").update(pathPart);
        continue;
      }
      try {
        hash.update(pathPart).update("\0");
        hash.update(execFileSync("git", ["-C", packageRoot, "hash-object", abs]));
      } catch {
        hash.update("unreadable:").update(pathPart);
      }
    }
  }
  return {
    head,
    fingerprint: hash.digest("hex").slice(0, 24),
    builtAt: new Date().toISOString(),
  };
}

export interface SharedPackFixture extends IsolatedPackResult {
  provenance: ConstructionProvenance;
  cacheDir: string;
}

export interface SharedColdInstallFixture extends ColdInstalledPackage {
  provenance: ConstructionProvenance;
  cacheDir: string;
}

const FIXTURE_CACHE_ROOT = resolve(
  tmpdir(),
  "ak-pi-workflow-roles-cold-fixtures",
);

async function acquireDirLock(lockDir: string, timeoutMs = 300_000): Promise<() => Promise<void>> {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for fixture lock at ${lockDir}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
}

async function waitForReady(
  readyPath: string,
  lockDir: string,
  timeoutMs = 300_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (existsSync(readyPath)) return true;
    if (!existsSync(lockDir)) {
      // Builder crashed without ready marker — caller may rebuild.
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for fixture readiness at ${readyPath}`);
}

let sharedPackMemo: Promise<SharedPackFixture> | undefined;
let sharedColdInstallMemo: Promise<SharedColdInstallFixture> | undefined;

/**
 * Build or reuse one isolated pack for the current construction HEAD.
 * Cross-process safe via a fingerprint-keyed cache under os.tmpdir().
 */
export async function getSharedIsolatedPack(): Promise<SharedPackFixture> {
  sharedPackMemo ??= (async () => {
    const provenance = constructionProvenance();
    const cacheDir = resolve(FIXTURE_CACHE_ROOT, provenance.fingerprint, "pack");
    const readyPath = resolve(cacheDir, "ready.json");
    const metaPath = resolve(cacheDir, "meta.json");
    const lockDir = resolve(cacheDir, ".lock");

    await mkdir(cacheDir, { recursive: true });

    const loadReady = async (): Promise<SharedPackFixture | undefined> => {
      if (!existsSync(readyPath) || !existsSync(metaPath)) return undefined;
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
        filename: string;
        files: Array<{ path: string }>;
        provenance: ConstructionProvenance;
      };
      const tarball = resolve(cacheDir, meta.filename);
      if (!existsSync(tarball)) return undefined;
      return {
        root: cacheDir,
        tarball,
        filename: meta.filename,
        files: meta.files,
        provenance: meta.provenance,
        cacheDir,
      };
    };

    const existing = await loadReady();
    if (existing) return existing;

    if (await waitForReady(readyPath, lockDir)) {
      const ready = await loadReady();
      if (ready) return ready;
    }

    const release = await acquireDirLock(lockDir);
    try {
      const raced = await loadReady();
      if (raced) return raced;

      const packDestination = cacheDir;
      const materialRoot = await mkdtemp(resolve(cacheDir, "mat-"));
      try {
        await materializePackageTree(materialRoot, { nodeModules: "copy" });
        const modulesState = JSON.parse(
          readFileSync(resolve(packageRoot, "node_modules/.modules.yaml"), "utf8"),
        ) as { storeDir: string };
        const commandEnv = {
          ...process.env,
          CI: "true",
          npm_config_store_dir: modulesState.storeDir,
        };
        await execFileAsync("pnpm", ["run", "build"], {
          cwd: materialRoot,
          env: commandEnv,
          maxBuffer: 10 * 1024 * 1024,
        });
        const { stdout } = await execFileAsync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", packDestination],
          {
            cwd: materialRoot,
            env: commandEnv,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        const pack = JSON.parse(stdout) as Array<{
          filename: string;
          files: Array<{ path: string }>;
        }>;
        const entry = pack[0]!;
        const builtProvenance = constructionProvenance();
        await writeFile(
          metaPath,
          JSON.stringify(
            {
              filename: entry.filename,
              files: entry.files,
              provenance: builtProvenance,
            },
            null,
            2,
          ),
        );
        await writeFile(
          readyPath,
          JSON.stringify(
            {
              head: builtProvenance.head,
              fingerprint: builtProvenance.fingerprint,
              builtAt: builtProvenance.builtAt,
            },
            null,
            2,
          ),
        );
        return {
          root: cacheDir,
          tarball: resolve(cacheDir, entry.filename),
          filename: entry.filename,
          files: entry.files,
          provenance: builtProvenance,
          cacheDir,
        };
      } finally {
        await rm(materialRoot, { recursive: true, force: true });
      }
    } finally {
      await release();
    }
  })();
  return sharedPackMemo;
}

function coldInstallDependencySpec(tarball: string): Record<string, string> {
  return {
    "@akagilnc/pi-workflow-roles": `file:${tarball}`,
    "@earendil-works/pi-ai": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-ai")}`,
    "@earendil-works/pi-coding-agent": `file:${
      resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent")
    }`,
    typebox: `file:${resolve(packageRoot, "node_modules/typebox")}`,
  };
}

/**
 * Build or reuse one cold-installed consumer tree for the current HEAD.
 * Cross-process safe; tests should clone via withColdInstalledPackage / cloneSharedColdInstall.
 */
export async function getSharedColdInstalledPackage(): Promise<SharedColdInstallFixture> {
  sharedColdInstallMemo ??= (async () => {
    const pack = await getSharedIsolatedPack();
    const cacheDir = resolve(
      FIXTURE_CACHE_ROOT,
      pack.provenance.fingerprint,
      "cold-install",
    );
    const readyPath = resolve(cacheDir, "ready.json");
    const lockDir = resolve(cacheDir, ".lock");
    const fixture = resolve(cacheDir, "consumer");
    const installedRoot = resolve(
      fixture,
      "node_modules/@akagilnc/pi-workflow-roles",
    );

    await mkdir(cacheDir, { recursive: true });

    const loadReady = async (): Promise<SharedColdInstallFixture | undefined> => {
      if (!existsSync(readyPath) || !existsSync(installedRoot)) return undefined;
      const ready = JSON.parse(await readFile(readyPath, "utf8")) as {
        provenance: ConstructionProvenance;
      };
      const installed = (relativePath: string) =>
        import(pathToFileURL(resolve(installedRoot, relativePath)).href);
      return {
        fixture,
        pack,
        installedRoot,
        installed,
        provenance: ready.provenance,
        cacheDir,
      };
    };

    const existing = await loadReady();
    if (existing) return existing;

    if (await waitForReady(readyPath, lockDir)) {
      const ready = await loadReady();
      if (ready) return ready;
    }

    const release = await acquireDirLock(lockDir);
    try {
      const raced = await loadReady();
      if (raced) return raced;

      await rm(fixture, { recursive: true, force: true });
      await mkdir(fixture, { recursive: true });
      await writeFile(
        resolve(fixture, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: coldInstallDependencySpec(pack.tarball),
        }),
      );
      await execFileAsync(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: fixture, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      );

      const builtProvenance = pack.provenance;
      await writeFile(
        readyPath,
        JSON.stringify(
          {
            head: builtProvenance.head,
            fingerprint: builtProvenance.fingerprint,
            builtAt: new Date().toISOString(),
            provenance: builtProvenance,
            tarball: pack.tarball,
          },
          null,
          2,
        ),
      );

      const installed = (relativePath: string) =>
        import(pathToFileURL(resolve(installedRoot, relativePath)).href);
      return {
        fixture,
        pack,
        installedRoot,
        installed,
        provenance: builtProvenance,
        cacheDir,
      };
    } finally {
      await release();
    }
  })();
  return sharedColdInstallMemo;
}

/**
 * Clone the shared cold-install tree into dest so each test owns a private
 * consumer workspace (and a writable installed package copy).
 */
export async function cloneSharedColdInstall(
  dest: string,
): Promise<ColdInstalledPackage> {
  const shared = await getSharedColdInstalledPackage();
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(shared.fixture, dest, { recursive: true, force: true });
  const installedRoot = resolve(dest, "node_modules/@akagilnc/pi-workflow-roles");
  const installed = (relativePath: string) =>
    import(pathToFileURL(resolve(installedRoot, relativePath)).href);
  return {
    fixture: dest,
    pack: shared.pack,
    installedRoot,
    installed,
  };
}

export interface ColdInstalledPackage {
  fixture: string;
  pack: IsolatedPackResult;
  installedRoot: string;
  installed(relativePath: string): Promise<any>;
}

/**
 * Pack and install the current package into a private consumer directory.
 * Uses the shared HEAD-keyed cold-install fixture and clones it under home.
 */
export async function withColdInstalledPackage<T>(
  home: string,
  scenario: (fixture: ColdInstalledPackage) => Promise<T>,
): Promise<T> {
  const fixture = await cloneSharedColdInstall(resolve(home, "consumer"));
  return await scenario(fixture);
}

export interface RawPackageManifest {
  files?: string[];
  bin?: Record<string, string>;
  pi?: { extensions?: string[] };
}

/** Explicit Internal role entrypoint (not auto-registered; ADR 0052 / #105). */
export const INTERNAL_ROLE_ENTRYPOINT_RELATIVE = PACKAGE_INTERNAL_ROLE_ENTRYPOINT;

export async function loadRawPackageManifest(): Promise<RawPackageManifest> {
  return JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as RawPackageManifest;
}

/**
 * Resolve the Internal role entrypoint for explicit `-e` load.
 * Package auto-registration leaves `pi.extensions` empty; callers that need the
 * development seam pass this path themselves (or go through `ak-role`).
 */
export function resolvePackageEntrypoint(_manifest?: RawPackageManifest): string {
  return resolve(packageRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
}

/** Pi-managed private npm root under an isolated agent dir (user scope). */
export function piPrivateNpmRoot(agentDir: string): string {
  return resolve(agentDir, "npm");
}

/** Pi private npm bin directory — where package bins surface after install. */
export function piPrivateNpmBinDir(agentDir: string): string {
  return resolve(piPrivateNpmRoot(agentDir), "node_modules", ".bin");
}

export interface PiManagedInstall {
  agentDir: string;
  npmRoot: string;
  binDir: string;
  installedRoot: string;
  akRoleBin: string;
  pack: IsolatedPackResult;
}

/**
 * Install one packed artifact through Pi's user install owner (`pi install` →
 * PackageManager) so `ak-role` is discovered via Pi's private npm bin (ADR 0052).
 */
export async function installPackedArtifactIntoPiNpm(
  agentDir: string,
  home: string,
): Promise<PiManagedInstall> {
  const pack = await getSharedIsolatedPack();
  const source = `npm:@akagilnc/pi-workflow-roles@file:${pack.tarball}`;
  const result = await runPiSubprocess(["install", source], {
    command: process.env.PI_BINARY ?? "pi",
    cwd: home,
    timeoutMs: 120_000,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
  });
  if (result.timedOut) {
    throw new Error(`pi install timed out for ${source}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `pi install failed (code ${String(result.code)}): ${result.stderr || result.stdout}`,
    );
  }
  const npmRoot = piPrivateNpmRoot(agentDir);
  const installedRoot = resolve(
    npmRoot,
    "node_modules",
    "@akagilnc",
    "pi-workflow-roles",
  );
  const binDir = piPrivateNpmBinDir(agentDir);
  const akRoleBin = resolve(binDir, "ak-role");
  return {
    agentDir,
    npmRoot,
    binDir,
    installedRoot,
    akRoleBin,
    pack,
  };
}

/**
 * Serialize process-global mutations (HOME, cwd) so hermetic scenarios stay
 * per-invocation even when the test runner overlaps async work.
 * Re-entrant via AsyncLocalStorage so withProcessCwd may nest inside withHermeticHome.
 */
let processGlobalChain: Promise<void> = Promise.resolve();
const holdingProcessGlobal = new AsyncLocalStorage<boolean>();

async function withProcessGlobalLock<T>(scenario: () => Promise<T>): Promise<T> {
  if (holdingProcessGlobal.getStore()) {
    return await scenario();
  }
  let release!: () => void;
  const prior = processGlobalChain;
  processGlobalChain = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
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
  return await withProcessGlobalLock(async () => {
    const home = await mkdtemp(
      resolve(tmpdir(), options.prefix ?? "ak-pi-test-"),
    );
    const agentDir = resolve(home, ".pi-agent");
    await mkdir(agentDir, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      return await scenario({ home, agentDir });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
}

/** Explicit git substrate for activation fixtures (ADR 0048). Not a generic home default. */
export function seedGitRepository(cwd: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
}

/**
 * Opt-in activation-owned hermetic home: hermetic HOME plus explicit git substrate (ADR 0048).
 * Only callers that load the production role extension / exercise activation may use this.
 * Role-less and nonactivation tests keep withHermeticHome without git seed.
 * Fixture path prefixes are synthetic test labels, not retained real-role evidence topology.
 */
export async function withActivationHome<T>(
  options: { prefix?: string },
  scenario: (fixture: { home: string; agentDir: string }) => Promise<T>,
): Promise<T> {
  return withHermeticHome(options, async (fixture) => {
    seedGitRepository(fixture.home);
    return scenario(fixture);
  });
}

/** Sole machine ledger home under a hermetic process home (ADR 0048). */
export function machineLedgerHome(home: string): string {
  return join(home, ".ak-roles");
}

/** Book key for a git cwd whose common-dir host basename is the directory name. */
export function activationBookKeyFor(cwd: string): string {
  return basename(cwd);
}

/**
 * Write a genuine session principal under the machine ledger book (ADR 0048).
 * Tests must not label nonexistent / outside-home paths durable.
 */
export function persistActivationSessionFile(input: {
  home: string;
  bookKey: string;
  name?: string;
  cwd?: string;
}): string {
  const sessionDir = join(
    machineLedgerHome(input.home),
    "books",
    input.bookKey,
    "runs",
    "activation",
    input.name ?? "default",
  );
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "session.jsonl");
  if (!existsSync(sessionFile)) {
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: input.name ?? "activation-session",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: input.cwd ?? input.home,
      })}\n`,
    );
  }
  return sessionFile;
}

/**
 * ExtensionContext that exercises production book-key + durable session-file paths.
 * Default session files are genuinely persisted under the ledger book.
 * Pass `sessionFile: null` only when testing the missing-principal rejection.
 * Pass an explicit `sessionFile` for rejection-class paths (caller owns creation).
 */
export function activationExtensionContext(input: {
  cwd: string;
  mode?: ExtensionContext["mode"];
  home?: string;
  bookKey?: string;
  sessionDir?: string;
  sessionFile?: string | null;
  abort?: () => void;
}): ExtensionContext {
  const home = input.home ?? process.env.HOME;
  if (typeof home !== "string" || home.length === 0) {
    throw new Error("activationExtensionContext requires home or process.env.HOME");
  }
  const bookKey = input.bookKey ?? activationBookKeyFor(input.cwd);
  let sessionFile: string | undefined;
  let sessionDir: string;
  if (input.sessionFile === null) {
    sessionFile = undefined;
    sessionDir = input.sessionDir ?? join(machineLedgerHome(home), "books", bookKey, "runs", "activation", "missing");
  } else if (input.sessionFile !== undefined) {
    sessionFile = input.sessionFile;
    sessionDir = input.sessionDir ?? dirname(sessionFile);
  } else {
    sessionFile = persistActivationSessionFile({
      home,
      bookKey,
      cwd: input.cwd,
      ...(input.sessionDir === undefined ? {} : { name: basename(input.sessionDir) }),
    });
    sessionDir = input.sessionDir ?? dirname(sessionFile);
  }
  return {
    mode: input.mode ?? "print",
    cwd: input.cwd,
    abort: input.abort ?? (() => {}),
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

/** Read accepted-activation facts from the sole machine home for one book. */
export function readAcceptedActivationFacts(home: string, bookKey: string): AcceptedActivationFact[] {
  const path = activationWaitingLedgerPath(machineLedgerHome(home), bookKey);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AcceptedActivationFact);
}

/**
 * Scope process.chdir to one invocation under the same process-global lock
 * used by withHermeticHome, so shared fixtures stay safe under overlap.
 */
export async function withProcessCwd<T>(
  cwd: string,
  scenario: () => Promise<T>,
): Promise<T> {
  return await withProcessGlobalLock(async () => {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return await scenario();
    } finally {
      process.chdir(previous);
    }
  });
}

export interface PiSubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runNodeSubprocess(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<PiSubprocessResult> {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
      timedOut: failure.killed === true || failure.signal === "SIGTERM",
    };
  }
}

export async function runPiSubprocess(
  args: string[],
  options: {
    command?: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<PiSubprocessResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(options.command ?? piCli, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    let timeout: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    child.on("error", (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolveResult({ code, stdout, stderr, timedOut });
    });
  });
}

export interface InProcessPiOptions {
  cwd: string;
  agentDir: string;
  faux: FauxProviderHandle;
  model?: Model<any>;
  provider?: Provider;
  modelsPath?: string | null;
  additionalExtensionPaths?: string[];
  extensionFactories?: InlineExtension[];
  additionalSkillPaths?: string[];
  /** Optional caller-owned persisted SessionManager for same-session assertions. */
  sessionManager?: SessionManager;
  /** When set, forwarded to DefaultResourceLoader; default remains true. */
  noSkills?: boolean;
  /** When set, forwarded to DefaultResourceLoader; default remains true. */
  noContextFiles?: boolean;
  skillsOverride?: ConstructorParameters<typeof DefaultResourceLoader>[0]["skillsOverride"];
  appendSystemPrompt?: string[];
  systemPrompt: string;
  mode: "print" | "tui" | "json";
  flags: Record<string, string>;
  noTools?: "all" | "builtin";
  customTools?: ToolDefinition[];
  noExtensions?: boolean;
  reviewerShutdown?: boolean;
  /**
   * Opt-in at activation-owning tests only: place a durable session file under the
   * machine ledger book (ADR 0048). Requires hermetic HOME and a git cwd. Generic
   * in-process callers must leave this unset so they incur no git discovery or
   * durable-session persistence.
   */
  activationLedgerSession?: boolean;
}

export interface InProcessPiFixture {
  faux: FauxProviderHandle;
  provider: Provider;
  model: Model<any>;
  modelRuntime: ModelRuntime;
  loader: DefaultResourceLoader;
  extensions: Awaited<
    ReturnType<typeof createAgentSession>
  >["extensionsResult"];
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionManager: SessionManager;
}

export async function withInProcessPi<T>(
  options: InProcessPiOptions,
  scenario: (fixture: InProcessPiFixture) => Promise<T>,
): Promise<T> {
  const model = options.model ?? options.faux.getModel();
  const provider = options.provider ?? {
    ...options.faux.provider,
    auth: {
      apiKey: {
        name: "Hermetic test authentication",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
    getModels() {
      return [model];
    },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: options.modelsPath === undefined
      ? resolve(options.agentDir, "models.json")
      : options.modelsPath,
  });
  modelRuntime.registerNativeProvider(provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    ...(options.additionalExtensionPaths === undefined
      ? {}
      : { additionalExtensionPaths: options.additionalExtensionPaths }),
    ...(options.extensionFactories === undefined
      ? {}
      : { extensionFactories: options.extensionFactories }),
    ...(options.additionalSkillPaths === undefined
      ? {}
      : { additionalSkillPaths: options.additionalSkillPaths }),
    ...(options.noExtensions === undefined
      ? {}
      : { noExtensions: options.noExtensions }),
    noSkills: options.noSkills === false || options.noSkills === true
      ? options.noSkills
      : true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: options.noContextFiles === false || options.noContextFiles === true
      ? options.noContextFiles
      : true,
    ...(options.skillsOverride === undefined
      ? {}
      : { skillsOverride: options.skillsOverride }),
    ...(options.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: options.appendSystemPrompt }),
    systemPrompt: options.systemPrompt,
  });
  await loader.reload();
  // Default: plain in-memory session — no git discovery, no durable-session I/O.
  // Activation-owning tests opt in via activationLedgerSession.
  let sessionManager: SessionManager = options.sessionManager ?? SessionManager.inMemory(options.cwd);
  if (options.sessionManager === undefined && options.activationLedgerSession === true) {
    // Keep in-memory session-dir semantics (empty getSessionDir) so Navigator subject
    // derivation from cwd/.ak/work stays intact, while exposing a genuinely persisted
    // session file under the machine ledger book (ADR 0048).
    const memorySession = sessionManager;
    const hermeticHome = process.env.HOME;
    if (typeof hermeticHome !== "string" || hermeticHome.length === 0) {
      throw new Error("withInProcessPi activationLedgerSession requires process.env.HOME");
    }
    if (resolveActivationLedgerHome() !== machineLedgerHome(hermeticHome)) {
      throw new Error("withInProcessPi ledger home does not match hermetic HOME");
    }
    // Opt-in path requires a git cwd; infrastructure and non-git failures propagate.
    const bookKey = resolveBookKeyFromGit(options.cwd);
    const durableSessionFile = persistActivationSessionFile({
      home: hermeticHome,
      bookKey,
      name: "inprocess-pi",
      cwd: options.cwd,
    });
    sessionManager = new Proxy(memorySession, {
      get(target, property, receiver) {
        if (property === "getSessionFile") return () => durableSessionFile;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const { session, extensionsResult } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    ...(options.customTools === undefined
      ? {}
      : { customTools: options.customTools }),
  });
  try {
    for (const [name, value] of Object.entries(options.flags)) {
      session.extensionRunner.setFlagValue(name, value);
    }
    await session.bindExtensions({ mode: options.mode });
    return await scenario({
      faux: options.faux,
      provider,
      model,
      modelRuntime,
      loader,
      extensions: extensionsResult,
      session,
      sessionManager,
    });
  } finally {
    try {
      if (options.reviewerShutdown) {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      }
    } finally {
      session.dispose();
    }
  }
}

export async function writeTestSkill(
  home: string,
  name: "code-review" | "tdd",
): Promise<{ path: string; raw: string }> {
  const skillDirectory = resolve(home, ".agents", "skills", name);
  const skillPath = resolve(skillDirectory, "SKILL.md");
  const raw = [
    "---",
    `name: ${name}`,
    `description: Hermetic ${name} test method`,
    "---",
    "",
    `# Hermetic ${name} method`,
    "",
    "Follow the test fixture's requested method.",
  ].join("\n");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(skillPath, raw);
  return { path: await realpath(skillPath), raw };
}
