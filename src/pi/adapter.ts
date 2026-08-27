import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { requireGatekeeperPass, type GatekeeperNonPassResult, type GatekeeperSubject } from "../gatekeeper-role.ts";
import type {
  HostContext,
  HostEventMap,
  HostToolDefinition,
  HostToolResult,
  RoleHost,
} from "../host-contracts.ts";

export type PiRoleHostAdapter = {
  readonly host: RoleHost;
};

const piContexts = new WeakMap<HostContext, ExtensionContext>();

/** Project Pi's activation context onto the package-owned host contract. */
function projectPiContext(context: ExtensionContext, transcriptFromContext?: (context: ExtensionContext) => string): HostContext {
  const sessionManager = context.sessionManager as SessionManager;
  const host: HostContext = {
    cwd: context.cwd,
    mode: context.mode,
    model: context.model === undefined ? undefined : { provider: context.model.provider },
    sessionManager: {
      getLeafEntry: () => context.sessionManager.getLeafEntry() as ReturnType<HostContext["sessionManager"]["getLeafEntry"]>,
      getLeafId: () => context.sessionManager.getLeafId(),
      getEntries: () => context.sessionManager.getEntries() as ReturnType<HostContext["sessionManager"]["getEntries"]>,
      getSessionDir: () => context.sessionManager.getSessionDir(),
      getSessionFile: () => context.sessionManager.getSessionFile(),
      getHeader: () => sessionManager.getHeader(),
      setSessionFile: (path) => sessionManager.setSessionFile(path),
      appendMessage: (message) => sessionManager.appendMessage(
        message as Parameters<SessionManager["appendMessage"]>[0],
      ),
      appendCustomEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.ui === undefined ? {} : { ui: { notify: (message, type) => context.ui.notify(message, type) } }),
    ...(transcriptFromContext === undefined ? {} : { transcript: () => transcriptFromContext(context) }),
    abort: () => context.abort(),
  };
  piContexts.set(host, context);
  return host;
}

/** Recover the Pi context only at the Pi composition boundary. */
export function toPiContext(context: HostContext): ExtensionContext {
  const piContext = piContexts.get(context);
  if (piContext === undefined) throw new Error("Host context is not backed by the Pi adapter");
  return piContext;
}

export type HostGatekeeperActions = {
  failInfrastructure(error: unknown, context: HostContext, toolCallId?: string): never;
  bindGatekeeperNonPass(toolCallId: string, result: GatekeeperNonPassResult): void;
};

/** Keep the S3 Gatekeeper executor on its native Pi context until S3 owns that migration. */
export function requirePiGatekeeperPass(options: {
  context: HostContext;
  subject: GatekeeperSubject;
  signal?: AbortSignal;
  hostActions: HostGatekeeperActions;
  toolCallId: string;
}): Promise<void> {
  return requireGatekeeperPass({
    context: toPiContext(options.context),
    subject: options.subject,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    hostActions: {
      failInfrastructure(error, context, toolCallId) {
        options.hostActions.failInfrastructure(error, projectPiContext(context), toolCallId);
      },
      bindGatekeeperNonPass: options.hostActions.bindGatekeeperNonPass,
    },
    toolCallId: options.toolCallId,
  });
}

/** Standalone projection for consumers that never need a reverse boundary conversion. */
export function fromPiContext(context: ExtensionContext): HostContext {
  return projectPiContext(context);
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
export function createPiRoleHostAdapter(
  pi: ExtensionAPI,
  options: { transcriptFromContext?: (context: ExtensionContext) => string } = {},
): PiRoleHostAdapter {
  const host: RoleHost = {
    registerFlag: (name, definition) => pi.registerFlag(name, definition),
    getFlag: (name) => pi.getFlag(name),
    registerTool: (tool) => pi.registerTool(toPiToolDefinition(
      tool,
      (context) => projectPiContext(context, options.transcriptFromContext),
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
      register(event, (value, context) => handler(value, projectPiContext(context, options.transcriptFromContext)));
    },
    getCommands: () => pi.getCommands().map(({ name }) => ({ name })),
  };
  return { host };
}

export function createPiRoleHost(pi: ExtensionAPI): RoleHost {
  return createPiRoleHostAdapter(pi).host;
}
