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

import { createRecordSession } from "./sitian-record-entry.ts";

export type OpenInProcessAgentSessionOptions = {
  readonly cwd: string;
  /** Required when loading a resource loader / systemPrompt. Callers own scratch lifecycle. */
  readonly agentDir?: string;
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Pre-built manager. When omitted, the shared seam obtains a Sitian SessionManager
   * from cwd/kind/subject/parent identity relations (no destination parameters).
   */
  readonly sessionManager?: SessionManager;
  /** Record kind for the Sitian entry when sessionManager is omitted. */
  readonly kind?: string;
  /** Stable work identity for book-level records which continue across role runs. */
  readonly subject?: string;
  /** Optional parent session — supplies parentSession link / nest principal. */
  readonly parent?: { getSessionFile(): string | undefined };
  readonly systemPrompt?: string;
  readonly customTools?: ToolDefinition[];
  readonly noTools?: "all" | "builtin";
  /** Optional allowlist — omit for unrestricted Pi defaults (ADR 0064). */
  readonly tools?: string[];
};

function resolveSessionManager(options: OpenInProcessAgentSessionOptions): SessionManager {
  if (options.sessionManager !== undefined) return options.sessionManager;
  if (options.kind === undefined) {
    throw new Error("openInProcessAgentSession requires sessionManager or kind");
  }
  return createRecordSession({
    cwd: options.cwd,
    kind: options.kind,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
  });
}

/**
 * Single createAgentSession + Settings construction for all in-process children.
 * Child SessionManager construction for identity-declared records lives here so
 * role modules do not call createRecordSession directly.
 */
export async function openInProcessAgentSession(
  options: OpenInProcessAgentSessionOptions,
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; dispose(): void }> {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sessionManager = resolveSessionManager(options);

  const createArgs: Parameters<typeof createAgentSession>[0] = {
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRuntime: options.modelRuntime,
    sessionManager,
    settingsManager: settings,
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.customTools === undefined ? {} : { customTools: options.customTools }),
  };

  if (options.agentDir !== undefined) {
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    });
    await loader.reload();
    createArgs.agentDir = options.agentDir;
    createArgs.resourceLoader = loader;
  } else if (options.systemPrompt !== undefined) {
    throw new Error("openInProcessAgentSession requires agentDir when systemPrompt is set");
  }

  const { session } = await createAgentSession(createArgs);
  return {
    session,
    dispose() {
      session.dispose();
    },
  };
}
