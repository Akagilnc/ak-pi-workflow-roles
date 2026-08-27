import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type {
  HostContext,
  HostEventMap,
  HostToolDefinition,
  HostToolResult,
  RoleHost,
} from "../host-contracts.ts";

export type PiRoleHostAdapter = {
  readonly host: RoleHost;
  resolveContext(context: HostContext): ExtensionContext;
};

/** Project Pi's activation context onto the package-owned host contract. */
function projectPiContext(context: ExtensionContext, contexts: WeakMap<HostContext, ExtensionContext>): HostContext {
  const host: HostContext = {
    cwd: context.cwd,
    mode: context.mode,
    sessionManager: {
      getLeafEntry: () => context.sessionManager.getLeafEntry() as ReturnType<HostContext["sessionManager"]["getLeafEntry"]>,
      getLeafId: () => context.sessionManager.getLeafId(),
      getEntries: () => context.sessionManager.getEntries() as ReturnType<HostContext["sessionManager"]["getEntries"]>,
      getSessionDir: () => context.sessionManager.getSessionDir(),
      getSessionFile: () => context.sessionManager.getSessionFile(),
      getHeader: () => (context.sessionManager as any).getHeader(),
      setSessionFile: (path) => (context.sessionManager as any).setSessionFile(path),
      appendMessage: (message) => (context.sessionManager as any).appendMessage(message),
      appendCustomEntry: (customType, data) => (context.sessionManager as any).appendCustomEntry(customType, data),
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    abort: () => context.abort(),
  };
  contexts.set(host, context);
  return host;
}

/** Standalone projection for consumers that never need a reverse boundary conversion. */
export function fromPiContext(context: ExtensionContext): HostContext {
  return projectPiContext(context, new WeakMap());
}

function toPiResult<D>(result: HostToolResult<D>): AgentToolResult<D> {
  return result as AgentToolResult<D>;
}

/** Project a package-owned tool definition onto Pi's registration/custom-tool contract. */
export function toPiToolDefinition<S extends TSchema, D>(
  tool: HostToolDefinition<S, D>,
  projectContext: (context: ExtensionContext) => HostContext = fromPiContext,
): ToolDefinition<S, D> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters,
    execute: async (toolCallId, params, signal, update, context) =>
      toPiResult(await tool.execute(
        toolCallId,
        params as Static<S>,
        signal,
        update === undefined ? undefined : (result) => update(toPiResult(result)),
        projectContext(context),
      )),
  };
}

/** Pi composition boundary. Each consumed capability is adapted explicitly. */
export function createPiRoleHostAdapter(pi: ExtensionAPI): PiRoleHostAdapter {
  const contexts = new WeakMap<HostContext, ExtensionContext>();
  const host: RoleHost = {
    registerFlag: (name, definition) => pi.registerFlag(name, definition),
    getFlag: (name) => pi.getFlag(name),
    registerTool: (tool) => pi.registerTool(toPiToolDefinition(
      tool,
      (context) => projectPiContext(context, contexts),
    )),
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
      register(event, (value, context) => handler(value, projectPiContext(context, contexts)));
    },
    getCommands: () => pi.getCommands().map(({ name }) => ({ name })),
  };
  return {
    host,
    resolveContext(context) {
      const native = contexts.get(context);
      if (native === undefined) throw new Error("Host context did not originate at this Pi adapter boundary");
      return native;
    },
  };
}

export function createPiRoleHost(pi: ExtensionAPI): RoleHost {
  return createPiRoleHostAdapter(pi).host;
}
