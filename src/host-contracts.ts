import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { Type, type Static, type TLiteral, type TSchema } from "typebox";

export type HostContentPart = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments?: unknown } | { type: string };
export type HostMessage = { role: string; content: readonly HostContentPart[]; toolName?: string; isError?: boolean; stopReason?: string };
export type HostSessionEntry = { type: string; message?: HostMessage };

export type HostToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: T;
  terminate?: boolean;
  usage?: unknown;
};

export type HostSessionManager = { getLeafEntry(): HostSessionEntry | undefined; getLeafId(): string | null | undefined; getEntries(): Iterable<HostSessionEntry>; getSessionDir(): string; getSessionFile(): string | undefined; getHeader?(): { readonly type: string; readonly id?: string } | null; setSessionFile?(path: string): void; appendMessage?(message: HostMessage): void; appendCustomEntry?(customType: string, data?: unknown): unknown; };

export type HostModelRegistry = { getProvider(provider: string): Provider<Api> | undefined; find(provider: string, modelId: string): Model<Api> | undefined; getProviderAuth(provider: string): Promise<{ auth: { baseUrl?: string }; env?: Record<string, string>; } | undefined>; getApiKeyAndHeaders(model: Model<Api>): Promise< | { ok: true; apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string> } | { ok: false; error: string } >; refresh(options?: { allowNetwork?: boolean; providers?: readonly string[]; force?: boolean; signal?: AbortSignal; }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>; };

export type HostChildContext = { cwd: string; model: Model<Api> | undefined; modelRegistry: HostModelRegistry; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; sessionManager: Pick<HostSessionManager, "getSessionFile" | "getLeafId" | "getHeader" | "appendCustomEntry"> & { getEntries(): Iterable<unknown>; }; };

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = { cwd: string; mode: string; model: Model<Api> | undefined; modelRegistry: HostModelRegistry; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; sessionManager: HostSessionManager; signal?: AbortSignal; ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void }; transcript?(): string; abort(): void; };

export type HostToolDefinition<S extends TSchema = TSchema, D = unknown> = { name: string; label: string; description: string; promptSnippet?: string; parameters: S; execute( toolCallId: string, params: Static<S>, signal: AbortSignal | undefined, update: ((result: HostToolResult<D>) => void) | undefined, context: HostContext, ): Promise<HostToolResult<D>>; };

type BeforeAgentStartEvent = { prompt: string; systemPrompt: string; systemPromptOptions: { skills?: readonly unknown[]; contextFiles?: readonly unknown[]; appendSystemPrompt?: string } };
type InputEvent = { text: string; images?: readonly unknown[]; source?: string };
type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type ToolResultEvent = { toolName: string; toolCallId: string; isError: boolean; content: readonly HostContentPart[]; details: unknown };
type SessionStartEvent = { reason: string };
type ProviderResponseEvent = { status?: number };
type AgentEndEvent = { messages: readonly HostMessage[] };
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

/** The activation surface consumed by package role factories. */
export interface RoleHost { registerFlag(name: string, definition: { description: string; type: "boolean" | "string"; default?: boolean | string }): void; getFlag(name: string): boolean | string | undefined; registerTool<S extends TSchema, D = unknown>(tool: HostToolDefinition<S, D>): void; getAllTools(): Array<{ name: string; sourceInfo?: { path?: string } }>; setActiveTools(names: string[]): void; getActiveTools(): string[]; on<K extends keyof HostEventMap>(event: K, handler: (event: HostEventMap[K], ctx: HostContext) => unknown): void; getCommands(): Array<{ name: string }>; readonly sessionManager?: HostSessionManager; readonly abort?: () => void; }

/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum<const V extends readonly string[]>(values: V, options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [TLiteral<V[number]>, ...TLiteral<V[number]>[]], options);
}
