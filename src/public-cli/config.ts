/**
 * Persistent and effective per-seat model/thinking configuration for ak-role.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { assertLegalEngineName } from "../package-resources/engine-material.ts";
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

/** Persistent seat row: provider/model[:thinking] + optional engine axis (#356/#384). */
export type PersistentSeatConfig = SeatModelConfig & {
  engine?: string;
};

export type PublicCliConfig = {
  seats: Partial<Record<PublicConfigurableSeat, PersistentSeatConfig>>;
};

export type EffectiveSource = "persistent" | "startup" | "invocation" | "unconfigured";

/** Engine axis source is independent of model source (#356). */
export type EngineSource = "invocation" | "persistent" | "unconfigured";

export type EffectiveSeat = {
  seat: PublicConfigurableSeat;
  /** True when the seat is automatic Navigator attendance rather than caller-selected. */
  automatic: boolean;
  source: EffectiveSource;
  selection?: SeatModelConfig;
  /** Selected engine name when configured; undefined = no engine (default path). */
  engine?: string;
  engineSource: EngineSource;
};

export type InvocationModelOverride = {
  model?: string;
  thinking?: PublicThinkingLevel;
  /** Optional engine override for this invocation only (#356). */
  engine?: string;
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
  const previous = config.seats[seat];
  return {
    seats: {
      ...config.seats,
      [seat]: {
        ...selection,
        // Model rewrite preserves a previously configured engine axis.
        ...(previous?.engine === undefined ? {} : { engine: previous.engine }),
      },
    },
  };
}

/** Seats that own the labor-engine axis (#356 Judge; #378 Reviewer). */
export function isEngineAxisSeat(seat: string): seat is "judge" | "reviewer" {
  return seat === "judge" || seat === "reviewer";
}

/**
 * Set or clear persistent engine on Judge or Reviewer (#356 / #378).
 * Engine-only seats are rejected — provider/model[:thinking] remains required first.
 */
export function setPersistentSeatEngine(
  config: PublicCliConfig,
  seat: PublicConfigurableSeat,
  engine: string | undefined,
): PublicCliConfig {
  if (!isEngineAxisSeat(seat)) {
    throw new Error(`engine axis is judge+reviewer only; refused seat ${seat}`);
  }
  const previous = config.seats[seat];
  if (previous === undefined) {
    throw new Error(
      `config seat ${seat} has no persistent model; set provider/model[:thinking] before engine`,
    );
  }
  if (engine === undefined) {
    const { engine: _dropped, ...modelOnly } = previous;
    return {
      seats: {
        ...config.seats,
        [seat]: modelOnly,
      },
    };
  }
  // Engine-name path-safety syntax is owned solely by assertLegalEngineName
  // (call-request + config-parse seams). Setter is pure seat mutation.
  return {
    seats: {
      ...config.seats,
      [seat]: { ...previous, engine },
    },
  };
}

/** Strip optional engine so activation model argv never sees the engine axis. */
export function seatModelOnly(seat: PersistentSeatConfig): SeatModelConfig {
  return seat.thinking === undefined
    ? { provider: seat.provider, model: seat.model }
    : { provider: seat.provider, model: seat.model, thinking: seat.thinking };
}

/**
 * Config-parse seam: engine axis is Judge+Reviewer; engine names need only
 * path-safety syntax (no closed material catalog; #376 / #378 / ADR 0069).
 * Call with packageRoot after load / before dispatch (#356).
 * Syntax authority = assertLegalEngineName (no injected duplicate).
 */
