import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { prepareComplianceDispatch } from "./compliance-transport.js";
export class AuditorTurnLimitError extends Error {
    limit;
    constructor(limit) {
        super(`Auditor exceeded ${limit} turns`);
        this.limit = limit;
        this.name = "AuditorTurnLimitError";
    }
}
export async function runAuditorRole(options) {
    const [{ createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager }, { childSessionManager }] = await Promise.all([
        import("@earendil-works/pi-coding-agent"),
        import("./activation-ledger-session.js"),
    ]);
    const activeModel = options.context.model;
    if (activeModel === undefined)
        throw new Error(`${options.roleLabel} requires an active model`);
    const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.roleLabel);
    const parentProvider = options.runCompletion === undefined
        ? options.context.modelRegistry.getProvider(activeModel.provider)
        : undefined;
    if (parentProvider === undefined && options.runCompletion === undefined)
        throw new Error(`${options.roleLabel} provider not found: ${activeModel.provider}`);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const provider = { id: parentProvider?.id ?? activeModel.provider, name: parentProvider?.name ?? options.roleLabel, auth: { apiKey: { name: "Inherited auditor authentication", async resolve() { const { env, ...auth } = dispatch.auth; return { auth: { ...auth, ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }) }, ...(env === undefined ? {} : { env }) }; } } }, getModels() { return [dispatch.model]; }, stream(model, context, request) { if (options.runCompletion !== undefined) {
            const promise = options.runCompletion(model, context, (request ?? {}));
            return { async *[Symbol.asyncIterator]() { }, result: () => promise };
        } return parentProvider.stream(model, context, request); }, streamSimple(model, context, request) { return parentProvider.streamSimple(model, context, request); } };
    runtime.registerNativeProvider(provider);
    const scratch = await mkdtemp(join(tmpdir(), "ak-auditor-role-"));
    let decision;
    try {
        const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const cwd = options.context.cwd ?? process.cwd();
        const loader = new DefaultResourceLoader({ cwd, agentDir: scratch, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: options.systemPrompt });
        await loader.reload();
        const tool = { ...options.tool, label: options.roleLabel, async execute(...args) { if (decision !== undefined)
                throw new Error("Auditor decision was submitted more than once"); decision = args[1]; return options.tool.execute(...args); } };
        const { session } = await createAgentSession({ cwd, agentDir: scratch, model: dispatch.model, thinkingLevel: options.context.thinkingLevel ?? "off", modelRuntime: runtime, resourceLoader: loader, tools: ["read", "grep", "find", "ls", "bash", "write", "edit", tool.name], customTools: [tool], sessionManager: childSessionManager(options.context.sessionManager, cwd, "auditor-roles"), settingsManager: settings });
        const turnLimit = 32;
        let turns = 0;
        let turnError;
        const unsubscribe = session.subscribe((event) => { if (event.type === "message_end" && event.message.role === "assistant" && ++turns > turnLimit) {
            turnError = new AuditorTurnLimitError(turnLimit);
            void session.abort();
        } });
        const abort = () => { void session.abort(); };
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        try {
            await session.prompt(options.serializedInput);
        }
        finally {
            options.signal?.removeEventListener("abort", abort);
            unsubscribe();
        }
        if (turnError !== undefined)
            throw turnError;
        const response = [...session.messages].reverse().find((message) => message.role === "assistant");
        session.dispose();
        if (response !== undefined)
            options.retainResponse?.(response);
        if (response === undefined || response.stopReason === "error" || response.stopReason === "aborted" || decision === undefined)
            throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
        return { decision, response };
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
