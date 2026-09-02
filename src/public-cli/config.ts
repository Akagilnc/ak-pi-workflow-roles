/**
 * Persistent and effective per-seat model/thinking configuration for ak-role.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertLegalEngineName } from "../package-resources/engine-material.ts";
import {
  AUTOMATIC_CONFIGURABLE_SEATS,
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CONFIGURABLE_SEATS,
  isAutomaticConfigurableSeat,
  isPublicCallableRole,
  isPublicConfigurableSeat,
  type ModelRef,
  type PublicCallableRole,
  type PublicConfigurableSeat,
  type PublicThinkingLevel,
  publicStartupCandidates,
} from "./registry.ts";

/** Province officers that may carry a persistent model override (#453). */
export const GATE_OFFICER_SEATS = [
  "gatekeeper",
  "inspector",
  "notary",
] as const;

export type GateOfficerSeat = (typeof GATE_OFFICER_SEATS)[number];

export function isGateOfficerSeat(value: string): value is GateOfficerSeat {
  return (GATE_OFFICER_SEATS as readonly string[]).includes(value);
}

export type CredentialProviders = {
  "openai-codex": boolean;
  xai: boolean;
};

export type SeatModelConfig = ModelRef;

/**
 * Persistent seat row (#356/#384/#453/#522): model, engine, and host are
 * independent axes. Axis-only residuals are legal only for notary after model
 * clear; all other seats keep the baseline provider/model required contract.
 */
export type PersistentSeatConfig = {
  provider?: string;
  model?: string;
  thinking?: PublicThinkingLevel;
  engine?: string;
  host?: string;
};

export type PublicCliConfig = {
  seats: Partial<Record<PublicConfigurableSeat, PersistentSeatConfig>>;
  /**
   * #422: single-call auto-resume retry ceiling, sibling of `seats`.
   * Non-negative integer; 0 disables auto-resume (one dispatch per call).
   * undefined = package default (AUTO_RESUME_LIMIT). No package-local upper
   * bound (ADR 0035).
   */
  autoResumeLimit?: number;
};

export type EffectiveSource = "persistent" | "startup" | "invocation" | "unconfigured";

/** Engine axis source is independent of model source (#356). */
export type EngineSource = "invocation" | "persistent" | "unconfigured";
export type HostSource = "invocation" | "persistent" | "default";

export type EffectiveSeat = {
  seat: PublicConfigurableSeat;
  /** True when the seat is automatic (no caller command) rather than caller-selected. */
  automatic: boolean;
  source: EffectiveSource;
  selection?: SeatModelConfig;
  /** Selected engine name when configured; undefined = no engine (default path). */
  engine?: string;
  engineSource: EngineSource;
  host: string;
  hostSource: HostSource;
};

export type InvocationModelOverride = {
  model?: string;
  thinking?: PublicThinkingLevel;
  /** Optional engine override for this invocation only (#356). */
  engine?: string;
  host?: string;
};

export const THINKING_LEVELS = new Set<PublicThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function publicCliConfigPath(home: string): string {
  if (typeof home !== "string" || home.trim() === "") {
    throw new Error("home must be explicitly provided");
  }
  return join(home, ".ak-roles", "public-cli.json");
}

export async function loadPublicCliConfig(
  home: string,
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
  home: string,
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
    // Spread preserves sibling top-level keys such as autoResumeLimit (#422):
    // a seat write must never silently drop them.
    ...config,
    seats: {
      ...config.seats,
      [seat]: {
        ...selection,
        // Model rewrite preserves a previously configured engine axis.
        ...(previous?.engine === undefined ? {} : { engine: previous.engine }),
        ...(previous?.host === undefined ? {} : { host: previous.host }),
      },
    },
  };
}

/**
 * Clear a gate officer's persistent model override (#453).
 * Scope is GateOfficerSeat only — non-province seats have no destructive clear seam.
 * Only notary may retain host/engine residual axes while model resolution returns
 * to startup / province inheritance. gatekeeper/inspector drop the whole row.
 * Already-absent seats are a no-op.
 */
export function clearPersistentSeatConfig(
  config: PublicCliConfig,
  seat: GateOfficerSeat,
): PublicCliConfig {
  const previous = config.seats[seat];
  if (previous === undefined) return config;
  // Axis-only residual ownership is notary-only — never widen to other officers.
  if (seat === "notary" && (previous.engine !== undefined || previous.host !== undefined)) {
    return {
      ...config,
      seats: {
        ...config.seats,
        notary: {
          ...(previous.engine === undefined ? {} : { engine: previous.engine }),
          ...(previous.host === undefined ? {} : { host: previous.host }),
        },
      },
    };
  }
  const { [seat]: _dropped, ...seats } = config.seats;
  return { ...config, seats };
}

/**
 * Province-only model selection (#453): officer persistent > gatekeeper persistent
 * > unset (caller inherits parent session). Never consults startup candidates —
 * direct `ak-role notary` keeps resolveEffectiveSeat; only province reads this.
 * Engine-only residual is not a model override.
 */
