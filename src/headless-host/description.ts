/**
 * One headless CLI host description (#645 / #752).
 * Every host-specific value the generic headless adapter needs — binary, argv
 * shape, session binding — is data here; lifecycle stays one copy so #646 codex
 * is another row, not a fork.
 */
import { join } from "node:path";

export type HeadlessHostDescription = Readonly<{
  /** Binary path segments relative to the operator home. */
  binaryFromHome: readonly string[];
  /** Durable session-id binding filename beside the session principal. */
  sessionBindingFile: string;
  /**
   * Host-native print-mode flags that never change per turn (no prompt).
   * Model / effort / system-prompt / schema / session / resume / mcp-config
   * are composed by the adapter from the turn request — not listed here.
   */
  fixedArgs: readonly string[];
  /** Print-mode flag that takes the user prompt as its value (e.g. `-p`). */
  promptFlag: string;
  /** CLI flag for the seat model (e.g. `--model`). */
  modelFlag: string;
  /** CLI flag for the seat thinking level (e.g. `--effort`); value is opaque pass-through. */
  effortFlag: string;
  /**
   * CLI flag whose value is a path to the system-prompt file
   * (`--system-prompt-file`). File delivery keeps ARG_MAX off the critical path.
   */
  systemPromptFlag: string;
  /** CLI flag whose value is a JSON Schema document string. */
  jsonSchemaFlag: string;
  /** CLI flag whose value is a path or JSON string for MCP servers. */
  mcpConfigFlag: string;
  /** CLI flag to mint a fresh session id (initial turn). */
  sessionIdFlag: string;
  /** CLI flag to resume a prior session id. */
  resumeFlag: string;
}>;

/** Absolute agent binary for one operator home. */
export function resolveHeadlessBinary(
  description: HeadlessHostDescription,
  operatorHome: string,
): string {
  return join(operatorHome, ...description.binaryFromHome);
}

/**
 * Build one headless CLI argv for a single process turn.
 * Shape: `<promptFlag> <prompt> <fixedArgs…> <system/schema/mcp/model/effort/session…>`.
 */
export function headlessTurnArgs(options: {
  readonly description: HeadlessHostDescription;
  readonly prompt: string;
  /** Absolute path written by the adapter; paired with `systemPromptFlag`. */
  readonly systemPromptPath: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /** Absolute path to host-native MCP config JSON; omitted when no AK MCP servers. */
  readonly mcpConfigPath?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Fresh session: pass as session id. Resume: pass as resume id. */
  readonly session: { readonly kind: "new"; readonly id: string } | { readonly kind: "resume"; readonly id: string };
}): string[] {
  const { description } = options;
  const args: string[] = [
    description.promptFlag,
    options.prompt,
    ...description.fixedArgs,
    description.systemPromptFlag,
    options.systemPromptPath,
    description.jsonSchemaFlag,
    JSON.stringify(options.jsonSchema),
  ];
  if (options.mcpConfigPath !== undefined && options.mcpConfigPath !== "") {
    args.push(description.mcpConfigFlag, options.mcpConfigPath);
  }
  if (options.model !== undefined && options.model !== "") {
    args.push(description.modelFlag, options.model);
  }
  if (options.effort !== undefined && options.effort !== "") {
    args.push(description.effortFlag, options.effort);
  }
  if (options.session.kind === "new") {
    args.push(description.sessionIdFlag, options.session.id);
  } else {
    args.push(description.resumeFlag, options.session.id);
  }
  return args;
}

/**
 * Project shared-envelope MCP server rows into Claude `--mcp-config` JSON.
 * Env stays a plain object (Claude CLI shape); ACP rows use `{name,value}[]`.
 */
export function headlessMcpConfigDocument(
  mcpServers: readonly Readonly<Record<string, unknown>>[],
): Readonly<{ mcpServers: Readonly<Record<string, Readonly<Record<string, unknown>>>> }> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const row of mcpServers) {
    const name = typeof row.name === "string" ? row.name : undefined;
    const command = typeof row.command === "string" ? row.command : undefined;
    if (name === undefined || name === "" || command === undefined || command === "") continue;
    const entry: Record<string, unknown> = { command };
    if (Array.isArray(row.args)) entry.args = row.args;
    if (Array.isArray(row.env)) {
      const env: Record<string, string> = {};
      for (const item of row.env) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as { name?: unknown; value?: unknown };
        if (typeof record.name === "string" && typeof record.value === "string") {
          env[record.name] = record.value;
        }
      }
      if (Object.keys(env).length > 0) entry.env = env;
    } else if (typeof row.env === "object" && row.env !== null && !Array.isArray(row.env)) {
      entry.env = row.env;
    }
    servers[name] = entry;
  }
  return Object.freeze({ mcpServers: Object.freeze(servers) });
}
