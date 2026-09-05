import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
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
import {
  assertWritableTestAgentDir,
  realMachineAgentDir,
  realMachineHome,
} from "./test-agent-dir-guard.ts";
import { testTmpdir } from "./worktree-temp.ts";

export { assertWritableTestAgentDir, realMachineAgentDir, realMachineHome };
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  type CredentialStore,
  type FauxProviderHandle,
  fauxProvider,
  InMemoryCredentialStore,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
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

export async function flushEventLoopTurns(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Drain setImmediate turns until `ready()` is true. Uses wall-clock Date.now
 * (not mocked when only setTimeout is mocked) so mock-timer tests can wait for
 * real async entry (compliance child stream, tool execute) without fixed turn guesses.
 */
export async function waitForEventLoopCondition(
  ready: () => boolean,
  options: { label: string; timeoutMs?: number } = { label: "condition" },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `waitForEventLoopCondition timed out after ${timeoutMs}ms waiting for ${options.label}`,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export const packageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

/**
 * Git-visible package inputs eligible for private materialization.
 */
export function trackedPackageInputPaths(): string[] {
  const raw = execFileSync(
    "git",
    ["-C", packageRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "buffer" },
  ).toString("utf8");
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
  const root = await mkdtemp(resolve(testTmpdir(), "ak-pack-mat-"));
  try {
    await materializePackageTree(root, {
      nodeModules: options.nodeModules ?? "symlink",
    });
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", packDestination],
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
    ["-C", packageRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
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

/**
 * Build or reuse one isolated pack for the current construction HEAD.
 * Cross-process safe via a fingerprint-keyed cache under worktree .test-tmp (#685).
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
        await materializePackageTree(materialRoot, { nodeModules: "symlink" });
        const { stdout } = await execFileAsync(
          "npm",
          ["pack", "--json", "--pack-destination", packDestination],
          { cwd: materialRoot, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false" } },
        );
        const jsonStart = stdout.indexOf("[");
        if (jsonStart < 0) throw new Error(`npm pack did not emit JSON: ${stdout}`);
        const pack = JSON.parse(stdout.slice(jsonStart)) as Array<{
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
    // #685: hermetic home under worktree .test-tmp so exit cleanup is lawful.
    const home = await mkdtemp(
      resolve(testTmpdir(), options.prefix ?? "ak-pi-test-"),
    );
    const agentDir = resolve(home, ".pi-agent");
    await mkdir(agentDir, { recursive: true });
    const previousHome = process.env.HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousOffline = process.env.PI_OFFLINE;
    const previousRunDir = process.env.AK_ROLE_RUN_DIR;
    process.env.HOME = home;
    // Pin host-Pi surfaces so in-process children do not inherit machine agent
    // dir, ambient run bindings, or online catalog refresh (CI strips these via
    // isolatedTestProcessEnv; local shells often leak PI_CODING_AGENT_DIR/auth).
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
    delete process.env.AK_ROLE_RUN_DIR;
    try {
      return await scenario({ home, agentDir });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previousRunDir;
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

/**
 * #604: temporary package home whose run/session paths sit under `.ak-roles/`
 * so path-derive never falls through to the real machine home. Prefer this over
 * bare mkdtemp run dirs whenever archivist/sitian/ledger may resolve from session.
 */
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
  const home = mkdtempSync(join(testTmpdir(), input.prefix));
  const bookKey = basename(home);
  const ledgerHome = machineLedgerHome(home);
  const runDirectory = join(
    ledgerHome,
    "books",
    bookKey,
    "runs",
    input.runName ?? "test-run",
  );
  const sessionDirectory = join(runDirectory, "session");
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionFile = join(sessionDirectory, "session.jsonl");
  return {
    home,
    bookKey,
    ledgerHome,
    runDirectory,
    sessionDirectory,
    sessionFile,
    dispose() {
      rmSync(home, { recursive: true, force: true });
    },
  };
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
  /** Required hermetic home — no ambient/real HOME fallback. */
  home: string;
  bookKey?: string;
  sessionDir?: string;
  sessionFile?: string | null;
  abort?: () => void;
}): ExtensionContext {
  // Explicit home only — never silently fall back to ambient/real HOME
  // (2026-08-29 faux-leak: missing test HOME → real ~/.pi/agent poison).
  const home = input.home;
  if (typeof home !== "string" || home.length === 0) {
    throw new Error("activationExtensionContext requires explicit home");
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
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
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



export interface MockProviderServerObservers {
  /** Observe the model id each child stream request carries (model.id round-trips
   * in the OpenAI-completions body). Lets tests assert which model the real child
   * resolved from its seat selection through the actual provider entry. */
  onModel?: (modelId: string, body: Record<string, unknown>) => void;
  /** Observe each inbound child HTTP request. Headers prove models.json auth was consumed. */
  onRequest?: (request: { headers: IncomingHttpHeaders }) => void;
  /** Observe the real listener so lifecycle tests can assert its externally visible state. */
  onServer?: (server: Server) => void;
}

export async function createMockProviderServer(
  faux: ReturnType<typeof fauxProvider>,
  observers: MockProviderServerObservers = {},
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      // Prevent keep-alive sockets from holding the test process ~10s after close.
      res.setHeader("Connection", "close");
      observers.onRequest?.({ headers: req.headers });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (typeof body?.model === "string") observers.onModel?.(body.model, body);
      const tools = (body.tools ?? []).map((tool: any) => ({
        name: tool.function?.name ?? tool.name,
        description: tool.function?.description ?? tool.description,
        parameters: tool.function?.parameters ?? tool.parameters,
      }));
      const systemMessage = (body.messages ?? []).find((m: any) => m.role === "system");
      const systemPrompt = body.system ?? (typeof systemMessage?.content === "string" ? systemMessage.content : undefined);
      const messages = (body.messages ?? [])
        .map((m: any) => {
          if (m.role === "system") return undefined;
          if (m.role === "tool") {
            const isError = typeof m.content === "string"
              ? /^Tool\s+.+ not found$|^Error:/.test(m.content.trim())
              : false;
            let toolName = m.name ?? "";
            if (!toolName && typeof m.content === "string") {
              const match = /^Tool\s+(.+)\s+not found$/i.exec(m.content.trim());
              if (match) toolName = match[1];
            }
            return {
              role: "toolResult",
              toolCallId: m.tool_call_id,
              toolName,
              content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [],
              isError,
            };
          }
          if (m.role === "assistant") {
            const content: any[] = [];
            if (typeof m.content === "string" && m.content.length > 0) {
              content.push({ type: "text", text: m.content });
            }
            if (Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) {
                let parsedArgs = tc.function?.arguments;
                if (typeof parsedArgs === "string") {
                  try { parsedArgs = JSON.parse(parsedArgs); } catch {}
                }
                content.push({
                  type: "toolCall",
                  id: tc.id,
                  name: tc.function?.name ?? tc.name,
                  arguments: parsedArgs ?? {},
                });
              }
            }
            return {
              role: "assistant",
              content,
              api: "faux",
              provider: "faux",
              model: faux.getModel().id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: m.tool_calls?.length ? "toolUse" : "stop",
              timestamp: Date.now(),
            };
          }
          return {
            role: m.role ?? "user",
            content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [],
            timestamp: Date.now(),
          };
        })
        .filter(Boolean);

      const stream = faux.provider.stream(faux.getModel(), {
        messages: messages as any,
        ...(tools.length > 0 ? { tools } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
      });
      const message = await stream.result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        if (message.errorMessage?.includes("Cannot read properties of undefined (reading 'length')")) {
          const payload = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: 1,
            model: faux.getModel().id,
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "ak_undefined_decision",
                    arguments: "{}",
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          };
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
          res.end();
          return;
        }
        // Surface provider failures as an HTTP error so the real adapter's
        // stream path records a transport failure (streamFailure) instead of a
        // flattened normal completion — preserving typed transport_failure
        // classification through the OpenAI-completions round-trip.
        // When the scripted assistant message holds a direct statusCode/status,
        // mirror it as the HTTP status so auth/quota classification stays typed
        // through institutional open (host-neutral navigator/auditor children).
        const messageRecord = message as unknown as {
          statusCode?: unknown;
          status?: unknown;
          body?: unknown;
          code?: unknown;
          errno?: unknown;
        };
        const heldStatus = typeof messageRecord.statusCode === "number"
          ? messageRecord.statusCode
          : typeof messageRecord.status === "number"
            ? messageRecord.status
            : undefined;
        // Only a scripted HTTP status becomes a structured Response. Defaulting
        // unstructured error-stop to synthetic 500 would wash local/unrecognized
        // failures as provider 5xx testimony (失败诚实).
        if (heldStatus !== undefined && heldStatus >= 400 && heldStatus < 600) {
          res.writeHead(heldStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({
            error: { message: message.errorMessage ?? message.stopReason },
            ...(messageRecord.body === undefined ? {} : { body: messageRecord.body }),
            ...(messageRecord.code === undefined ? {} : { code: messageRecord.code }),
            ...(messageRecord.errno === undefined ? {} : { errno: messageRecord.errno }),
          }));
          return;
        }
        // 2xx SSE with an error object: SDK folds the original message into
        // error-stop without a non-success HTTP status (no synthetic 5xx testimony).
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({
          error: { message: message.errorMessage ?? message.stopReason },
        })}\n\ndata: [DONE]\n\n`);
        res.end();
        return;
      }
      const toolCalls = message.content
        .filter((p: { type: string }) => p.type === "toolCall")
        .map((p: { type: string; id?: string; name?: string; arguments?: unknown }, index: number) => ({
          index,
          id: p.id,
          type: "function",
          function: {
            name: p.name,
            arguments: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {}),
          },
        }));
      const text = message.content
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { type: string; text?: string }) => p.text)
        .join("");

      const payload = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: 1,
        model: faux.getModel().id,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            ...(text.length > 0 ? { content: text } : {}),
          },
          finish_reason: null,
        }],
      };
      // OpenAI-completions emits usage on the terminal chunk (include_usage).
      // Preserve the faux provider's typed usage so the adapter's parseChunkUsage
      // round-trips real per-turn usage back to consumers (distinct-turn proofs).
      const messageUsage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
      const usageChunk = messageUsage === undefined ? {} : {
        prompt_tokens: (messageUsage.input ?? 0) + (messageUsage.cacheRead ?? 0) + (messageUsage.cacheWrite ?? 0),
        completion_tokens: messageUsage.output ?? 0,
        prompt_tokens_details: {
          cached_tokens: messageUsage.cacheRead ?? 0,
          cache_write_tokens: messageUsage.cacheWrite ?? 0,
        },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write(`data: ${JSON.stringify({
        ...payload,
        choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
        ...(Object.keys(usageChunk).length > 0 ? { usage: usageChunk } : {}),
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  // Node defaults keep-alive ~5–10s; force immediate idle close so fixture teardown
  // does not leave sockets holding the test process after closeAllConnections.
  server.keepAliveTimeout = 1;
  server.headersTimeout = 2;
  observers.onServer?.(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    server,
    baseUrl,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}


/**
 * Seed the child institutional sub-session's provider from a faux provider over
 * the real OpenAI-completions HTTP path. `openPiInstitutionalSession` builds its
 * own child ModelRuntime that reads `<PI_CODING_AGENT_DIR>/models.json`, so tests
 * that drive `executeAuditorChild`/`runGatekeeper`/`runComplianceAudit` directly
 * (without `withInProcessPi`) must register the faux provider there. Starts a
 * mock SSE server backed by `faux`, writes the model registration, runs `run`,
 * then tears both down.
 */
export async function withInstitutionalProviderFixture<T>(
  faux: ReturnType<typeof fauxProvider>,
  run: () => Promise<T>,
): Promise<T> {
  const mock = await createMockProviderServer(faux);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempAgentDir = await mkdtemp(join(testTmpdir(), "ak-institutional-agent-"));
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  try {
    const modelsPath = resolve(tempAgentDir, "models.json");
    const model = faux.getModel() as {
      id: string;
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string>;
    };
    await writeFile(modelsPath, JSON.stringify({
      providers: {
        [faux.provider.id]: {
          baseUrl: mock.baseUrl,
          api: "openai-completions",
          apiKey: "test",
          models: [{
            id: model.id,
            name: model.id,
            api: "openai-completions",
            // Preserve faux model reasoning / thinking map so institutional
            // children honor Navigator :max the same way the parent session does.
            reasoning: model.reasoning === true,
            ...(model.thinkingLevelMap === undefined
              ? {}
              : { thinkingLevelMap: model.thinkingLevelMap }),
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
            compat: { requiresToolResultName: true },
          }],
        },
      },
    }, null, 2), "utf8");
    return await run();
  } finally {
    await mock.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tempAgentDir, { recursive: true, force: true });
  }
}

/**
 * Seed agentDir/models.json from a faux provider over the real OpenAI-completions
 * HTTP path. Institutional children (gatekeeper/auditor/evidence) resolve auth
 * from PI_CODING_AGENT_DIR/models.json after #518 S3 child-local ModelRuntime —
 * pi.registerProvider alone is not visible to the child. Returns a closer for
 * the mock server; callers must close (session_shutdown / finally).
 */
export async function seedAgentDirModelsJsonFromFaux(
  faux: ReturnType<typeof fauxProvider>,
  agentDir: string | undefined | null,
  options?: { providerId?: string; observers?: MockProviderServerObservers },
): Promise<{ close: () => Promise<void>; baseUrl: string }> {
  assertWritableTestAgentDir(agentDir);
  const mock = await createMockProviderServer(faux, options?.observers ?? {});
  try {
    const providerId = options?.providerId ?? faux.provider.id;
    const modelsPath = resolve(agentDir, "models.json");
    let existing: { providers?: Record<string, unknown> } = {};
    try {
      existing = JSON.parse(await readFile(modelsPath, "utf8")) as typeof existing;
    } catch (error) {
      // Only missing file is "fresh"; permission/I/O/parse errors keep their cause.
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw error;
    }
    await writeFile(
      modelsPath,
      JSON.stringify(
        {
          providers: {
            ...(existing.providers ?? {}),
            [providerId]: {
              baseUrl: mock.baseUrl,
              api: "openai-completions",
              apiKey: "test",
              models: (() => {
                const model = faux.getModel() as {
                  id: string;
                  reasoning?: boolean;
                  thinkingLevelMap?: Record<string, string>;
                };
                return [{
                  id: model.id,
                  name: model.id,
                  api: "openai-completions",
                  // Preserve faux model reasoning / thinking map so institutional
                  // children honor Navigator :max the same way the parent session does.
                  reasoning: model.reasoning === true,
                  ...(model.thinkingLevelMap === undefined
                    ? {}
                    : { thinkingLevelMap: model.thinkingLevelMap }),
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 16384,
                  compat: { requiresToolResultName: true },
                }];
              })(),
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    return { close: mock.close, baseUrl: mock.baseUrl };
  } catch (error) {
    await mock.close();
    throw error;
  }
}

export async function withAgentDirProviderFixture<T>(
  faux: ReturnType<typeof fauxProvider>,
  agentDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
  try {
    return await run();
  } finally {
    await seeded.close();
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