export function resolveGateOfficerModelSelection(
  config: PublicCliConfig,
  officer: GateOfficerSeat,
): SeatModelConfig | undefined {
  const ownModel = seatModelOnly(config.seats[officer]);
  if (ownModel !== undefined) return ownModel;
  if (officer === "gatekeeper") return undefined;
  return seatModelOnly(config.seats.gatekeeper);
}

/**
 * Seats that own the labor-engine axis (#391: PUBLIC_CALLABLE_ROLES only).
 * Navigator is configurable for model but has no independent activation path.
 */
/** Set or clear the persistent main-session host on a callable role seat. */
export function setPersistentSeatHost(
  config: PublicCliConfig,
  seat: PublicCallableRole,
  host: string | undefined,
): PublicCliConfig {
  const previous = config.seats[seat];
  if (previous === undefined) {
    throw new Error(`config seat ${seat} has no persistent model; set provider/model[:thinking] before host`);
  }
  if (host === undefined) {
    const { host: _dropped, ...rest } = previous;
    if (seatModelOnly(rest) === undefined && rest.engine === undefined) {
      const { [seat]: _row, ...seats } = config.seats;
      return { ...config, seats };
    }
    return { ...config, seats: { ...config.seats, [seat]: rest } };
  }
  return { ...config, seats: { ...config.seats, [seat]: { ...previous, host } } };
}

/**
 * Set or clear persistent engine on a callable role seat (#356 / #378 / #391 / #453).
 * First engine still requires an existing seat row (model, or notary engine residual).
 * Clearing engine from a notary engine-only residual drops the empty row; clearing
 * engine from a model+engine row leaves model-only. Seat type is PublicCallableRole
 * (navigator excluded at the type boundary).
 */
export function setPersistentSeatEngine(
  config: PublicCliConfig,
  seat: PublicCallableRole,
  engine: string | undefined,
): PublicCliConfig {
  const previous = config.seats[seat];
  if (previous === undefined) {
    throw new Error(
      `config seat ${seat} has no persistent model; set provider/model[:thinking] before engine`,
    );
  }
  if (engine === undefined) {
    const { engine: _dropped, ...modelOnly } = previous;
    // Drop the row only after the final independent axis is cleared.
    if (seatModelOnly(modelOnly) === undefined && modelOnly.host === undefined) {
      const { [seat]: _row, ...seats } = config.seats;
      return { ...config, seats };
    }
    return {
      ...config,
      seats: {
        ...config.seats,
        [seat]: modelOnly,
      },
    };
  }
  // Engine-name path-safety syntax is owned solely by assertLegalEngineName
  // (call-request + config-parse seams). Setter is pure seat mutation.
  return {
    ...config,
    seats: {
      ...config.seats,
      [seat]: { ...previous, engine },
    },
  };
}

/**
 * #422 value domain authority for the auto-resume ceiling: non-negative integer,
 * no package-local upper bound (ADR 0035). `0` is legal and means auto-resume is
 * disabled (a single dispatch, no in-place retry). Negative numbers, fractions,
 * NaN, Infinity and non-number types are rejected loudly — never silently coerced.
 */
