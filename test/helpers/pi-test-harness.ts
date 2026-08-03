import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { withPrimaryAwareCleanup } from "./primary-aware-cleanup.ts";

import {
  type FauxProviderHandle,
  InMemoryCredentialStore,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

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
  /** Copy live package node_modules for offline prepack/install. Default true. */
  nodeModules?: boolean;
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

  if (options.nodeModules !== false) {
    await cp(
      resolve(packageRoot, "node_modules"),
      resolve(dest, "node_modules"),
      { recursive: true, force: true },
    );
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
  /** Private materialization root used for pack (removed before return). */
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
): Promise<IsolatedPackResult> {
  await mkdir(packDestination, { recursive: true });
  const root = await mkdtemp(resolve(tmpdir(), "ak-pack-mat-"));
  return await withPrimaryAwareCleanup(async () => {
    await materializePackageTree(root, { nodeModules: true });
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDestination], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    const pack = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const entry = pack[0]!;
    return { root, tarball: resolve(packDestination, entry.filename), filename: entry.filename, files: entry.files };
  }, async () => rm(root, { recursive: true, force: true }));
}

export interface ColdInstalledPackage {
  fixture: string;
  pack: IsolatedPackResult;
  installedRoot: string;
  installed(relativePath: string): Promise<any>;
}

/**
 * Pack and install the current package into a private consumer directory.
 * This is test-only lifecycle setup; callers own the installed behavior assertions.
 */
export async function withColdInstalledPackage<T>(
  home: string,
  scenario: (fixture: ColdInstalledPackage) => Promise<T>,
): Promise<T> {
  const fixture = resolve(home, "consumer");
  await mkdir(fixture, { recursive: true });
  const pack = await packIsolatedPackage(home);
  await writeFile(
    resolve(fixture, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@ak/pi-workflow-roles": `file:${pack.tarball}`,
        "@earendil-works/pi-ai": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-ai")}`,
        "@earendil-works/pi-coding-agent": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent")}`,
        typebox: `file:${resolve(packageRoot, "node_modules/typebox")}`,
      },
    }),
  );
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: fixture, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );

  const installedRoot = resolve(fixture, "node_modules/@ak/pi-workflow-roles");
  const installed = (relativePath: string) =>
    import(pathToFileURL(resolve(installedRoot, relativePath)).href);
  return await withPrimaryAwareCleanup(
    () => scenario({ fixture, pack, installedRoot, installed }),
    () => rm(fixture, { recursive: true, force: true }),
  );
}

export interface RawPackageManifest {
  files?: string[];
  bin?: Record<string, string>;
  pi?: { extensions?: string[] };
}

export async function loadRawPackageManifest(): Promise<RawPackageManifest> {
  return JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as RawPackageManifest;
}

export function resolvePackageEntrypoint(manifest: RawPackageManifest): string {
  return resolve(packageRoot, manifest.pi!.extensions![0]!);
}

export async function withHermeticHome<T>(
  options: { prefix?: string },
  scenario: (fixture: { home: string; agentDir: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(
    resolve(tmpdir(), options.prefix ?? "ak-pi-test-"),
  );
  const agentDir = resolve(home, ".pi-agent");
  await mkdir(agentDir, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return await withPrimaryAwareCleanup(
    () => scenario({ home, agentDir }),
    async () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    },
  );
}

export interface PiSubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
  cause?: unknown;
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
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null };
    return {
      code: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
      timedOut: failure.killed === true,
      signal: failure.signal ?? null,
      cause: error,
    };
  }
}

export async function runPiSubprocess(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<PiSubprocessResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(piCli, args, {
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
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr, timedOut, signal });
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
  const sessionManager = SessionManager.inMemory(options.cwd);
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
  return await withPrimaryAwareCleanup(
    async () => {
      for (const [name, value] of Object.entries(options.flags)) {
        session.extensionRunner.setFlagValue(name, value);
      }
      await session.bindExtensions({ mode: options.mode });
      return await scenario({ faux: options.faux, provider, model, modelRuntime, loader, extensions: extensionsResult, session, sessionManager });
    },
    async () => {
      try {
        if (options.reviewerShutdown) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    },
  );
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
