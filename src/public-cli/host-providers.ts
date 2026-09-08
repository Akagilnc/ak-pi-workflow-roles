/**
 * #788: owner-editable host provider map + host-directory resolution.
 *
 * Data file `~/.ak-roles/host-providers.json` is the sole owner-written map.
 * Shape: { "<host>": { "<seat-provider>": "<host-provider>" } }.
 * Code only reads it — no built-in pairs, no registration commands.
 *
 * Priority: table > unique directory match > loud failure.
 * This ticket implements directory query for hermes only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SeatModelConfig } from "./config.ts";

/** host → seat-provider → host-facing provider. */
export type HostProvidersTable = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

export function hostProvidersPath(home: string): string {
  if (typeof home !== "string" || home.trim() === "") {
    throw new Error("home must be explicitly provided");
  }
  return join(home, ".ak-roles", "host-providers.json");
}

/** Hermes provider model catalog under the operator home. */
export function hermesProviderModelsCachePath(home: string): string {
  return join(home, ".hermes", "provider_models_cache.json");
}

export function parseHostProvidersTable(value: unknown): HostProvidersTable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host-providers.json must be an object");
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [host, byProvider] of Object.entries(value as Record<string, unknown>)) {
    if (host.trim() === "") {
      throw new Error("host-providers.json host key must be non-empty");
    }
    if (
      byProvider === null ||
      typeof byProvider !== "object" ||
      Array.isArray(byProvider)
    ) {
      throw new Error(`host-providers.json[${host}] must be an object`);
    }
    const providers: Record<string, string> = {};
    for (const [seatProvider, hostProvider] of Object.entries(
      byProvider as Record<string, unknown>,
    )) {
      if (seatProvider.trim() === "") {
        throw new Error(
          `host-providers.json[${host}] seat-provider key must be non-empty`,
        );
      }
      if (typeof hostProvider !== "string" || hostProvider.trim() === "") {
        throw new Error(
          `host-providers.json[${host}][${seatProvider}] must be a non-empty string`,
        );
      }
      providers[seatProvider] = hostProvider;
    }
    if (Object.keys(providers).length > 0) {
      out[host] = providers;
    }
  }
  return out;
}

/**
 * Load the owner map. Missing file → empty table (directory / pass-through next).
 * Malformed file fails loud — owner edits this by hand.
 */
export function loadHostProvidersTable(home: string): HostProvidersTable {
  const path = hostProvidersPath(home);
  try {
    const raw = readFileSync(path, "utf8");
    return parseHostProvidersTable(JSON.parse(raw) as unknown);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

/** True when the host catalog entry names the seat model (bare or slash-suffixed). */
export function hostCatalogOffersModel(
  catalogModels: readonly string[],
  seatModel: string,
): boolean {
  return catalogModels.some(
    (entry) => entry === seatModel || entry.endsWith(`/${seatModel}`),
  );
}

/**
 * Providers in the hermes catalog that offer `seatModel`.
 * Reads `~/.hermes/provider_models_cache.json` under the given home.
 * Missing/unreadable cache → empty list (zero → loud failure upstream).
 */
export function listHermesProvidersForModel(
  home: string,
  seatModel: string,
): readonly string[] {
  const path = hermesProviderModelsCachePath(home);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const found: string[] = [];
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const models = (entry as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    const names = models.filter((m): m is string => typeof m === "string");
    if (hostCatalogOffersModel(names, seatModel)) {
      found.push(provider);
    }
  }
  return found.sort();
}

/** Hosts this build knows how to query a provider-model directory for. */
function listDirectoryProvidersForModel(
  home: string,
  host: string,
  seatModel: string,
): readonly string[] | undefined {
  if (host === "hermes") {
    return listHermesProvidersForModel(home, seatModel);
  }
  // No directory for this host → caller falls through to pass-through.
  return undefined;
}

export class HostProviderResolutionError extends Error {
  readonly host: string;
  readonly seatProvider: string;
  readonly seatModel: string;
  readonly candidates: readonly string[];

  constructor(options: {
    message: string;
    host: string;
    seatProvider: string;
    seatModel: string;
    candidates?: readonly string[];
  }) {
    super(options.message);
    this.name = "HostProviderResolutionError";
    this.host = options.host;
    this.seatProvider = options.seatProvider;
    this.seatModel = options.seatModel;
    this.candidates = options.candidates ?? [];
  }
}

/**
 * Project seat-table provider to the host-facing name.
 * Priority: owner table > unique host-directory match > loud failure.
 * Hosts without a directory and without a table entry pass the seat provider through.
 */
export function projectHostFacingProvider(
  selection: SeatModelConfig | undefined,
  host: string,
  table: HostProvidersTable,
  home: string,
): SeatModelConfig | undefined {
  if (selection === undefined) return undefined;

  const mapped = table[host]?.[selection.provider];
  if (mapped !== undefined) {
    return mapped === selection.provider
      ? selection
      : { ...selection, provider: mapped };
  }

  const directory = listDirectoryProvidersForModel(home, host, selection.model);
  if (directory === undefined) {
    // No directory for this host → pass-through (pi, grok-build, …).
    return selection;
  }

  if (directory.length === 1) {
    const only = directory[0]!;
    return only === selection.provider
      ? selection
      : { ...selection, provider: only };
  }

  if (directory.length === 0) {
    throw new HostProviderResolutionError({
      message: `host ${host} has no provider offering model ${selection.model}; seat provider was ${selection.provider}`,
      host,
      seatProvider: selection.provider,
      seatModel: selection.model,
    });
  }

  throw new HostProviderResolutionError({
    message: `host ${host} has multiple providers for model ${selection.model}: ${directory.join(", ")}; set host-providers.json[${host}][${selection.provider}] to one of them`,
    host,
    seatProvider: selection.provider,
    seatModel: selection.model,
    candidates: directory,
  });
}

/** Render the owner table for `config show` (disk face, unchanged). */
export function renderHostProvidersTable(table: HostProvidersTable): string {
  const lines: string[] = [];
  for (const host of Object.keys(table).sort()) {
    const byProvider = table[host]!;
    for (const seatProvider of Object.keys(byProvider).sort()) {
      lines.push(
        `hostProvider\t${host}\t${seatProvider}\t${byProvider[seatProvider]}`,
      );
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
