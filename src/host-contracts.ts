import type { AgentToolResult, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TLiteral, type TSchema } from "typebox";

/** Host-neutral result returned by a registered tool. */
export type HostToolResult<T = unknown> = AgentToolResult<T> & {
  terminate?: boolean;
  usage?: unknown;
};

export type HostSessionManager = ExtensionContext["sessionManager"];

/** Context supplied by a host for one activation and its interceptable events. */
export type HostContext = ExtensionContext;

export type HostToolDefinition<S extends TSchema = TSchema, D = unknown> = ToolDefinition<S, D>;

/** The activation surface consumed by package role factories. */
export interface RoleHost extends Pick<ExtensionAPI,
  "registerFlag" | "getFlag" | "registerTool" | "getAllTools" | "setActiveTools" | "getActiveTools" | "on" | "getCommands"
> {
  readonly sessionManager?: HostSessionManager;
  readonly abort?: () => void;
}

/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum<const V extends readonly string[]>(values: V, options: Record<string, unknown> = {}) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [TLiteral<V[number]>, ...TLiteral<V[number]>[]], options);
}