export function parseAutoResumeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `auto-resume limit must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * #422: set the persistent autoResumeLimit top-level key. Pure mutation that
 * preserves all sibling keys (seats included).
 */
export function setAutoResumeLimit(
  config: PublicCliConfig,
  limit: number,
): PublicCliConfig {
  return { ...config, autoResumeLimit: parseAutoResumeLimit(limit) };
}

/**
 * Strip optional engine so activation model argv never sees the engine axis.
 * Engine-only residual (model cleared) yields undefined — not a model override.
 */
export function seatModelOnly(
  seat: PersistentSeatConfig | undefined,
): SeatModelConfig | undefined {
  if (seat?.provider === undefined || seat.model === undefined) return undefined;
  return seat.thinking === undefined
    ? { provider: seat.provider, model: seat.model }
    : { provider: seat.provider, model: seat.model, thinking: seat.thinking };
}

/**
 * Config-parse seam: persistent call axes belong to PUBLIC_CALLABLE_ROLES;
 * engine names need only path-safety syntax (no closed material catalog;
 * #376 / #378 / #391 / ADR 0069). Disk-handwritten automatic-seat axes are
 * rejected. Syntax authority = assertLegalEngineName (no injected duplicate).
 */
export function validatePublicCliConfigAxes(
  config: PublicCliConfig,
  _packageRoot: string,
): void {
  for (const seat of Object.keys(config.seats) as PublicConfigurableSeat[]) {
    const row = config.seats[seat];
    if ((row?.engine !== undefined || row?.host !== undefined) && !isPublicCallableRole(seat)) {
      throw new Error(
        `config seat ${seat} cannot persist call axes: no independent activation path; storing would be silently ineffective`,
      );
    }
    if (row?.engine === undefined) continue;
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
  const record = value as { seats?: unknown; autoResumeLimit?: unknown };
  // #422 round-trip preservation: the sibling top-level key must survive every
  // parse→save cycle; an unknown-key drop would silently erase it on any write.
  let autoResumeLimit: number | undefined;
  if (record.autoResumeLimit !== undefined) {
    autoResumeLimit = parseAutoResumeLimit(record.autoResumeLimit);
  }
  if (record.seats === undefined) {
    return {
      seats: {},
      ...(autoResumeLimit === undefined ? {} : { autoResumeLimit }),
    };
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
    // #592: shared machine-wide public-cli.json may hold seat rows a newer CLI
    // wrote. Skip unknown keys on read — this build only consumes seats it owns.
    // Unknown field-level keys on known seats keep their existing tolerance.
    if (!isPublicConfigurableSeat(key)) {
      continue;
    }
    seats[key] = parseSeatModelConfig(raw, key);
  }
  return {
    seats,
    ...(autoResumeLimit === undefined ? {} : { autoResumeLimit }),
  };
}

function parseSeatModelConfig(value: unknown, seat: string): PersistentSeatConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config seat ${seat} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const hasProvider = raw.provider !== undefined;
  const hasModel = raw.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new Error(`config seat ${seat} requires both provider and model`);
  }
  if (raw.host !== undefined && (typeof raw.host !== "string" || raw.host.trim() === "")) {
    throw new Error(`config seat ${seat} host must be a non-empty string`);
  }
  if (raw.engine !== undefined && typeof raw.engine !== "string") {
    // Shape only: engine must be a string field. Path-safety syntax is deferred to
    // validatePublicCliConfigAxes → assertLegalEngineName (single authority).
    throw new Error(`config seat ${seat} engine must be a string`);
  }
  // #453/#522: host/engine residual axes are legal only for notary after model clear.
  // All other seats keep the baseline provider/model required contract.
  if (!hasProvider) {
    if (seat === "notary" && (typeof raw.engine === "string" || typeof raw.host === "string")) {
      if (raw.thinking !== undefined) {
        throw new Error(`config seat ${seat} thinking requires provider/model`);
      }
      return {
        ...(raw.engine === undefined ? {} : { engine: raw.engine as string }),
        ...(raw.host === undefined ? {} : { host: raw.host as string }),
      };
    }
    throw new Error(`config seat ${seat} requires provider`);
  }
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
    provider: raw.provider as string,
    model: raw.model as string,
    ...(raw.thinking === undefined
      ? {}
      : { thinking: raw.thinking as PublicThinkingLevel }),
    ...(raw.engine === undefined ? {} : { engine: raw.engine as string }),
    ...(raw.host === undefined ? {} : { host: raw.host as string }),
  };
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

type UnhostedEffectiveSeat = Omit<EffectiveSeat, "host" | "hostSource">;

function attachHostAxis(
  seat: UnhostedEffectiveSeat,
  config: PublicCliConfig,
  invocation?: InvocationModelOverride,
): EffectiveSeat {
  if (invocation?.host !== undefined) return { ...seat, host: invocation.host, hostSource: "invocation" };
  const persistent = config.seats[seat.seat]?.host;
  if (persistent !== undefined) return { ...seat, host: persistent, hostSource: "persistent" };
  return { ...seat, host: "pi", hostSource: "default" };
}

function attachEngineAxis(
  seat: UnhostedEffectiveSeat,
  config: PublicCliConfig,
  invocation?: InvocationModelOverride,
): UnhostedEffectiveSeat {
  // #391: engine axis is PUBLIC_CALLABLE_ROLES only (single callable-seat predicate).
  if (!isPublicCallableRole(seat.seat)) {
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
): UnhostedEffectiveSeat {
  const automatic = isAutomaticConfigurableSeat(seat);
  // Engine-only residual is not a persistent model source (#453).
  const persistentModel = seatModelOnly(config.seats[seat]);
  if (persistentModel !== undefined) {
    return {
      seat,
      automatic,
      source: "persistent",
      selection: persistentModel,
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
  const automatic = isAutomaticConfigurableSeat(seat);
  const hasModelInvocation =
    invocation !== undefined &&
    (invocation.model !== undefined || invocation.thinking !== undefined);

  let modelSeat: UnhostedEffectiveSeat;
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

  return attachHostAxis(attachEngineAxis(modelSeat, config, invocation), config, invocation);
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

/** Callable roles first (package order), then automatic configurable seats. */
export function listRolesForDisplay(
  config: PublicCliConfig,
  credentials: CredentialProviders,
  invocation?: InvocationModelOverride,
): EffectiveSeat[] {
  const all = effectiveSeatConfigurations(config, credentials, invocation);
  const callable = PUBLIC_CALLABLE_ROLES.map(
    (role) => all.find((entry) => entry.seat === role)!,
  );
  const automatic = AUTOMATIC_CONFIGURABLE_SEATS.map(
    (seat) => all.find((entry) => entry.seat === seat)!,
  );
  return [...callable, ...automatic];
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
