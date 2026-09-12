/**
 * Packaged host description tables (#729 / #731 / #645).
 * Key = seat-table `host` value.
 * - ACP family rows feed the generic ACP factory.
 * - Headless CLI family rows feed the generic headless factory (#645 claude / #646 codex).
 * pi is the in-process default, not a row.
 * Unregistered names fail closed (#510); these tables do not fallback.
 */
import type { AcpHostDescription } from "./acp-host/description.ts";
import type { HeadlessHostDescription } from "./headless-host/description.ts";

/** Grok CLI reads vendor-private compat surfaces unless each is disabled by name. */
const PRIVATE_COMPAT_ENV = Object.fromEntries(
  ["CLAUDE", "CURSOR", "CODEX"].flatMap((vendor) =>
    ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((kind) =>
      [`GROK_${vendor}_${kind}_ENABLED`, "false"] as const)),
);

export const DEFAULT_ROLE_TURN_HOST = "pi" as const;

export type HostFamily = "acp" | "headless";

export const HOST_DESCRIPTIONS: Readonly<Record<string, AcpHostDescription>> = Object.freeze({
  /** Operator home `~/.grok`, native session/load resume, `agent [--model X] stdio`. */
  "grok-build": Object.freeze({
    binaryFromHome: Object.freeze([".grok", "bin", "grok"]),
    argv: Object.freeze({
      prefix: Object.freeze(["agent"]),
      suffix: Object.freeze(["stdio"]),
      modelFlag: "--model",
    }),
    modelPassing: "argv",
    boundResume: "session/load",
    sessionBindingFile: "grok-acp-session.json",
    childEnv: Object.freeze({
      ...PRIVATE_COMPAT_ENV,
      GROK_MEMORY: "0",
      GROK_SUBAGENTS: "0",
    }),
  }),
  /**
   * Operator home `~/.hermes`, native session/load resume, `acp` subcommand.
   * Model arrives as an ACP `session/set_model` RPC with modelId `provider:model`
   * (seat table provider + model concatenated). Reasoning is the global
   * `--reasoning` flag before `acp`. Soul is the seat profile SOUL.md symlink
   * (`hermes -p ak-<role> …`); package `souls/<role>.md` is the sole source.
   */
  "hermes": Object.freeze({
    binaryFromHome: Object.freeze([".local", "bin", "hermes"]),
    argv: Object.freeze({
      prefix: Object.freeze(["acp"]),
      suffix: Object.freeze([]),
      thinkingFlag: "--reasoning",
    }),
    modelPassing: "set_model",
    boundResume: "session/load",
    sessionBindingFile: "hermes-acp-session.json",
    childEnv: Object.freeze({}),
    seatProfileSoul: Object.freeze({
      flag: "-p",
      namePrefix: "ak-",
      profilesRootFromHome: Object.freeze([".hermes", "profiles"]),
      soulFileName: "SOUL.md",
    }),
  }),
});

/**
 * Headless CLI family (#645 / #646). Claude print-mode is the first row;
 * codex exec (#646) adds another. Protocol-specific argv/parse live in
 * headless-host helpers (#752 per-host impl).
 * Claude fixedArgs: print mode, isolation without `--bare` (OAuth stays), full
 * permissions. stream-json + verbose: live host events for sitian records
 * (#811); result is last line. `--setting-sources` empty = load no
 * user/project/local CLAUDE.md/hooks/skills (role envelope is delivered via
 * `--system-prompt` wholesale replace). `--strict-mcp-config` with no
 * `--mcp-config` drops operator MCP + claude.ai connectors.
 */
export const HEADLESS_HOST_DESCRIPTIONS: Readonly<Record<string, HeadlessHostDescription>> = Object.freeze({
  "claude": Object.freeze({
    protocol: "claude-print",
    binaryFromHome: Object.freeze([".local", "bin", "claude"]),
    sessionBindingFile: "claude-headless-session.json",
    fixedArgs: Object.freeze([
      // Live NDJSON events → sitian host-session records (#811); last line is the result receipt.
      "--output-format", "stream-json",
      // Intermediate assistant/tool/system events require verbose with stream-json.
      "--verbose",
      "--permission-mode", "bypassPermissions",
      // Empty sources: no user/project/local operator surface (envelope owns materials).
      "--setting-sources", "",
      // With adapter-supplied --mcp-config only (AK relay); drops operator + claude.ai MCP.
      "--strict-mcp-config",
    ]),
    promptFlag: "-p",
    modelFlag: "--model",
    effortFlag: "--effort",
    // File path keeps large role envelopes off ARG_MAX.
    systemPromptFlag: "--system-prompt-file",
    jsonSchemaFlag: "--json-schema",
    mcpConfigFlag: "--mcp-config",
    sessionIdFlag: "--session-id",
    resumeFlag: "--resume",
  }),
  /**
   * Codex headless (#646). Binary under operator home; auth stays in CODEX_HOME.
   * Argv/parse/schema-close are codex-exec helpers — not Claude flag mapping.
   */
  "codex": Object.freeze({
    protocol: "codex-exec",
    binaryFromHome: Object.freeze([".local", "bin", "codex"]),
    sessionBindingFile: "codex-headless-session.json",
  }),
});

export function lookupHostDescription(host: string): AcpHostDescription | undefined {
  return Object.hasOwn(HOST_DESCRIPTIONS, host) ? HOST_DESCRIPTIONS[host] : undefined;
}

export function lookupHeadlessHostDescription(host: string): HeadlessHostDescription | undefined {
  return Object.hasOwn(HEADLESS_HOST_DESCRIPTIONS, host) ? HEADLESS_HOST_DESCRIPTIONS[host] : undefined;
}

export function lookupHostFamily(host: string): HostFamily | undefined {
  if (lookupHostDescription(host) !== undefined) return "acp";
  if (lookupHeadlessHostDescription(host) !== undefined) return "headless";
  return undefined;
}

export function packagedExternalHostNames(): readonly string[] {
  return [...Object.keys(HOST_DESCRIPTIONS), ...Object.keys(HEADLESS_HOST_DESCRIPTIONS)];
}

/** Legal persistent/invocation host: default pi, or a table key (any family). */
export function assertRegisteredHostName(host: string): string {
  if (host === DEFAULT_ROLE_TURN_HOST || lookupHostFamily(host) !== undefined) {
    return host;
  }
  throw new Error(`unregistered host: ${host}`);
}
