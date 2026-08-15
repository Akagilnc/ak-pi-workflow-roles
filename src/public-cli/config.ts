/**
 * Persistent and effective per-seat model/thinking configuration for ak-role.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  AUTOMATIC_NAVIGATOR_SEAT,
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CONFIGURABLE_SEATS,
  type ModelRef,
  type PublicConfigurableSeat,
  type PublicThinkingLevel,
  publicStartupCandidates,
} from "./registry.ts";

export type CredentialProviders = {
  "openai-codex": boolean;
  xai: boolean;
};

export type SeatModelConfig = ModelRef;

export type PublicCliConfig = {
  seats: Partial<Record<PublicConfigurableSeat, SeatModelConfig>>;
};

export type EffectiveSource = "persistent" | "startup" | "invocation" | "unconfigured";

export type EffectiveSeat = {
  seat: PublicConfigurableSeat;
  /** True when the seat is automatic Navigator attendance rather than caller-selected. */
  automatic: boolean;
  source: EffectiveSource;
  selection?: SeatModelConfig;
};

export type InvocationModelOverride = {
  model?: string;
  thinking?: PublicThinkingLevel;
};

const THINKING_LEVELS = new Set<PublicThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function publicCliConfigPath(home: string = homedir()): string {
  return join(home, ".ak-roles", "public-cli.json");
}

export async function loadPublicCliConfig(
  home: string = homedir(),
): Promise<PublicCliConfig> {
  const path = publicCliConfigPath(home);
  try {
    const raw = await readFile(path, "utf8");
    return parsePublicCliConfig(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { seats: {} };
    }
    throw error;
  }
}

export async function savePublicCliConfig(
  config: PublicCliConfig,
  home: string = homedir(),
): Promise<void> {
  const path = publicCliConfigPath(home);
  await mkdir(dirname(path), { recursive: true });
  const normalized = parsePublicCliConfig(config);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function setPersistentSeatConfig(
  config: PublicCliConfig,
  seat: PublicConfigurableSeat,
  selection: SeatModelConfig,
): PublicCliConfig {
  return {
    seats: {
      ...config.seats,
      [seat]: { ...selection },
    },
  };
}

export function parseModelSpec(
  spec: string,
  fallbackThinking?: PublicThinkingLevel,
): SeatModelConfig {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("model specification must be non-empty");
  }
  const thinkingSplit = trimmed.lastIndexOf(":");
  let modelPart = trimmed;
  let thinking: PublicThinkingLevel | undefined = fallbackThinking;
  if (thinkingSplit > 0) {
    const maybeThinking = trimmed.slice(thinkingSplit + 1);
    if (THINKING_LEVELS.has(maybeThinking as PublicThinkingLevel)) {
      thinking = maybeThinking as PublicThinkingLevel;
      modelPart = trimmed.slice(0, thinkingSplit);
    }
  }
  const slash = modelPart.indexOf("/");
  if (slash <= 0 || slash === modelPart.length - 1) {
    throw new Error(
      `model specification must be provider/model[:thinking], got ${spec}`,
    );
  }
  const provider = modelPart.slice(0, slash);
  const model = modelPart.slice(slash + 1);
  // #346: bare provider/model is legal on invocation — do not invent thinking.
  // Persistent config set still requires thinking via parsePersistentModelSpec.
  return thinking === undefined
    ? { provider, model }
    : { provider, model, thinking };
}

/** Persistent seat config keeps the three-part provider/model:thinking grammar. */
export function parsePersistentModelSpec(spec: string): SeatModelConfig & {
  thinking: PublicThinkingLevel;
} {
  const parsed = parseModelSpec(spec);
  if (parsed.thinking === undefined) {
    throw new Error(
      `model specification requires a thinking level (provider/model:thinking), got ${spec}`,
    );
  }
  return {
    provider: parsed.provider,
    model: parsed.model,
    thinking: parsed.thinking,
  };
}

export function formatModelSpec(selection: SeatModelConfig): string {
  const base = `${selection.provider}/${selection.model}`;
  return selection.thinking === undefined ? base : `${base}:${selection.thinking}`;
}

/**
 * Single source: seat model selection → Pi argv at the public CLI execution seam.
 * Bare provider/model omits --thinking so pi/model defaults apply; suffix passes through.
 */
export function buildSeatModelCliArgs(model: SeatModelConfig | undefined): string[] {
  if (model === undefined) return [];
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    ...(model.thinking === undefined ? [] : ["--thinking", model.thinking]),
  ];
}

function parsePublicCliConfig(value: unknown): PublicCliConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("public CLI config must be an object");
  }
  const record = value as { seats?: unknown };
  if (record.seats === undefined) {
    return { seats: {} };
  }
  if (
    record.seats === null ||
    typeof record.seats !== "object" ||
    Array.isArray(record.seats)
  ) {
    throw new Error("public CLI config.seats must be an object");
  }
  const seats: PublicCliConfig["seats"] = {};
  for (const [key, raw] of Object.entries(
    record.seats as Record<string, unknown>,
  )) {
    if (!(PUBLIC_CONFIGURABLE_SEATS as readonly string[]).includes(key)) {
      throw new Error(`unknown configurable seat in config: ${key}`);
    }
    seats[key as PublicConfigurableSeat] = parseSeatModelConfig(raw, key);
  }
  return { seats };
}

