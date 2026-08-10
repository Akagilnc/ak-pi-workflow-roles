/**
 * Thin shared in-process AgentSession open (#233).
 * Static Pi imports are safe for Navigator (same module instance as ModelRuntime).
 * Auditor/evidence callers must dynamic-import this module so public-cli bundling
 * does not statically reach @earendil-works/pi-coding-agent.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type ModelRuntime,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export type OpenInProcessAgentSessionOptions = {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly sessionManager: SessionManager;
  readonly systemPrompt?: string;
  readonly customTools?: ToolDefinition[];
  readonly noTools?: "all" | "builtin";
  /** Optional allowlist — omit for unrestricted Pi defaults (ADR 0064). */
  readonly tools?: string[];
  readonly settings?: { compaction?: { enabled: boolean }; retry?: { enabled: boolean } };
};

/**
 * Single createAgentSession + Settings construction for all in-process children.
 */
export async function openInProcessAgentSession(
  options: OpenInProcessAgentSessionOptions,
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; dispose(): void }> {
  const settings = SettingsManager.inMemory(
    options.settings ?? { compaction: { enabled: false }, retry: { enabled: false } },
  );

  const createArgs: Parameters<typeof createAgentSession>[0] = {
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRuntime: options.modelRuntime,
    sessionManager: options.sessionManager,
    settingsManager: settings,
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.customTools === undefined ? {} : { customTools: options.customTools }),
  };

  if (options.agentDir !== undefined || options.systemPrompt !== undefined) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const agentDir = options.agentDir ?? (await mkdtemp(join(tmpdir(), "ak-in-process-child-")));
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    });
    await loader.reload();
    createArgs.agentDir = agentDir;
    createArgs.resourceLoader = loader;
  }

  const { session } = await createAgentSession(createArgs);
  return {
    session,
    dispose() {
      session.dispose();
    },
  };
}
