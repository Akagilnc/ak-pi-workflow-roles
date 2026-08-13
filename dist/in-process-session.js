/**
 * Thin shared in-process AgentSession open (#233).
 * Static Pi imports are safe for Navigator (same module instance as ModelRuntime).
 * Auditor/evidence callers must dynamic-import this module so public-cli bundling
 * does not statically reach @earendil-works/pi-coding-agent.
 */
import { createAgentSession, DefaultResourceLoader, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createRecordSession } from "./sitian-record-entry.js";
function resolveSessionManager(options) {
    if (options.sessionManager !== undefined)
        return options.sessionManager;
    return createRecordSession({
        cwd: options.cwd,
        kind: options.kind,
        ...(options.subject === undefined ? {} : { subject: options.subject }),
        ...(options.parent === undefined ? {} : { parent: options.parent }),
    });
}
/**
 * Single createAgentSession + Settings construction for all in-process children.
 * Child SessionManager construction for identity-declared records lives here so
 * role modules do not call createRecordSession directly.
 */
export async function openInProcessAgentSession(options) {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const sessionManager = resolveSessionManager(options);
    const createArgs = {
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel ?? "off",
        modelRuntime: options.modelRuntime,
        sessionManager,
        settingsManager: settings,
        ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.customTools === undefined ? {} : { customTools: options.customTools }),
    };
    if (options.agentDir !== undefined) {
        const loader = new DefaultResourceLoader({
            cwd: options.cwd,
            agentDir: options.agentDir,
            settingsManager: settings,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        });
        await loader.reload();
        createArgs.agentDir = options.agentDir;
        createArgs.resourceLoader = loader;
    }
    else if (options.systemPrompt !== undefined) {
        throw new Error("openInProcessAgentSession requires agentDir when systemPrompt is set");
    }
    const { session } = await createAgentSession(createArgs);
    return {
        session,
        dispose() {
            session.dispose();
        },
    };
}