function parseSeatModelConfig(value: unknown, seat: string): SeatModelConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config seat ${seat} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || raw.provider.trim() === "") {
    throw new Error(`config seat ${seat} requires provider`);
  }
  if (typeof raw.model !== "string" || raw.model.trim() === "") {
    throw new Error(`config seat ${seat} requires model`);
  }
  if (
    typeof raw.thinking !== "string" ||
    !THINKING_LEVELS.has(raw.thinking as PublicThinkingLevel)
  ) {
    throw new Error(`config seat ${seat} requires a valid thinking level`);
  }
  return {
    provider: raw.provider,
    model: raw.model,
    thinking: raw.thinking as PublicThinkingLevel,
  };
}

export function providerConfigured(
  credentials: CredentialProviders,
  provider: string,
): boolean {
  if (provider === "openai-codex") return credentials["openai-codex"] === true;
  if (provider === "xai") return credentials.xai === true;
  return false;
}

/**
 * Typed provider-credential absence for the public seat providers ak-role owns.
 * Presence is read from auth.json shape (CredentialProviders), never from stderr prose.
 * Returns undefined for unknown/custom providers (not this package's credential map).
 */
export function missingPublicProviderCredential(
  provider: string,
  credentials: CredentialProviders,
): provider is "openai-codex" | "xai" {
  if (provider !== "openai-codex" && provider !== "xai") return false;
  return !providerConfigured(credentials, provider);
}

function pickStartupCandidate(
  seat: PublicConfigurableSeat,
  credentials: CredentialProviders,
): SeatModelConfig | undefined {
  for (const candidate of publicStartupCandidates(seat)) {
    if (providerConfigured(credentials, candidate.provider)) {
      return { ...candidate };
    }
  }
  return undefined;
}

function resolveBaseSeat(
  config: PublicCliConfig,
  seat: PublicConfigurableSeat,
  credentials: CredentialProviders,
): EffectiveSeat {
  const automatic = seat === AUTOMATIC_NAVIGATOR_SEAT;
  const persistent = config.seats[seat];
  if (persistent !== undefined) {
    return {
      seat,
      automatic,
      source: "persistent",
      selection: { ...persistent },
    };
  }
  const startup = pickStartupCandidate(seat, credentials);
  if (startup !== undefined) {
    return {
      seat,
      automatic,
      source: "startup",
      selection: startup,
    };
  }
  return { seat, automatic, source: "unconfigured" };
}

export function resolveEffectiveSeat(
  config: PublicCliConfig,
  seat: PublicConfigurableSeat,
  credentials: CredentialProviders,
  invocation?: InvocationModelOverride,
): EffectiveSeat {
  const automatic = seat === AUTOMATIC_NAVIGATOR_SEAT;
  const hasInvocation =
    invocation !== undefined &&
    (invocation.model !== undefined || invocation.thinking !== undefined);
  if (!hasInvocation || invocation === undefined) {
    return resolveBaseSeat(config, seat, credentials);
  }

  if (invocation.model !== undefined) {
    const spec =
      invocation.model.includes(":") || invocation.thinking === undefined
        ? invocation.model
        : `${invocation.model}:${invocation.thinking}`;
    return {
      seat,
      automatic,
      source: "invocation",
      selection: parseModelSpec(spec),
    };
  }

  const base = resolveBaseSeat(config, seat, credentials);
  if (base.selection === undefined || invocation.thinking === undefined) {
    return { seat, automatic, source: "unconfigured" };
  }
  return {
    seat,
    automatic,
    source: "invocation",
    selection: { ...base.selection, thinking: invocation.thinking },
  };
}

export function effectiveSeatConfigurations(
  config: PublicCliConfig,
  credentials: CredentialProviders,
  invocation?: InvocationModelOverride,
): EffectiveSeat[] {
  return PUBLIC_CONFIGURABLE_SEATS.map((seat) =>
    resolveEffectiveSeat(config, seat, credentials, invocation),
  );
}

/** Callable roles first (package order), then automatic Navigator. */
export function listRolesForDisplay(
  config: PublicCliConfig,
  credentials: CredentialProviders,
  invocation?: InvocationModelOverride,
): EffectiveSeat[] {
  const all = effectiveSeatConfigurations(config, credentials, invocation);
  const callable = PUBLIC_CALLABLE_ROLES.map(
    (role) => all.find((entry) => entry.seat === role)!,
  );
  const navigator = all.find((entry) => entry.seat === AUTOMATIC_NAVIGATOR_SEAT)!;
  return [...callable, navigator];
}

/**
 * Read configured credential presence from a Pi auth.json document.
 * Only presence of a provider key matters for startup selection (#11).
 */
export function credentialProvidersFromAuthData(
  data: unknown,
): CredentialProviders {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { "openai-codex": false, xai: false };
  }
  const record = data as Record<string, unknown>;
  return {
    "openai-codex": Object.prototype.hasOwnProperty.call(record, "openai-codex"),
    xai: Object.prototype.hasOwnProperty.call(record, "xai"),
  };
}

export async function loadCredentialProviders(
  agentDir: string,
): Promise<CredentialProviders> {
  try {
    const raw = await readFile(join(agentDir, "auth.json"), "utf8");
    return credentialProvidersFromAuthData(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { "openai-codex": false, xai: false };
    }
    throw error;
  }
}
