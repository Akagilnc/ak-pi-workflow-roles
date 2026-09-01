/**
 * Navigator session contracts — pure types, model setting, failure classification.
 * No lifecycle. Shared by attendance (consumer) and navigator-child-executor (seam).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { HostContext } from "./host-contracts.ts";

export const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare" as const;
export const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max" as const;

export type NavigatorUnavailableKey =
  | "context" | "session" | "model" | "thinking" | "auth" | "quota" | "transport" | "unknown";

export class NavigatorUnavailableError extends Error {
  readonly unavailableSource: NavigatorUnavailableKey;
  readonly unavailableCause: NavigatorUnavailableKey;
  readonly originalCause: unknown;

  constructor(source: NavigatorUnavailableKey, message: string, cause: NavigatorUnavailableKey = source, originalCause?: unknown) {
    super(message);
    this.name = "NavigatorUnavailableError";
    this.unavailableSource = source;
    this.unavailableCause = cause;
    this.originalCause = originalCause;
  }
}

export type NavigatorProviderFailureFact = {
  source: NavigatorUnavailableKey;
  cause: NavigatorUnavailableKey;
};

export function navigatorUnavailableError(
  source: NavigatorUnavailableKey,
  error: unknown,
  cause: NavigatorUnavailableKey = source,
): NavigatorUnavailableError {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof NavigatorUnavailableError
    ? error
    : new NavigatorUnavailableError(source, message, cause, error);
}

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function navigatorProviderFailureFromStatus(status: number | undefined): NavigatorProviderFailureFact | undefined {
  if (status === 401 || status === 403) return { source: "auth", cause: "auth" };
  if (status === 429) return { source: "quota", cause: "quota" };
  return undefined;
}

function navigatorProviderFailureFromCode(code: unknown): NavigatorProviderFailureFact | undefined {
  if (typeof code === "number") return navigatorProviderFailureFromStatus(code);
  if (typeof code !== "string") return undefined;
  if (code === "unauthorized" || code === "authentication_failed") return { source: "auth", cause: "auth" };
  if (code === "insufficient_quota" || code === "quota_exhausted") return { source: "quota", cause: "quota" };
  if (code === "transport_error") return { source: "transport", cause: "transport" };
  return undefined;
}

export function navigatorProviderFailureFromError(error: unknown): NavigatorProviderFailureFact | undefined {
  if (!exactRecord(error)) return undefined;
  const statusCode = typeof error.statusCode === "number"
    ? error.statusCode
    : typeof error.status === "number"
      ? error.status
      : undefined;
  return navigatorProviderFailureFromStatus(statusCode) ?? navigatorProviderFailureFromCode(error.code);
}

export function navigatorProviderFailureFromDiagnostics(diagnostics: unknown): NavigatorProviderFailureFact | undefined {
  if (!Array.isArray(diagnostics)) return undefined;
  for (const diagnostic of diagnostics) {
    if (!exactRecord(diagnostic)) continue;
    if (diagnostic.type === "provider_transport_failure") return { source: "transport", cause: "transport" };
    if (exactRecord(diagnostic.error)) {
      const fromCode = navigatorProviderFailureFromCode(diagnostic.error.code);
      if (fromCode !== undefined) return fromCode;
    }
    if (exactRecord(diagnostic.details)) {
      const status = typeof diagnostic.details.status === "number"
        ? diagnostic.details.status
        : typeof diagnostic.details.statusCode === "number"
          ? diagnostic.details.statusCode
          : undefined;
      const fromStatus = navigatorProviderFailureFromStatus(status);
      if (fromStatus !== undefined) return fromStatus;
      const fromCode = navigatorProviderFailureFromCode(diagnostic.details.code);
      if (fromCode !== undefined) return fromCode;
    }
  }
  return undefined;
}

const navigatorProviderFailureSchema = Type.Object({
  source: Type.Union([
    Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"),
    Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown"),
  ]),
  cause: Type.Union([
    Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"),
    Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown"),
  ]),
}, { additionalProperties: false });

export function navigatorProviderFailure<T extends object>(
  message: T,
  source: NavigatorUnavailableKey,
  cause: NavigatorUnavailableKey = source,
): T & { navigatorFailure: NavigatorProviderFailureFact } {
  const fact = { source, cause } satisfies NavigatorProviderFailureFact;
  if (!Value.Check(navigatorProviderFailureSchema, fact)) throw new TypeError("Navigator provider failure fact is not typed");
  return Object.assign(message, { navigatorFailure: fact });
}

export type NavigatorPreparationSession = {
  prompt(text: string): Promise<void>;
  appendEntry(customType: string, data: unknown): void;
  entries(): readonly unknown[];
  providerFailure?(): NavigatorProviderFailureFact | undefined;
  setModel?(model: string, thinkingLevel: "off" | "max"): Promise<void>;
  getThinkingLevel?(): string;
  recordPointer(): string;
  dispose(): void;
};

export type NavigatorSessionFactory = (options: {
  context: HostContext;
  subject: string;
  modelSettingPath?: string;
  tool: ToolDefinition;
}) => Promise<NavigatorPreparationSession>;

export function navigatorModelSettingPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "navigator-model.json");
}

export async function readNavigatorModelSetting(path = navigatorModelSettingPath()): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!exactRecord(raw) || typeof raw.model !== "string" || raw.model.trim() === "") {
      throw new Error("Navigator model setting is malformed");
    }
    return raw.model;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return NAVIGATOR_DEFAULT_MODEL;
    }
    throw error;
  }
}

export async function writeNavigatorModelSetting(model: string, path = navigatorModelSettingPath()): Promise<void> {
  const normalized = model.trim();
  parseNavigatorModelSetting(normalized);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ model: normalized })}\n`, "utf8");
}

export function parseNavigatorModelSetting(value: string): {
  provider: string;
  model: string;
  thinkingLevel: "off" | "max";
} {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("Navigator model setting must be provider/model[:max]");
  }
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? undefined : modelWithThinking.slice(colon + 1);
  if (suffix !== undefined && suffix !== "max") {
    throw new Error("Navigator model setting must use :max or omit the thinking suffix");
  }
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  return { provider, model, thinkingLevel: suffix === "max" ? "max" : "off" };
}
