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
    const settings = SettingsManager.inMemory(options.settings ?? { compaction: { enabled: false }, retry: { enabled: false } });
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
    if (options.agentDir !== undefined || options.systemPrompt !== undefined) {
        const { mkdtemp } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const agentDir = options.agentDir ?? (await mkdtemp(join(tmpdir(), "ak-in-process-child-")));
        const loader = new DefaultResourceLoader({
            cwd: options.cwd,
            agentDir,
            settingsManager: settings,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        });
        await loader.reload();
        createArgs.agentDir = agentDir;
        createArgs.resourceLoader = loader;
    }
    const { session } = await createAgentSession(createArgs);
    return {
        session,
        dispose() {
            session.dispose();
        },
    };
}
