/**
 * Headless CLI host descriptions (#645 / #646 / #752).
 * Shared lifecycle owns spawn/bind/close; each protocol owns argv + parse shape.
 * Claude print-mode and codex exec differ enough that #752 host-specific
 * assembly lives here as sibling helpers — not a third unified abstraction.
 */
import type { HostIdentityDescription } from "../host-descriptions.ts";

/** Claude Code print-mode (#645). */
export type ClaudePrintHostDescription = HostIdentityDescription & Readonly<{
  protocol: "claude-print";
  /**
   * Host-native print-mode flags that never change per turn (no prompt).
   * Model / effort / system-prompt / schema / session / resume / mcp-config
   * are composed by the adapter from the turn request — not listed here.
   */
  fixedArgs: readonly string[];
  /** Print-mode flag (e.g. `-p`); user prompt rides stdin, not this flag's value (#879). */
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

/**
 * Codex `exec` / `exec resume` (#646).
 * Protocol differences (JSONL, resume subcommand, schema file, `-c` MCP) stay
 * in codex-specific helpers — description only carries identity + binary path.
 */
export type CodexExecHostDescription = HostIdentityDescription & Readonly<{
  protocol: "codex-exec";
}>;

export type HeadlessHostDescription = ClaudePrintHostDescription | CodexExecHostDescription;

export function isClaudePrintDescription(
  description: HeadlessHostDescription,
): description is ClaudePrintHostDescription {
  return description.protocol === "claude-print";
}

export function isCodexExecDescription(
  description: HeadlessHostDescription,
): description is CodexExecHostDescription {
  return description.protocol === "codex-exec";
}

/**
 * Build one Claude print-mode argv for a single process turn.
 * Shape: `<promptFlag> <fixedArgs…> <system/schema/mcp/model/effort/session…>`.
 * User dialogue rides stdin, not an argv element (#879 / ARG_MAX).
 */
export function headlessTurnArgs(options: {
  readonly description: ClaudePrintHostDescription;
  /** Absolute path written by the adapter; paired with `systemPromptFlag`. */
  readonly systemPromptPath: string;
  /**
   * Open JSON Schema for structured_output seats, passed through as declared.
   * Optional: omit for prose-exit seats (#959 navigator) so the model may speak free text.
   */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
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
    ...description.fixedArgs,
    description.systemPromptFlag,
    options.systemPromptPath,
  ];
  if (options.jsonSchema !== undefined) {
    args.push(description.jsonSchemaFlag, JSON.stringify(options.jsonSchema));
  }
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
 * TOML string literal for `codex -c key=<value>` (values are TOML-parsed).
 * Double-quoted form; escapes backslash and quote only.
 */
function codexTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** TOML array of strings for `-c key=["a","b"]`. */
function codexTomlStringArray(values: readonly string[]): string {
  return `[${values.map(codexTomlString).join(",")}]`;
}

/** TOML inline table of string→string for `-c key={a="b"}`. */
function codexTomlStringTable(entries: Readonly<Record<string, string>>): string {
  const parts = Object.entries(entries).map(
    ([key, value]) => `${key}=${codexTomlString(value)}`,
  );
  return `{${parts.join(",")}}`;
}

/** Shared plain-object guard for headless host schema/event reduction. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project shared-envelope MCP rows into `codex -c mcp_servers.<name>.*` argv pairs.
 * Dot-path + TOML values per official config-advanced; spawn argv (no shell).
 */
function stringEnvironment(value: unknown): Record<string, string> | undefined {
  const entries = Array.isArray(value)
    ? value.flatMap((item) => {
        if (!isPlainObject(item) || typeof item.name !== "string" || typeof item.value !== "string") return [];
        return [[item.name, item.value] as const];
      })
    : isPlainObject(value)
      ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      : [];
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function codexMcpConfigArgs(
  mcpServers: readonly Readonly<Record<string, unknown>>[],
): string[] {
  const args: string[] = [];
  for (const row of mcpServers) {
    const name = typeof row.name === "string" ? row.name : undefined;
    const command = typeof row.command === "string" ? row.command : undefined;
    if (name === undefined || name === "" || command === undefined || command === "") continue;
    const prefix = `mcp_servers.${name}`;
    // required=true: fail the exec if the AK relay cannot handshake (official:
    // required MCP init failure exits with error). Without it, a silent drop
    // would hide a broken intermediate-tool channel (#646 须真跑证②).
    args.push("-c", `${prefix}.command=${codexTomlString(command)}`);
    args.push("-c", `${prefix}.required=true`);
    // Codex caps each MCP tools/call (#1020: 300s); gates wait on long seats.
    args.push("-c", `${prefix}.tool_timeout_sec=3600`);
    if (Array.isArray(row.args) && row.args.every((item): item is string => typeof item === "string")) {
      args.push("-c", `${prefix}.args=${codexTomlStringArray(row.args)}`);
    }
    const env = stringEnvironment(row.env);
    if (env !== undefined) {
      args.push("-c", `${prefix}.env=${codexTomlStringTable(env)}`);
    }
  }
  return args;
}

/**
 * Build one `codex exec` / `codex exec resume` argv (#646).
 * New: `exec --approve-for-me … -- -` (prompt on stdin).
 * Resume: `exec --approve-for-me resume <thread_id> … -- -`.
 * Approval stays on the parent command so new and resumed turns use Codex's
 * automatic review with its workspace-write sandbox.
 */
export function codexTurnArgs(options: {
  /** Absolute path for `-c model_instructions_file=…`. */
  readonly systemPromptPath: string;
  /**
   * Absolute path for the native `--output-schema` flag.
   * Pass the declaration unchanged; native strict output cannot promise an open contract.
   * Optional for prose-exit seats (#959 navigator) so agent_message stays free text.
   */
  readonly outputSchemaPath?: string;
  readonly mcpServers: readonly Readonly<Record<string, unknown>>[];
  readonly model?: string;
  readonly effort?: string;
  /**
   * New turn: host mints thread_id (captured from JSONL).
   * Resume: package-bound thread_id via `exec resume <id>`.
   */
  readonly session: { readonly kind: "new" } | { readonly kind: "resume"; readonly id: string };
  /** When cwd is not a git work tree, pass `--skip-git-repo-check`. */
  readonly skipGitRepoCheck?: boolean;
  /**
   * Extra writable roots under workspace-write (absolute paths).
   * Git worktrees need the common dir writable for index.lock / commit
   * (official `sandbox_workspace_write.writable_roots` / `--add-dir`).
   */
  readonly writableRoots?: readonly string[];
}): string[] {
  // Parent-command flag must precede the resume subcommand.
  const args: string[] = ["exec", "--approve-for-me"];
  if (options.session.kind === "resume") {
    args.push("resume", options.session.id);
  }

  // JSONL event stream: thread_id + final agent_message + turn.completed/failed.
  args.push("--json");
  // Operator config/skills stay open (#922 host-native-loader). Auth uses CODEX_HOME.
  const roots = (options.writableRoots ?? []).filter((root) => root !== "");
  if (roots.length > 0) {
    // Resume has no --add-dir; the config key keeps extra roots available on both paths.
    args.push(
      "-c",
      `sandbox_workspace_write.writable_roots=${codexTomlStringArray(roots)}`,
    );
    if (options.session.kind === "new") {
      for (const root of roots) {
        args.push("--add-dir", root);
      }
    }
  }

  args.push("-c", `model_instructions_file=${codexTomlString(options.systemPromptPath)}`);
  if (options.outputSchemaPath !== undefined) {
    args.push("--output-schema", options.outputSchemaPath);
  }
  args.push(...codexMcpConfigArgs(options.mcpServers));

  if (options.model !== undefined && options.model !== "") {
    args.push("-m", options.model);
  }
  if (options.effort !== undefined && options.effort !== "") {
    args.push("-c", `model_reasoning_effort=${codexTomlString(options.effort)}`);
  }
  if (options.skipGitRepoCheck === true) {
    args.push("--skip-git-repo-check");
  }

  // `-` after `--` is Codex's stdin prompt sentinel. `--` still stops option
  // parsing; the user body itself is not an argv element (#879 / ARG_MAX).
  args.push("--", "-");
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
    const env = stringEnvironment(row.env);
    if (env !== undefined) entry.env = env;
    servers[name] = entry;
  }
  return Object.freeze({ mcpServers: Object.freeze(servers) });
}
