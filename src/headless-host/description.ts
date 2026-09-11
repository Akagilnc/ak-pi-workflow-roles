/**
 * Headless CLI host descriptions (#645 / #646 / #752).
 * Shared lifecycle owns spawn/bind/close; each protocol owns argv + parse shape.
 * Claude print-mode and codex exec differ enough that #752 host-specific
 * assembly lives here as sibling helpers — not a third unified abstraction.
 */
import { join } from "node:path";

type HeadlessHostBase = Readonly<{
  /** Binary path segments relative to the operator home. */
  binaryFromHome: readonly string[];
  /** Durable session-id binding filename beside the session principal. */
  sessionBindingFile: string;
}>;

/** Claude Code print-mode (#645). */
export type ClaudePrintHostDescription = HeadlessHostBase & Readonly<{
  protocol: "claude-print";
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

/**
 * Codex `exec` / `exec resume` (#646).
 * Protocol differences (JSONL, resume subcommand, schema file, `-c` MCP) stay
 * in codex-specific helpers — description only carries identity + binary path.
 */
export type CodexExecHostDescription = HeadlessHostBase & Readonly<{
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

/** Absolute agent binary for one operator home. */
export function resolveHeadlessBinary(
  description: HeadlessHostDescription,
  operatorHome: string,
): string {
  return join(operatorHome, ...description.binaryFromHome);
}

/**
 * Build one Claude print-mode argv for a single process turn.
 * Shape: `<promptFlag> <prompt> <fixedArgs…> <system/schema/mcp/model/effort/session…>`.
 */
export function headlessTurnArgs(options: {
  readonly description: ClaudePrintHostDescription;
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

/**
 * Free-form JSON leaf for Type.Unknown under Codex strict transport.
 * Strict rejects bare untyped nodes and root-level additionalProperties:true;
 * a $defs anyOf of JSON values (with nested additionalProperties as $ref)
 * is accepted and keeps array/object receipts expressible (navigator candidates).
 * Package code still does not validate or reject the receipt against schema.
 */
const CODEX_JSON_VALUE_DEF = "codexJsonValue";
const CODEX_JSON_VALUE_REF = `#/$defs/${CODEX_JSON_VALUE_DEF}`;
const CODEX_JSON_VALUE_SCHEMA = Object.freeze({
  anyOf: Object.freeze([
    Object.freeze({ type: "string" }),
    Object.freeze({ type: "number" }),
    Object.freeze({ type: "boolean" }),
    Object.freeze({ type: "null" }),
    Object.freeze({ type: "array", items: Object.freeze({ $ref: CODEX_JSON_VALUE_REF }) }),
    Object.freeze({
      type: "object",
      properties: Object.freeze({}),
      required: Object.freeze([] as string[]),
      additionalProperties: Object.freeze({ $ref: CODEX_JSON_VALUE_REF }),
    }),
  ]),
});

/**
 * Derive a Codex/OpenAI-strict transport schema from the package open schema.
 * Legal open schema is untouched; this is a host-only transmission projection
 * (#646 / 0057 法意 / 0054 strict): every object closes, every property is
 * required, and only originally-optional fields become a null union (official
 * guidance: emulate optional via type|null). Originally-required fields stay
 * non-nullable. Nested open-tool anyOf wrappers are flattened so every branch
 * carries `type`. Type.Unknown / description-only leaves become a free JSON
 * $ref. Package code still does not validate or reject the receipt.
 */
export function closeJsonSchemaForCodex(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const closed = closeSchemaNode(schema) as Record<string, unknown>;
  const existingDefs = isPlainObject(closed.$defs)
    ? (closed.$defs as Record<string, unknown>)
    : {};
  return {
    ...closed,
    $defs: {
      ...existingDefs,
      [CODEX_JSON_VALUE_DEF]: CODEX_JSON_VALUE_SCHEMA,
    },
  };
}

/** Shared plain-object guard for headless host schema/event reduction. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullTypeSchema(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.type === "null") return true;
  if (Array.isArray(value.type) && value.type.includes("null")) return true;
  return false;
}

/**
 * Flatten nested anyOf wrappers into concrete leaf schemas.
 * Open-tool unions often wrap leaves in description-only anyOf shells that
 * lack `type`; strict structured output rejects those intermediate nodes.
 */
function flattenUnionLeaves(schema: unknown): unknown[] {
  if (!isPlainObject(schema)) return [schema];
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.flatMap(flattenUnionLeaves);
  }
  return [schema];
}

/** Drop null leaves; optional edges re-add null once. */
function nonNullLeaves(schema: unknown): unknown[] {
  return flattenUnionLeaves(schema).filter((leaf) => !isNullTypeSchema(leaf));
}

/**
 * Property edge under strict transport.
 * Required → closed non-null leaf(s). Optional → closed leaf(s) + null.
 */
function closePropertySchema(schema: unknown, optional: boolean): unknown {
  const leaves = nonNullLeaves(schema).map(closeSchemaNode);
  if (leaves.length === 0) return { type: "null" };
  if (!optional) {
    return leaves.length === 1 ? leaves[0] : { anyOf: leaves };
  }
  return { anyOf: [...leaves, { type: "null" }] };
}

/**
 * Strict generators require every schema node to declare `type` (or a $ref).
 * Type.Unknown / description-only leaves → free JSON $ref (not string): array
 * and object receipts stay expressible under --output-schema.
 */
function ensureTypedLeaf(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== undefined) return schema;
  if (typeof schema.$ref === "string") return schema;
  if (isPlainObject(schema.properties) || schema.additionalProperties !== undefined) {
    return { ...schema, type: "object" };
  }
  if (schema.items !== undefined) {
    return { ...schema, type: "array" };
  }
  if (schema.const !== undefined) {
    const value = schema.const;
    if (value === null) return { ...schema, type: "null" };
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { ...schema, type: typeof value };
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const sample = schema.enum.find((item) => item !== null);
    if (typeof sample === "string" || typeof sample === "number" || typeof sample === "boolean") {
      return { ...schema, type: typeof sample };
    }
  }
  // Free JSON via $defs. $ref must stand alone (strict rejects sibling keys).
  return { $ref: CODEX_JSON_VALUE_REF };
}

function originalRequiredNames(node: Record<string, unknown>): ReadonlySet<string> {
  if (!Array.isArray(node.required)) return new Set();
  return new Set(node.required.filter((item): item is string => typeof item === "string"));
}

function closeSchemaNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node;

  // Already a ref (free-JSON leaf or pre-existing) — do not retype.
  if (typeof node.$ref === "string") return node;

  // Union node: flatten then close each concrete leaf (do not keep untyped shells).
  if (Array.isArray(node.anyOf)) {
    const leaves = nonNullLeaves(node).map(closeSchemaNode);
    if (leaves.length === 0) return { type: "null" };
    if (leaves.length === 1) return leaves[0];
    return { anyOf: leaves };
  }

  let out: Record<string, unknown> = { ...node };

  if (node.items !== undefined) {
    out.items = closeSchemaNode(node.items);
  }
  if (isPlainObject(node.$defs)) {
    out.$defs = Object.fromEntries(
      Object.entries(node.$defs).map(([key, value]) => [key, closeSchemaNode(value)]),
    );
  }

  const hasProperties = isPlainObject(node.properties);
  const isObjectType =
    node.type === "object"
    || (Array.isArray(node.type) && node.type.includes("object"))
    || hasProperties
    || node.additionalProperties !== undefined;

  if (hasProperties) {
    const props = node.properties as Record<string, unknown>;
    const wasRequired = originalRequiredNames(node);
    const closedProps: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      required.push(name);
      closedProps[name] = closePropertySchema(propSchema, !wasRequired.has(name));
    }
    out.properties = closedProps;
    out.required = required;
    out.additionalProperties = false;
    if (out.type === undefined) out.type = "object";
    // Object nodes must not also carry residual anyOf from the open copy.
    delete out.anyOf;
  } else if (isObjectType) {
    out.additionalProperties = false;
    if (!Array.isArray(out.required)) out.required = [];
    if (out.type === undefined) out.type = "object";
  } else {
    out = ensureTypedLeaf(out);
  }

  return out;
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
 * New: `exec --approve-for-me … prompt`.
 * Resume: `exec --approve-for-me resume <thread_id> … prompt`.
 * Approval stays on the parent command so new and resumed turns use Codex's
 * automatic review with its workspace-write sandbox.
 */
export function codexTurnArgs(options: {
  readonly prompt: string;
  /** Absolute path for `-c model_instructions_file=…`. */
  readonly systemPromptPath: string;
  /** Absolute path for `--output-schema` (closed transport schema). */
  readonly outputSchemaPath: string;
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
  // Operator config/MCP off; auth still uses CODEX_HOME (official).
  // Project/system config and AGENTS.md have no official suppression switch.
  args.push("--ignore-user-config", "--ignore-rules");
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
  args.push("--output-schema", options.outputSchemaPath);
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

  // Prompt last as positional. `--` stops option parsing so a leading `-`
  // (markdown lists, pasted flags, rulings) is not eaten by clap (codex tip:
  // "use '-- -s'"). Same for new and resume — both end here.
  args.push("--", options.prompt);
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
