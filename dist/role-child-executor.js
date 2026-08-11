import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { wrapPackageOwnedToolDefinition } from "./package-owned-tool-idle.js";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.js";
export const AUDITOR_TURN_LIMIT = 8;
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
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
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding";
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure";
export async function prepareComplianceDispatch(model, context, label) {
    const resolution = await context.modelRegistry.getProviderAuth(model.provider).catch((error) => { throw new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
    if (resolution === undefined)
        throw new Error(`${label} authentication failed: provider is not configured: ${model.provider}`);
    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
        throw new Error(`${label} authentication failed: ${auth.error}`);
    const env = auth.env ?? resolution.env;
    return { model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model, auth: { ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }), ...(auth.headers === undefined ? {} : { headers: auth.headers }), ...(env === undefined ? {} : { env }) } };
}
function abortReason(signal) {
    return signal.reason ?? new Error("Auditor provider stream aborted");
}
async function waitForStream(promise, signal) {
    if (signal.aborted)
        throw abortReason(signal);
    let onAbort;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                onAbort = () => reject(abortReason(signal));
                signal.addEventListener("abort", onAbort, { once: true });
            }),
        ]);
    }
    finally {
        if (onAbort !== undefined)
            signal.removeEventListener("abort", onAbort);
    }
}
export async function executeAuditorChild(options) {
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
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    let streamFailure;
    const createRetriedStream = (simple, model, context, request) => {
        const wrapped = createAssistantMessageEventStream();
        void (async () => {
            for (let attempt = 0;; attempt += 1) {
                const idle = createStreamIdleGuard(options.signal === undefined ? {} : { parentSignal: options.signal });
                try {
                    const inheritedRequest = { ...(request ?? {}), ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }), signal: idle.signal };
                    if (options.runCompletion !== undefined) {
                        const response = await waitForStream(options.runCompletion(model, context, inheritedRequest), idle.signal);
                        wrapped.end(response);
                        return;
                    }
                    const source = simple
                        ? parentProvider.streamSimple(model, context, inheritedRequest)
                        : parentProvider.stream(model, context, inheritedRequest);
                    let sawEvent = false;
                    const iterator = source[Symbol.asyncIterator]();
                    while (true) {
                        const next = await waitForStream(iterator.next(), idle.signal);
                        if (next.done)
                            break;
                        sawEvent = true;
                        idle.poke();
                        wrapped.push(next.value);
                    }
                    const response = await waitForStream(source.result(), idle.signal);
                    if (!sawEvent)
                        wrapped.end(response);
                    return;
                }
                catch (error) {
                    const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
                    if (isStreamIdleTimeoutError(failure) && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES && options.signal?.aborted !== true)
                        continue;
                    streamFailure = failure;
                    const response = {
                        role: "assistant",
                        content: [],
                        api: model.api,
                        provider: model.provider,
                        model: model.id,
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                        stopReason: "error",
                        errorMessage: failure instanceof Error ? failure.message : String(failure),
                        timestamp: Date.now(),
                    };
                    wrapped.push({ type: "error", reason: "error", error: response });
                    return;
                }
                finally {
                    idle.dispose();
                }
            }
        })();
        return wrapped;
    };
    const provider = {
        id: parentProvider?.id ?? activeModel.provider,
        name: parentProvider?.name ?? options.roleLabel,
        auth: {
            apiKey: {
                name: "Inherited auditor authentication",
                async resolve() {
                    const { env, ...auth } = dispatch.auth;
                    return { auth: { ...auth, ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }) }, ...(env === undefined ? {} : { env }) };
                },
            },
        },
        getModels() { return [dispatch.model]; },
        stream(model, context, request) { return createRetriedStream(false, model, context, request); },
        streamSimple(model, context, request) { return createRetriedStream(true, model, context, request); },
    };
    runtime.registerNativeProvider(provider);
    const scratch = await mkdtemp(join(tmpdir(), "ak-auditor-role-"));
    let decision;
    let decisionToolFailure;
    try {
        const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const cwd = options.context.cwd ?? process.cwd();
        // ADR 0064: evidence roles have unrestricted tools. Do not close extension
        // sources or pass a fixed tools allowlist (omitting tools degrades to Pi's
        // default four). Enable every tool the real session registry exposes.
        const loader = new DefaultResourceLoader({ cwd, agentDir: scratch, settingsManager: settings, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: options.systemPrompt });
        await loader.reload();
        const tool = wrapPackageOwnedToolDefinition({
            ...options.tool,
            label: options.roleLabel,
            async execute(...args) {
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
            },
        });
        const parentSessionManager = options.context.sessionManager;
        const parentHeader = parentSessionManager?.getHeader?.();
        const parentSessionFile = parentSessionManager?.getSessionFile?.();
        const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
        const auditorSessionManager = childSessionManager(parentSessionManager, cwd, "auditor-roles");
        const { session } = await createAgentSession({ cwd, agentDir: scratch, model: dispatch.model, thinkingLevel: options.context.thinkingLevel ?? "off", modelRuntime: runtime, resourceLoader: loader, customTools: [tool], sessionManager: auditorSessionManager, settingsManager: settings });
        const registeredToolNames = session.getAllTools().map((entry) => entry.name);
        session.setActiveToolsByName(registeredToolNames);
        const binding = {
            version: 1,
            parent: {
                ...(parentHeader?.id === undefined ? {} : { sessionId: parentHeader.id }),
                ...(parentSessionFile === undefined ? {} : { sessionFile: parentSessionFile }),
                ...(parentAttemptEntryId === null || parentAttemptEntryId === undefined ? {} : { attemptEntryId: parentAttemptEntryId }),
            },
        };
        // This durable binding is a prerequisite: never observe the provider when
        // its response could not later be tied to the current parent attempt.
        auditorSessionManager.appendCustomEntry(AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, binding);
        let turns = 0;
        let boundaryResponse;
        let evidenceToolFailure;
        let retentionFailure;
        let retainedResponse;
        // Evidence failure identity is derived from whichever non-decision tools the
        // live registry actually enabled — never from a package-fixed allowlist.
        const evidenceToolNames = new Set(registeredToolNames.filter((name) => name !== tool.name));
        const findEvidenceToolFailure = (response) => {
            const evidenceCallIds = new Set(response.content.flatMap((part) => part.type === "toolCall" && evidenceToolNames.has(part.name) ? [part.id] : []));
            return [...session.messages].reverse().find((message) => message.role === "toolResult" && evidenceCallIds.has(message.toolCallId) && message.isError);
        };
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "assistant" && boundaryResponse === undefined) {
                turns += 1;
                retainedResponse = event.message;
                try {
                    options.retainResponse?.(event.message);
                }
                catch (error) {
                    retentionFailure = error;
                }
                if (turns >= AUDITOR_TURN_LIMIT && boundaryResponse === undefined)
                    boundaryResponse = event.message;
            }
            // Let every evidence tool in the boundary turn settle before stopping.
            if (event.type === "turn_end") {
                if (boundaryResponse !== undefined) {
                    evidenceToolFailure = findEvidenceToolFailure(boundaryResponse);
                }
                if (decision !== undefined || boundaryResponse !== undefined || retentionFailure !== undefined)
                    void session.abort();
            }
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
                if (streamFailure !== undefined)
                    throw streamFailure;
                throw error;
            }
            if (options.signal?.aborted)
                throw options.signal.reason;
            if (streamFailure !== undefined) {
                if (retentionFailure !== undefined && typeof streamFailure === "object" && streamFailure !== null) {
                    Object.assign(streamFailure, { retentionFailure });
                }
                throw streamFailure;
            }
            if (decisionToolFailure !== undefined)
                throw decisionToolFailure;
            if (decision !== undefined) {
                const decisionResponse = [...session.messages].reverse().find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
                if (decisionResponse !== undefined) {
                    evidenceToolFailure = findEvidenceToolFailure(decisionResponse) ?? evidenceToolFailure;
                }
            }
            if (evidenceToolFailure !== undefined)
                throw evidenceToolFailure;
            if (retentionFailure !== undefined && retainedResponse?.stopReason !== "error")
                throw retentionFailure;
            if (boundaryResponse !== undefined && decision === undefined) {
                if (boundaryResponse.stopReason === "error" || boundaryResponse.stopReason === "aborted")
                    throw boundaryResponse;
                const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
                throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, { stopReason: boundaryResponse.stopReason, toolNames });
            }
            const assistants = [...session.messages].reverse().filter((message) => message.role === "assistant");
            const response = decision === undefined
                ? assistants[0]
                : assistants.find((message) => message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
            if (response === undefined)
                throw new Error(`${options.roleLabel} exited without a terminal response`);
            try {
                if (retentionFailure !== undefined)
                    throw retentionFailure;
                // A terminal response is normally retained by message_end. Keep the
                // fallback for providers that complete without emitting that event.
                if (retainedResponse === undefined)
                    options.retainResponse?.(response);
            }
            catch (retentionFailure) {
                if (response.stopReason !== "error")
                    throw retentionFailure;
                const failure = new Error(response.errorMessage?.trim() || "provider failure", { cause: retentionFailure });
                failure.name = response.model || response.provider || "Error";
                failure.knownCause = "provider";
                failure.failureCode = response.provider || response.model;
                const retentionError = retentionFailure instanceof Error ? retentionFailure : undefined;
                const retentionCause = retentionError?.cause;
                failure.details = {
                    ...(response.provider ? { provider: response.provider } : {}),
                    ...(response.model ? { model: response.model } : {}),
                    retentionFailure: {
                        name: retentionError?.name ?? typeof retentionFailure,
                        message: retentionError?.message ?? String(retentionFailure),
                        ...(retentionError?.code !== undefined ? { code: retentionError.code } : {}),
                        ...(retentionCause === undefined ? {} : { cause: retentionCause instanceof Error ? { name: retentionCause.name, message: retentionCause.message, ...(retentionCause.code === undefined ? {} : { code: retentionCause.code }) } : retentionCause }),
                    },
                };
                auditorSessionManager.appendCustomEntry(AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, {
                    version: 1,
                    parent: binding.parent,
                    failure: {
                        cause: failure.knownCause,
                        identity: { name: failure.name, code: failure.failureCode },
                        diagnostic: failure.message,
                        details: failure.details,
                    },
                });
                throw failure;
            }
            if (response.stopReason === "error" || response.stopReason === "aborted")
                throw response;
            return { decision, response };
        }
        finally {
            options.signal?.removeEventListener("abort", abort);
            unsubscribe();
            session.dispose();
        }
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
