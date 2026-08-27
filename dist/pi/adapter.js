/** Project Pi's activation context onto the package-owned host contract. */
function projectPiContext(context, transcriptFromContext) {
    const sessionManager = context.sessionManager;
    const host = {
        cwd: context.cwd,
        mode: context.mode,
        model: context.model,
        modelRegistry: {
            getProvider: (provider) => context.modelRegistry.getProvider(provider),
            find: (provider, modelId) => context.modelRegistry.find(provider, modelId),
            getProviderAuth: (provider) => context.modelRegistry.getProviderAuth(provider),
            getApiKeyAndHeaders: (model) => context.modelRegistry.getApiKeyAndHeaders(model),
            refresh: (options) => context.modelRegistry.refresh(options),
        },
        ...(context.thinkingLevel === undefined ? {} : { thinkingLevel: context.thinkingLevel }),
        sessionManager: {
            getLeafEntry: () => context.sessionManager.getLeafEntry(),
            getLeafId: () => context.sessionManager.getLeafId(),
            getEntries: () => context.sessionManager.getEntries(),
            getSessionDir: () => context.sessionManager.getSessionDir(),
            getSessionFile: () => context.sessionManager.getSessionFile(),
            getHeader: () => sessionManager.getHeader(),
            setSessionFile: (path) => sessionManager.setSessionFile(path),
            appendMessage: (message) => sessionManager.appendMessage(message),
            appendCustomEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
        },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.ui === undefined ? {} : { ui: { notify: (message, type) => context.ui.notify(message, type) } }),
        ...(transcriptFromContext === undefined ? {} : { transcript: () => transcriptFromContext(context) }),
        abort: () => context.abort(),
    };
    return host;
}
/** Standalone projection for consumers that never need a reverse boundary conversion. */
export function fromPiContext(context) {
    return projectPiContext(context);
}
function toPiResult(result) {
    return result;
}
/** Project a package-owned tool definition onto Pi's registration/custom-tool contract. */
export function toPiToolDefinition(tool, projectContext = fromPiContext) {
    return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
        parameters: tool.parameters,
        execute: async (toolCallId, params, signal, update, context) => toPiResult(await tool.execute(toolCallId, params, signal, update === undefined ? undefined : (result) => update(toPiResult(result)), projectContext(context))),
    };
}
/** Pi composition boundary. Each consumed capability is adapted explicitly. */
export function createPiRoleHostAdapter(pi, options = {}) {
    const host = {
        registerFlag: (name, definition) => pi.registerFlag(name, definition),
        getFlag: (name) => pi.getFlag(name),
        registerTool: (tool) => pi.registerTool(toPiToolDefinition(tool, (context) => projectPiContext(context, options.transcriptFromContext))),
        getAllTools: () => pi.getAllTools().map(({ name, sourceInfo }) => ({
            name,
            ...(sourceInfo?.path === undefined ? {} : { sourceInfo: { path: sourceInfo.path } }),
        })),
        setActiveTools: (names) => pi.setActiveTools(names),
        getActiveTools: () => pi.getActiveTools(),
        on(event, handler) {
            const register = pi.on;
            register(event, (value, context) => handler(value, projectPiContext(context, options.transcriptFromContext)));
        },
        getCommands: () => pi.getCommands().map(({ name }) => ({ name })),
    };
    return { host };
}
export function createPiRoleHost(pi) {
    return createPiRoleHostAdapter(pi).host;
}
