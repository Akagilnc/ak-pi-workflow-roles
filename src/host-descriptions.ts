/**
 * Packaged host description table (#729 / #731).
 * Key = seat-table `host` value; the row is the generic ACP factory's input.
 * pi is the in-process default, not a row.
 * Unregistered names fail closed (#510); this table does not fallback.
 */
import type { AcpHostDescription } from "./acp-host/description.ts";

/** Grok CLI reads vendor-private compat surfaces unless each is disabled by name. */
const PRIVATE_COMPAT_ENV = Object.fromEntries(
  ["CLAUDE", "CURSOR", "CODEX"].flatMap((vendor) =>
    ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((kind) =>
      [`GROK_${vendor}_${kind}_ENABLED`, "false"] as const)),
);

export const DEFAULT_ROLE_TURN_HOST = "pi" as const;

export const HOST_DESCRIPTIONS: Readonly<Record<string, AcpHostDescription>> = Object.freeze({
  /** Operator home `~/.grok`, native session/load resume, `agent [--model X] stdio`. */
  "grok-build": Object.freeze({
    binaryFromHome: Object.freeze([".grok", "bin", "grok"]),
    argv: Object.freeze({
      prefix: Object.freeze(["agent"]),
      suffix: Object.freeze(["stdio"]),
      modelFlag: "--model",
    }),
    boundResume: "session/load",
    sessionBindingFile: "grok-acp-session.json",
    childEnv: Object.freeze({
      ...PRIVATE_COMPAT_ENV,
      GROK_MEMORY: "0",
      GROK_SUBAGENTS: "0",
    }),
  }),
});

export function lookupHostDescription(host: string): AcpHostDescription | undefined {
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
