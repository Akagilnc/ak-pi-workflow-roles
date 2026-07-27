import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export const packageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);
export const piCli = resolve(packageRoot, "node_modules/.bin/pi");

export interface RawPackageManifest {
  files?: string[];
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
  try {
    return await scenario({ home, agentDir });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

export async function runPiSubprocess(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(piCli, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
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
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
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
