import { Type, type Static, type TLiteral, type TSchema } from "typebox";

type HostContentPart = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments?: unknown } | { type: string };
type HostMessage = { role: string; content?: unknown; toolName?: string; isError?: boolean; stopReason?: string };
type HostEventMessage = { role: string; content: readonly HostContentPart[]; toolName?: string; isError?: boolean; stopReason?: string };
type HostSessionEntry = { type: string; message?: HostMessage };

export type HostToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: T;
  terminate?: boolean;
};

type HostSessionManager = { getLeafEntry(): HostSessionEntry | undefined; getLeafId(): string | null | undefined; getEntries(): Iterable<HostSessionEntry>; getSessionDir(): string; getSessionFile(): string | undefined; getHeader?(): { readonly type: string; readonly id?: string } | null; setSessionFile?(path: string): void; appendCustomEntry?(customType: string, data?: unknown): unknown; };

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = { cwd: string; mode: string; model: { readonly provider: string } | undefined; sessionManager: HostSessionManager; signal?: AbortSignal | undefined; ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void }; transcript?(): string; abort(): void; };

export type HostNativeToolContext = Pick<HostContext, "cwd" | "mode" | "abort">;
export type HostToolDefinition<S extends TSchema = TSchema, D = unknown, C = HostContext> = { name: string; label: string; description: string; promptSnippet?: string; parameters: S; execute( toolCallId: string, params: Static<S>, signal: AbortSignal | undefined, update: ((result: HostToolResult<D>) => void) | undefined, context: C, ): Promise<HostToolResult<D>>; };

type BeforeAgentStartEvent = { prompt: string; systemPrompt: string; systemPromptOptions: { skills?: readonly unknown[]; contextFiles?: readonly unknown[]; appendSystemPrompt?: string } };
type InputEvent = { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; source?: string };
type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type ToolResultEvent = { toolName: string; toolCallId: string; isError: boolean; content: HostToolResult["content"]; details: unknown };
type SessionStartEvent = { reason: string };
type ProviderResponseEvent = { status?: number };
type AgentEndEvent = { messages: readonly HostEventMessage[] };
type ToolExecutionEvent = { toolName: string; toolCallId: string };
type ToolExecutionUpdateEvent = ToolExecutionEvent & { partialResult: unknown };
type ToolExecutionEndEvent = ToolExecutionEvent & { isError: boolean };

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
  tool_execution_update: ToolExecutionUpdateEvent;
  tool_execution_end: ToolExecutionEndEvent;
};

type HostInputResult = { action: "continue" } | { action: "transform"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> } | { action: "handled" };
type HostEventResultMap = {
  before_agent_start: { systemPrompt?: string };
  input: HostInputResult;
  tool_call: { block?: boolean; reason?: string; terminate?: boolean };
  tool_result: { content?: HostToolResult["content"]; details?: unknown; isError?: boolean };
  session_start: void;
  session_shutdown: void;
  after_provider_response: void;
  agent_end: void;
  agent_settled: void;
  tool_execution_start: void;
  tool_execution_update: void;
  tool_execution_end: void;
};
type HostEventHandler<K extends keyof HostEventMap> = (event: HostEventMap[K], ctx: HostContext) => HostEventResultMap[K] | void | Promise<HostEventResultMap[K] | void>;
export type HostEventRegistration = { [K in keyof HostEventMap]: [event: K, handler: HostEventHandler<K>] }[keyof HostEventMap];

/** The activation surface consumed by package role factories. */
export interface RoleHost {
  registerFlag(name: string, definition: { description: string; type: "boolean" | "string"; default?: boolean | string }): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool<S extends TSchema, D = unknown>(tool: HostToolDefinition<S, D>): void;
  registerNativeTool<S extends TSchema, D = unknown>(tool: HostToolDefinition<S, D, HostNativeToolContext>): void;
  getAllTools(): Array<{ name: string; sourceInfo?: { path?: string } }>;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  on(event: "before_agent_start", handler: HostEventHandler<"before_agent_start">): void;
  on(event: "input", handler: HostEventHandler<"input">): void;
  on(event: "tool_call", handler: HostEventHandler<"tool_call">): void;
  on(event: "tool_result", handler: HostEventHandler<"tool_result">): void;
  on(event: "session_start", handler: HostEventHandler<"session_start">): void;
  on(event: "session_shutdown", handler: HostEventHandler<"session_shutdown">): void;
  on(event: "after_provider_response", handler: HostEventHandler<"after_provider_response">): void;
  on(event: "agent_end", handler: HostEventHandler<"agent_end">): void;
  on(event: "agent_settled", handler: HostEventHandler<"agent_settled">): void;
  on(event: "tool_execution_start", handler: HostEventHandler<"tool_execution_start">): void;
  on(event: "tool_execution_update", handler: HostEventHandler<"tool_execution_update">): void;
  on(event: "tool_execution_end", handler: HostEventHandler<"tool_execution_end">): void;
  getCommands?(): Array<{ name: string }>;
}

/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum<const V extends readonly string[]>(values: V, options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [TLiteral<V[number]>, ...TLiteral<V[number]>[]], options);
}
