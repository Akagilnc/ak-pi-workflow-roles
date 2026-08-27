import { Type, type TLiteral, type TSchema } from "typebox";

/** Host-neutral result returned by a registered tool. */
export type HostToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  details?: T;
  terminate?: boolean;
  usage?: unknown;
};

export type HostSessionManager = {
  getLeafEntry(): { type: string; message?: { role: string; content: any[] } } | undefined;
  getLeafId(): string | null | undefined;
  getEntries(): Iterable<any>;
  getSessionDir(): string;
  getSessionFile?(): string | undefined;
  appendMessage?(message: any): void;
  appendCustomEntry?(customType: string, data?: unknown): unknown;
};

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = any & {
  cwd: string;
  sessionManager: HostSessionManager;
  abort(): void;
};

export type HostToolDefinition = {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    update: ((result: HostToolResult) => void) | undefined,
    context: HostContext,
  ): Promise<HostToolResult>; 
};

/** The activation surface consumed by package role factories. */
export interface RoleHost {
  registerFlag: (...args: any[]) => any;
  getFlag: (...args: any[]) => any;
  registerTool: (...args: any[]) => any;
  getAllTools: (...args: any[]) => any[];
  setActiveTools: (...args: any[]) => any;
  getActiveTools: (...args: any[]) => string[];
  on: (...args: any[]) => any;
  getCommands?: (...args: any[]) => any[];
  readonly sessionManager?: HostSessionManager;
  readonly abort?: () => void;
}

/** A controlled child session: one prompt/stream/response round at a time. */
export interface ControlledHostSession {
  prompt(input: string, options?: any): Promise<any>;
  subscribe?(listener: (event: any) => void): () => void;
  getEntries?(): readonly any[];
  dispose(): void;
  [key: string]: any;
}

export type OpenControlledHostSession = (options: any) => Promise<{
  session: ControlledHostSession;
  dispose(): void;
}>;

/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum<const V extends readonly string[]>(values: V, options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [TLiteral<V[number]>, ...TLiteral<V[number]>[]], options);
}
