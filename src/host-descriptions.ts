/**
 * Packaged host description table (#729 / #731).
 * Key = seat-table `host` value. pi is the in-process default, not a row.
 * Unregistered names fail closed (#510); this table does not fallback.
 */
export type HostResumeBinding = "session/load" | "session/new";

export type HostDescription = Readonly<{
  /** CLI binary basename. */
  readonly binary: string;
  /** Operator-home-relative path to the binary. */
  readonly relativeBinary: string;
  /** ACP stdio argv; the adapter inserts model/thinking flags. */
  readonly argv: readonly string[];
  /** Argv flag for model id; omitted when the host has none. */
  readonly modelFlag?: string;
  /** Argv flag for thinking/档位; omitted when the host has none. */
  readonly thinkingFlag?: string;
  /** Bound same-host resume ACP method. */
  readonly resume: HostResumeBinding;
}>;

export const DEFAULT_ROLE_TURN_HOST = "pi" as const;

export const HOST_DESCRIPTIONS: Readonly<Record<string, HostDescription>> = Object.freeze({
  "grok-build": Object.freeze({
    binary: "grok",
    relativeBinary: ".grok/bin/grok",
    argv: Object.freeze(["agent", "stdio"]),
    modelFlag: "--model",
    resume: "session/load",
  }),
});

export function lookupHostDescription(host: string): HostDescription | undefined {
  return Object.hasOwn(HOST_DESCRIPTIONS, host) ? HOST_DESCRIPTIONS[host] : undefined;
}

export function packagedExternalHostNames(): readonly string[] {
  return Object.keys(HOST_DESCRIPTIONS);
}

/** Legal persistent/invocation host: default pi, or a table key. */
export function assertRegisteredHostName(host: string): string {
  if (host === DEFAULT_ROLE_TURN_HOST || lookupHostDescription(host) !== undefined) {
    return host;
  }
  throw new Error(`unregistered host: ${host}`);
}
