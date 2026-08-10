/**
 * Thin shared in-process AgentSession open (#233).
 * Static Pi imports are safe for Navigator (same module instance as ModelRuntime).
 * Auditor/evidence callers must dynamic-import this module so public-cli bundling
 * does not statically reach @earendil-works/pi-coding-agent.
 */
import { createAgentSession, DefaultResourceLoader, SettingsManager, } from "@earendil-works/pi-coding-agent";
/**
 * Single createAgentSession + Settings construction for all in-process children.
 */
export async function openInProcessAgentSession(options) {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const createArgs = {
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel ?? "off",
        modelRuntime: options.modelRuntime,
        sessionManager: options.sessionManager,
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
