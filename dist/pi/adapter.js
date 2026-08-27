const projectedPiContexts = new WeakMap();
/** Composition-root-only native context resolution for Pi-backed dependencies. */
export function resolvePiContextAtCompositionRoot(context) {
    const native = projectedPiContexts.get(context);
    if (native === undefined)
        throw new Error("Host context did not originate at a Pi adapter boundary");
    return native;
}
/** Project Pi's activation context onto the package-owned host contract. */
function projectPiContext(context, contexts) {
    const host = {
        cwd: context.cwd,
        mode: context.mode,
        sessionManager: {
            getLeafEntry: () => context.sessionManager.getLeafEntry(),
            getLeafId: () => context.sessionManager.getLeafId(),
            getEntries: () => context.sessionManager.getEntries(),
            getSessionDir: () => context.sessionManager.getSessionDir(),
            getSessionFile: () => context.sessionManager.getSessionFile(),
            getHeader: () => context.sessionManager.getHeader(),
            setSessionFile: (path) => context.sessionManager.setSessionFile(path),
            appendMessage: (message) => context.sessionManager.appendMessage(message),
            appendCustomEntry: (customType, data) => context.sessionManager.appendCustomEntry(customType, data),
        },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        abort: () => context.abort(),
    };
    contexts.set(host, context);
    projectedPiContexts.set(host, context);
    return host;
}
/** Standalone projection for consumers that never need a reverse boundary conversion. */
export function fromPiContext(context) {
    return projectPiContext(context, new WeakMap());
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
export function createPiRoleHostAdapter(pi) {
    const contexts = new WeakMap();
    const host = {
        registerFlag: (name, definition) => pi.registerFlag(name, definition),
        getFlag: (name) => pi.getFlag(name),
        registerTool: (tool) => pi.registerTool(toPiToolDefinition(tool, (context) => projectPiContext(context, contexts))),
        getAllTools: () => pi.getAllTools().map(({ name, sourceInfo }) => ({
            name,
            ...(sourceInfo?.path === undefined ? {} : { sourceInfo: { path: sourceInfo.path } }),
        })),
        setActiveTools: (names) => pi.setActiveTools(names),
        getActiveTools: () => pi.getActiveTools(),
        on(event, handler) {
            const register = pi.on;
            register(event, (value, context) => handler(value, projectPiContext(context, contexts)));
        },
        getCommands: () => pi.getCommands().map(({ name }) => ({ name })),
    };
    return {
        host,
        resolveContext(context) {
            const native = contexts.get(context);
            if (native === undefined)
                throw new Error("Host context did not originate at this Pi adapter boundary");
            return native;
        },
    };
}
export function createPiRoleHost(pi) {
    return createPiRoleHostAdapter(pi).host;
}
