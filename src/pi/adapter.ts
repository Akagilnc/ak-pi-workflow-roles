import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { requireGatekeeperPass, type GatekeeperNonPassResult, type GatekeeperSubject } from "../gatekeeper-role.ts";
import type {
  HostContext,
  HostEventRegistration,
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
      getLeafEntry: () => context.sessionManager.getLeafEntry(),
      getLeafId: () => context.sessionManager.getLeafId(),
      getEntries: () => context.sessionManager.getEntries(),
      getSessionDir: () => context.sessionManager.getSessionDir(),
      getSessionFile: () => context.sessionManager.getSessionFile(),
      getHeader: () => context.sessionManager.getHeader(),
      setSessionFile: (path) => sessionManager.setSessionFile(path),
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

/** Pi composition boundary. Each consumed capability is adapted explicitly. */
export function createPiRoleHostAdapter(
  pi: ExtensionAPI,
  options: { transcriptFromContext?: (context: ExtensionContext) => string } = {},
): PiRoleHostAdapter {
  const host: RoleHost = {
    registerFlag: (name, definition) => pi.registerFlag(name, definition),
    getFlag: (name) => pi.getFlag(name),
    registerTool: (tool) => pi.registerTool(tool),
    getAllTools: () => pi.getAllTools().map(({ name, sourceInfo }) => ({
      name,
      ...(sourceInfo?.path === undefined ? {} : { sourceInfo: { path: sourceInfo.path } }),
    })),
    setActiveTools: (names) => pi.setActiveTools(names),
    getActiveTools: () => pi.getActiveTools(),
    on(...registration: HostEventRegistration) {
      const context = (value: ExtensionContext) => projectPiContext(value, options.transcriptFromContext);
      if (registration[0] === "before_agent_start") {
        const [, handler] = registration;
        pi.on("before_agent_start", (value, ctx) => handler({ prompt: value.prompt, systemPrompt: value.systemPrompt, systemPromptOptions: value.systemPromptOptions }, context(ctx)));
      } else if (registration[0] === "input") {
        const [, handler] = registration;
        pi.on("input", (value, ctx) => handler({ text: value.text, ...(value.images === undefined ? {} : { images: value.images }), source: value.source }, context(ctx)));
      } else if (registration[0] === "tool_call") {
        const [, handler] = registration;
        pi.on("tool_call", (value, ctx) => handler({ toolName: value.toolName, toolCallId: value.toolCallId, input: value.input }, context(ctx)));
      } else if (registration[0] === "tool_result") {
        const [, handler] = registration;
        pi.on("tool_result", (value, ctx) => handler({ toolName: value.toolName, toolCallId: value.toolCallId, isError: value.isError, content: (value.content ?? []).map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image", data: part.data, mimeType: part.mimeType }), details: value.details }, context(ctx)));
      } else if (registration[0] === "session_start") {
        const [, handler] = registration;
        pi.on("session_start", (value, ctx) => handler({ reason: value.reason }, context(ctx)));
      } else if (registration[0] === "session_shutdown") {
        const [, handler] = registration;
        pi.on("session_shutdown", (_value, ctx) => handler({}, context(ctx)));
      } else if (registration[0] === "after_provider_response") {
        const [, handler] = registration;
        pi.on("after_provider_response", (value, ctx) => handler({ status: value.status }, context(ctx)));
      } else if (registration[0] === "agent_end") {
        const [, handler] = registration;
        pi.on("agent_end", (value, ctx) => handler({
        messages: value.messages.map((message) => ({
          role: message.role,
          content: "content" in message && Array.isArray(message.content) ? message.content.map((part) => part.type === "text"
            ? { type: "text", text: part.text }
            : part.type === "toolCall"
              ? { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments }
              : { type: part.type }) : [],
        })),
      }, context(ctx)));
      } else if (registration[0] === "agent_settled") {
        const [, handler] = registration;
        pi.on("agent_settled", (_value, ctx) => handler({}, context(ctx)));
      } else if (registration[0] === "tool_execution_start") {
        const [, handler] = registration;
        pi.on("tool_execution_start", (value, ctx) => handler({ toolName: value.toolName, toolCallId: value.toolCallId }, context(ctx)));
      } else if (registration[0] === "tool_execution_update") {
        const [, handler] = registration;
        pi.on("tool_execution_update", (value, ctx) => handler({ toolName: value.toolName, toolCallId: value.toolCallId, partialResult: value.partialResult }, context(ctx)));
      } else {
        const [, handler] = registration;
        pi.on("tool_execution_end", (value, ctx) => handler({ toolName: value.toolName, toolCallId: value.toolCallId, isError: value.isError }, context(ctx)));
      }
    },
    ...(typeof pi.getCommands === "function" ? { getCommands: () => pi.getCommands().map(({ name }) => ({ name })) } : {}),
  };
  return { host };
}

export function createPiRoleHost(pi: ExtensionAPI): RoleHost {
  return createPiRoleHostAdapter(pi).host;
}