export function validatePublicCliConfigEngines(
  config: PublicCliConfig,
  _packageRoot: string,
): void {
  for (const seat of Object.keys(config.seats) as PublicConfigurableSeat[]) {
    const row = config.seats[seat];
    if (row?.engine === undefined) continue;
    if (!isEngineAxisSeat(seat)) {
      throw new Error(
        `config seat ${seat} engine is not allowed; engine axis is judge+reviewer only`,
      );
    }
    try {
      assertLegalEngineName(row.engine);
    } catch (error) {
      throw new Error(
        `config seat ${seat} engine is illegal: ${row.engine}`,
        { cause: error },
      );
    }
  }
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
  // #346: no colon → bare provider/model is legal. Colon present (any index,
  // including 0) → suffix must be a typed PublicThinkingLevel (empty/unknown
  // stay format rejects; never swallow ":…" into the model name).
  if (thinkingSplit !== -1) {
    const maybeThinking = trimmed.slice(thinkingSplit + 1);
    if (!THINKING_LEVELS.has(maybeThinking as PublicThinkingLevel)) {
      throw new Error(
        `model specification must be provider/model[:thinking], got ${spec}`,
      );
    }
    thinking = maybeThinking as PublicThinkingLevel;
    modelPart = trimmed.slice(0, thinkingSplit);
  }
  const slash = modelPart.indexOf("/");
  if (slash <= 0 || slash === modelPart.length - 1) {
    throw new Error(
      `model specification must be provider/model[:thinking], got ${spec}`,
    );
  }
  const provider = modelPart.slice(0, slash);
  const model = modelPart.slice(slash + 1);
  // #346/#384: bare provider/model is legal — do not invent thinking.
  return thinking === undefined
    ? { provider, model }
    : { provider, model, thinking };
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

function parseSeatModelConfig(value: unknown, seat: string): PersistentSeatConfig {
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
  // #384: thinking is optional on persistent seats; when present it must be typed.
  if (raw.thinking !== undefined) {
    if (
      typeof raw.thinking !== "string" ||
      !THINKING_LEVELS.has(raw.thinking as PublicThinkingLevel)
    ) {
      throw new Error(`config seat ${seat} requires a valid thinking level`);
    }
  }
  const parsed: PersistentSeatConfig = {
    provider: raw.provider,
    model: raw.model,
    ...(raw.thinking === undefined
      ? {}
      : { thinking: raw.thinking as PublicThinkingLevel }),
  };
  if (raw.engine !== undefined) {
    // Shape only: engine must be a string field. Path-safety syntax is deferred to
    // validatePublicCliConfigEngines → assertLegalEngineName (single authority).
    if (typeof raw.engine !== "string") {
      throw new Error(`config seat ${seat} engine must be a string`);
    }
    parsed.engine = raw.engine;
  }
  return parsed;
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

function attachEngineAxis(
  seat: EffectiveSeat,
  config: PublicCliConfig,
  invocation?: InvocationModelOverride,
): EffectiveSeat {
  // #356 / #378: engine axis is Judge+Reviewer. Other seats stay unconfigured.
  if (!isEngineAxisSeat(seat.seat)) {
    return {
      ...seat,
      engineSource: "unconfigured",
    };
  }
  const persistentEngine = config.seats[seat.seat]?.engine;
  if (invocation?.engine !== undefined) {
    return {
      ...seat,
      engine: invocation.engine,
      engineSource: "invocation",
    };
  }
  if (persistentEngine !== undefined) {
    return {
      ...seat,
      engine: persistentEngine,
      engineSource: "persistent",
    };
  }
  return {
    ...seat,
    engineSource: "unconfigured",
  };
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
      selection: seatModelOnly(persistent),
      engineSource: "unconfigured",
    };
  }
  const startup = pickStartupCandidate(seat, credentials);
  if (startup !== undefined) {
    return {
      seat,
      automatic,
      source: "startup",
      selection: startup,
      engineSource: "unconfigured",
    };
  }
  return { seat, automatic, source: "unconfigured", engineSource: "unconfigured" };
}

export function resolveEffectiveSeat(
  config: PublicCliConfig,
  seat: PublicConfigurableSeat,
  credentials: CredentialProviders,
  invocation?: InvocationModelOverride,
): EffectiveSeat {
  const automatic = seat === AUTOMATIC_NAVIGATOR_SEAT;
  const hasModelInvocation =
    invocation !== undefined &&
    (invocation.model !== undefined || invocation.thinking !== undefined);

  let modelSeat: EffectiveSeat;
  if (!hasModelInvocation || invocation === undefined) {
    modelSeat = resolveBaseSeat(config, seat, credentials);
  } else if (invocation.model !== undefined) {
    const spec =
      invocation.model.includes(":") || invocation.thinking === undefined
        ? invocation.model
        : `${invocation.model}:${invocation.thinking}`;
    modelSeat = {
      seat,
      automatic,
      source: "invocation",
      selection: parseModelSpec(spec),
      engineSource: "unconfigured",
    };
  } else {
    const base = resolveBaseSeat(config, seat, credentials);
    if (base.selection === undefined || invocation.thinking === undefined) {
      modelSeat = {
        seat,
        automatic,
        source: "unconfigured",
        engineSource: "unconfigured",
      };
    } else {
      modelSeat = {
        seat,
        automatic,
        source: "invocation",
        selection: { ...base.selection, thinking: invocation.thinking },
        engineSource: "unconfigured",
      };
    }
  }

  return attachEngineAxis(modelSeat, config, invocation);
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
