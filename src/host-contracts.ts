import { Type, type Static, type TLiteral, type TSchema } from "typebox";

export type HostContentPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments?: unknown }
  | { type: string; [key: string]: unknown };

export type HostMessage = {
  role: string;
  content: readonly HostContentPart[];
  toolName?: string;
  isError?: boolean;
};

export type HostSessionEntry =
  | { type: "message"; message: HostMessage; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type HostToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  details?: T;
  terminate?: boolean;
  usage?: unknown;
};

export type HostSessionManager = {
  getLeafEntry(): HostSessionEntry | undefined;
  getLeafId(): string | null | undefined;
  getEntries(): Iterable<HostSessionEntry>;
  getSessionDir(): string;
  getSessionFile?(): string | undefined;
  appendMessage?(message: HostMessage): void;
  appendCustomEntry?(customType: string, data?: unknown): unknown;
};

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = {
  cwd: string;
  sessionManager: HostSessionManager;
  signal?: AbortSignal;
  abort(): void;
};

export type HostToolDefinition<S extends TSchema = TSchema, D = unknown> = {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  parameters: S;
  execute(
    toolCallId: string,
    params: Static<S>,
    signal: AbortSignal | undefined,
    update: ((result: HostToolResult<D>) => void) | undefined,
    context: HostContext,
  ): Promise<HostToolResult<D>>;
};

type BeforeAgentStartEvent = { prompt: string; systemPrompt: string; systemPromptOptions?: unknown };
type InputEvent = { text: string; images?: readonly unknown[]; source?: string };
type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type ToolResultEvent = { toolName: string; toolCallId: string; isError: boolean; content?: readonly HostContentPart[]; details?: unknown };
type SessionStartEvent = { reason: string };
type ProviderResponseEvent = { status?: number };
type AgentEndEvent = { messages: readonly HostMessage[] };
type ToolExecutionEvent = { toolName: string; toolCallId: string };

export type HostEventMap = {
  before_agent_start: BeforeAgentStartEvent;
  input: InputEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  session_start: SessionStartEvent;
  session_shutdown: Record<never, never>;
  after_provider_response: ProviderResponseEvent;
  agent_end: AgentEndEvent;
  agent_settled: Record<never, never>;
  tool_execution_start: ToolExecutionEvent;
  tool_execution_update: ToolExecutionEvent;
  tool_execution_end: ToolExecutionEvent;
};

/** The activation surface consumed by package role factories. */
export interface RoleHost {
  registerFlag(name: string, definition: { description: string; type: "boolean" | "string"; default?: boolean | string }): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool<S extends TSchema, D = unknown>(tool: HostToolDefinition<S, D>): void;
  getAllTools(): HostToolDefinition[];
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  on<K extends keyof HostEventMap>(event: K, handler: (event: HostEventMap[K], ctx: HostContext) => unknown): void;
  getCommands(): Array<{ name: string; [key: string]: unknown }>;
  readonly sessionManager?: HostSessionManager;
  readonly abort?: () => void;
}

export function isHostToolCall(part: { type: string }): part is { type: "toolCall"; id: string; name: string } {
  return part.type === "toolCall";
}

/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum<const V extends readonly string[]>(values: V, options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [TLiteral<V[number]>, ...TLiteral<V[number]>[]], options);
}
