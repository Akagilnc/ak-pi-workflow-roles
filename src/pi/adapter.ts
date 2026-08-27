import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  HostContext,
  HostEventMap,
  HostToolDefinition,
  HostToolResult,
  RoleHost,
} from "../host-contracts.ts";

const piContexts = new WeakMap<HostContext, ExtensionContext>();

/** Project Pi's activation context onto the package-owned host contract. */
export function fromPiContext(context: ExtensionContext): HostContext {
  const host: HostContext = {
    cwd: context.cwd,
    mode: context.mode,
    sessionManager: context.sessionManager,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    abort: () => context.abort(),
  };
  piContexts.set(host, context);
  return host;
}

/** Recover the Pi context paired with a host projection at the composition boundary. */
export function toPiContext(context: HostContext): ExtensionContext {
  const pi = piContexts.get(context);
  if (pi === undefined) throw new Error("Host context did not originate at the Pi adapter boundary");
  return pi;
}

function toPiResult<D>(result: HostToolResult<D>): AgentToolResult<D> {
  return result as AgentToolResult<D>;
}

/** Project a package-owned tool definition onto Pi's registration/custom-tool contract. */
export function toPiToolDefinition<S extends TSchema, D>(tool: HostToolDefinition<S, D>): ToolDefinition<S, D> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters,
    execute: async (toolCallId, params, signal, update, context) =>
      toPiResult(await tool.execute(
        toolCallId,
        params,
        signal,
        update === undefined ? undefined : (result) => update(toPiResult(result)),
        fromPiContext(context),
      )),
  };
}

/** Pi composition boundary. Each consumed capability is adapted explicitly. */
export function createPiRoleHost(pi: ExtensionAPI): RoleHost {
  return {
    registerFlag: (name, definition) => pi.registerFlag(name, definition),
    getFlag: (name) => pi.getFlag(name),
    registerTool: (tool) => pi.registerTool(toPiToolDefinition(tool)),
    getAllTools: () => pi.getAllTools().map(({ name, sourceInfo }) => ({
      name,
      ...(sourceInfo?.path === undefined ? {} : { sourceInfo: { path: sourceInfo.path } }),
    })),
    setActiveTools: (names) => pi.setActiveTools(names),
    getActiveTools: () => pi.getActiveTools(),
    on(event, handler) {
      const register = pi.on as <K extends keyof HostEventMap>(
        event: K,
        handler: (event: HostEventMap[K], context: ExtensionContext) => unknown,
      ) => void;
      register(event, (value, context) => handler(value, fromPiContext(context)));
    },
    getCommands: () => pi.getCommands().map(({ name }) => ({ name })),
  };
}
