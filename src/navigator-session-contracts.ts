/**
 * Navigator session contracts — pure types, model setting, seat resolution, failure classification.
 * No lifecycle. Shared by attendance (consumer) and the unique institutional-child seam.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { HostContext, HostInstitutionalModelSelection } from "./host-contracts.ts";


export const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare" as const;
export const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max" as const;

export type NavigatorUnavailableKey =
  | "context" | "session" | "model" | "thinking" | "auth" | "quota" | "transport" | "unknown";

const NAVIGATOR_UNAVAILABLE_KEYS = new Set<NavigatorUnavailableKey>([
  "context", "session", "model", "thinking", "auth", "quota", "transport", "unknown",
]);

function navigatorUnavailableKey(value: unknown): NavigatorUnavailableKey | undefined {
  return typeof value === "string" && NAVIGATOR_UNAVAILABLE_KEYS.has(value as NavigatorUnavailableKey)
    ? value as NavigatorUnavailableKey
    : undefined;
}

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
  let cursor: unknown = error;
  const seen = new Set<unknown>();
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof NavigatorUnavailableError) {
      return { source: cursor.unavailableSource, cause: cursor.unavailableCause };
    }
    if (!exactRecord(cursor)) {
      cursor = cursor instanceof Error ? cursor.cause : undefined;
      continue;
    }
    const fromReason = navigatorUnavailableKey(cursor.reason);
    if (fromReason !== undefined) return { source: fromReason, cause: fromReason };
    const statusCode = typeof cursor.statusCode === "number"
      ? cursor.statusCode
      : typeof cursor.status === "number"
        ? cursor.status
        : typeof cursor.httpStatus === "number"
          ? cursor.httpStatus
          : undefined;
    const fromStatus = navigatorProviderFailureFromStatus(statusCode);
    if (fromStatus !== undefined) return fromStatus;
    const fromCode = navigatorProviderFailureFromCode(cursor.code);
    if (fromCode !== undefined) return fromCode;
    cursor = cursor.cause;
  }
  return undefined;
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
  setModel?(model: string, thinkingLevel?: string): Promise<void>;
  getThinkingLevel?(): string | undefined;
  recordPointer(): string;
  dispose(): void | Promise<void>;
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
  /** Host thinking passthrough — omit when bare provider/model (#675 ⑥). */
  thinkingLevel?: string;
} {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("Navigator model setting must be provider/model[:thinking]");
  }
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? undefined : modelWithThinking.slice(colon + 1);
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  if (suffix !== undefined && suffix.trim() === "") {
    throw new Error("Navigator model setting thinking suffix must be non-blank");
  }
  return {
    provider,
    model,
    ...(suffix === undefined ? {} : { thinkingLevel: suffix }),
  };
}

/**
 * Navigator model selection from the public seat table only (#675 / #617 DK-3).
 * No legacy navigator-model.json fallback — missing seat is a real model failure.
 * Host/engine axes ride the shared public summons path; attendance open consumes
 * model/thinking here and defers host selection to the shared envelope when present.
 */
export async function resolveNavigatorSeatSelection(
  context: HostContext,
): Promise<{ selection: HostInstitutionalModelSelection; configuredLabel: string; thinkingLevel?: string }> {
  try {
    const { loadPublicCliConfig } = await import("./public-cli/config.ts");
    const { seatModelOnly } = await import("./public-cli/registry.ts");
    const { packageMachineHome } = await import("./activation-ledger-topology.ts");
    const homeCandidate = (context as unknown as { home?: unknown }).home;
    const envHome = process.env.HOME;
    // Prefer explicit context home, then process HOME (hermetic tests), never
    // jump straight to the real machine home when a temp HOME is armed.
    const home =
      typeof homeCandidate === "string"
        ? homeCandidate
        : typeof envHome === "string" && envHome.trim() !== ""
          ? envHome
          : packageMachineHome();
    const config = await loadPublicCliConfig(home);
    const modelOnly = seatModelOnly(config.seats.navigator);
    // Seat table is the only model authority — no legacy navigator-model.json.
    // Bare missing seat uses the package default constant (not a file path).
    if (modelOnly === undefined) {
      const parsed = parseNavigatorModelSetting(NAVIGATOR_DEFAULT_MODEL);
      return {
        selection: {
          provider: parsed.provider,
          model: parsed.model,
          ...(parsed.thinkingLevel === undefined ? {} : { thinking: parsed.thinkingLevel }),
        },
        configuredLabel: NAVIGATOR_DEFAULT_MODEL,
        ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
      };
    }
    // Host params passthrough only — no map/validate/default (#675 ⑥).
    const thinkingRaw = modelOnly.thinking;
    const configuredLabel =
      thinkingRaw === undefined
        ? `${modelOnly.provider}/${modelOnly.model}`
        : `${modelOnly.provider}/${modelOnly.model}:${thinkingRaw}`;
    return {
      selection: {
        provider: modelOnly.provider,
        model: modelOnly.model,
        ...(thinkingRaw === undefined ? {} : { thinking: thinkingRaw }),
      },
      configuredLabel,
      ...(thinkingRaw === undefined ? {} : { thinkingLevel: thinkingRaw }),
    };
  } catch (error) {
    throw navigatorUnavailableError("model", error);
  }
}
