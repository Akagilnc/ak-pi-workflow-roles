import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { childSessionManager } from "./activation-ledger-session.js";
import { prepareComplianceDispatch } from "./compliance-transport.js";
import { createStreamIdleGuard } from "./stream-idle-guard.js";
export const AUDITOR_TURN_LIMIT = 8;
export class AuditorTurnLimitError extends Error {
    limit;
    observedTurns;
    lastResponse;
    constructor(limit, observedTurns, lastResponse) {
        super(`Auditor exhausted its ${limit}-turn limit after ${observedTurns} provider turns`);
        this.limit = limit;
        this.observedTurns = observedTurns;
        this.lastResponse = lastResponse;
        this.name = "AuditorTurnLimitError";
    }
}
export async function runAuditorRole(options) {
    const activeModel = options.context.model;
    if (activeModel === undefined)
        throw new Error(`${options.roleLabel} requires an active model`);
    const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.roleLabel);
    if (options.runCompletion !== undefined) {
        const response = await options.runCompletion(dispatch.model, {
            ...dispatch.auth,
            systemPrompt: options.systemPrompt,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const call = response.content.flatMap((part) => part.type === "toolCall" && part.name === options.tool.name ? [part] : [])[0];
        if (call === undefined)
            throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
        await options.tool.execute(call.id, call.arguments, options.signal);
        return { decision: call.arguments, response };
    }
    const parentProvider = options.context.modelRegistry.getProvider(activeModel.provider);
    if (parentProvider === undefined)
        throw new Error(`${options.roleLabel} provider not found: ${activeModel.provider}`);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const idle = createStreamIdleGuard({ ...(options.signal === undefined ? {} : { parentSignal: options.signal }) });
    const provider = { id: parentProvider?.id ?? activeModel.provider, name: parentProvider?.name ?? options.roleLabel, auth: { apiKey: { name: "Inherited auditor authentication", async resolve() { return { auth: { ...dispatch.auth, ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }) } }; } } }, getModels() { return [dispatch.model]; }, stream(model, context, request) { const inheritedRequest = { ...(request ?? {}), ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }), signal: idle.signal }; const upstream = parentProvider.stream(model, context, inheritedRequest); return { async *[Symbol.asyncIterator]() { for await (const event of upstream) {
                idle.poke();
                yield event;
            } }, result: () => upstream.result() }; }, streamSimple(model, context, request) { return this.stream(model, context, request); } };
    runtime.registerNativeProvider(provider);
    const scratch = await mkdtemp(join(tmpdir(), "ak-auditor-role-"));
    let decision;
    let decisionToolFailure;
    try {
        const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const cwd = options.context.cwd ?? process.cwd();
        const loader = new DefaultResourceLoader({ cwd, agentDir: scratch, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: options.systemPrompt });
        await loader.reload();
        const tool = { ...options.tool, label: options.roleLabel, async execute(...args) {
                if (decision !== undefined)
                    throw new Error("Auditor decision was submitted more than once");
                try {
                    const result = await options.tool.execute(...args);
                    decision = args[1];
                    return result;
                }
                catch (error) {
                    decisionToolFailure = error;
                    throw error;
                }
            } };
        const { session } = await createAgentSession({ cwd, agentDir: scratch, model: dispatch.model, thinkingLevel: options.context.thinkingLevel ?? "off", modelRuntime: runtime, resourceLoader: loader, tools: ["read", "grep", "find", "ls", "bash", "write", "edit", tool.name], customTools: [tool], sessionManager: childSessionManager(options.context.sessionManager, cwd, "auditor-roles"), settingsManager: settings });
        let turns = 0;
        let boundaryResponse;
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "assistant" && boundaryResponse === undefined) {
                turns += 1;
                if (turns >= AUDITOR_TURN_LIMIT)
                    boundaryResponse = event.message;
            }
            // Let every tool in the boundary turn settle before stopping. In particular,
            // a decision may share that turn with evidence tools executing in parallel.
            if (event.type === "turn_end" && boundaryResponse !== undefined && decision === undefined)
                void session.abort();
        });
        const abort = () => { void session.abort(); };
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        try {
            try {
                await session.prompt(options.serializedInput);
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw options.signal.reason;
                throw error;
            }
            if (options.signal?.aborted)
                throw options.signal.reason;
            if (idle.signal.aborted)
                throw idle.signal.reason;
            if (decisionToolFailure !== undefined)
                throw decisionToolFailure;
            if (boundaryResponse !== undefined && decision === undefined) {
                if (boundaryResponse.stopReason === "error" || boundaryResponse.stopReason === "aborted")
                    throw boundaryResponse;
                const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
                throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, { stopReason: boundaryResponse.stopReason, toolNames });
            }
            const response = [...session.messages].reverse().find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
            if (response?.stopReason === "error" || response?.stopReason === "aborted")
                throw response;
            if (response === undefined || decision === undefined)
                throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
            return { decision, response };
        }
        finally {
            options.signal?.removeEventListener("abort", abort);
            unsubscribe();
            session.dispose();
        }
    }
    finally {
        idle.dispose();
        await rm(scratch, { recursive: true, force: true });
    }
}
