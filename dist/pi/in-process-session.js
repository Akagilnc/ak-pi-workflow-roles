/**
 * Pi Institutional Sub-Session Open Seam (#518 / #233).
 * Adapts Pi AgentSession / ModelRuntime / ModelRegistry into the host-neutral
 * HostInstitutionalSessionHandle contract.
 * Zero Pi type leakage out of this module.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, } from "@earendil-works/pi-ai";
import { createRecordSession } from "../archivist-record-entry.js";
import { createStreamIdleGuard, isStreamIdleTimeoutError, StreamIdleTimeoutError, } from "../stream-idle-guard.js";
import { hasUpstreamErrorTestimony, isNonSuccessHttpStatus, projectConfirmedRemotePayload, } from "../upstream-error-testimony.js";
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
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
// ── Stream / remote error projection helpers ───────────────────────────────
function emptyUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
function addUsage(total, next) {
    if (!next)
        return;
    total.input += next.input;
    total.output += next.output;
    total.cacheRead += next.cacheRead;
    total.cacheWrite += next.cacheWrite;
    total.totalTokens += next.totalTokens;
    total.cost.input += next.cost?.input ?? 0;
    total.cost.output += next.cost?.output ?? 0;
    total.cost.cacheRead += next.cost?.cacheRead ?? 0;
    total.cost.cacheWrite += next.cost?.cacheWrite ?? 0;
    total.cost.total += next.cost?.total ?? 0;
}
function numericHttpStatus(value) {
    return isNonSuccessHttpStatus(value) ? value : undefined;
}
function projectStructuredRemote(error) {
    let httpStatus;
    let diagnostics;
    let body;
    let code;
    let errno;
    let cursor = error;
    const seen = new Set();
    while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const record = cursor;
        const nodeStatus = numericHttpStatus(record.statusCode)
            ?? numericHttpStatus(record.status)
            ?? numericHttpStatus(record.httpStatus);
        const nodeDiagnostics = Array.isArray(record.diagnostics) && record.diagnostics.length > 0
            ? record.diagnostics
            : undefined;
        const nodeHasTestimony = hasUpstreamErrorTestimony({
            ...(nodeStatus === undefined ? {} : { httpStatus: nodeStatus }),
            ...(nodeDiagnostics === undefined ? {} : { diagnostics: nodeDiagnostics }),
        });
        if (httpStatus === undefined && nodeStatus !== undefined)
            httpStatus = nodeStatus;
        if (diagnostics === undefined && nodeDiagnostics !== undefined)
            diagnostics = nodeDiagnostics;
        if (nodeHasTestimony) {
            const payload = projectConfirmedRemotePayload(record);
            if (body === undefined && payload.body !== undefined)
                body = payload.body;
            if (code === undefined && payload.code !== undefined)
                code = payload.code;
            if (errno === undefined && payload.errno !== undefined)
                errno = payload.errno;
        }
        cursor = record.cause;
    }
    return {
        hasTestimony: hasUpstreamErrorTestimony({
            ...(httpStatus === undefined ? {} : { httpStatus }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
        }),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        ...(body === undefined ? {} : { body }),
        ...(code === undefined ? {} : { code }),
        ...(errno === undefined ? {} : { errno }),
    };
}
function attachObservedHttpStatus(message, observedHttpStatus) {
    if (observedHttpStatus === undefined)
        return message;
    if (message.stopReason !== "error" && message.stopReason !== "aborted")
        return message;
    if (numericHttpStatus(observedHttpStatus) === undefined)
        return message;
    if (projectStructuredRemote(message).httpStatus !== undefined)
        return message;
    return Object.assign(message, {
        status: observedHttpStatus,
        statusCode: observedHttpStatus,
    });
}
function enrichStreamEvent(event, observedHttpStatus) {
    if (observedHttpStatus === undefined || event === null || typeof event !== "object")
        return event;
    const record = event;
    if (record.type === "error" && record.error !== null && typeof record.error === "object") {
        return {
            ...record,
            error: attachObservedHttpStatus(record.error, observedHttpStatus),
        };
    }
    if (record.type === "done" && record.message !== null && typeof record.message === "object") {
        return {
            ...record,
            message: attachObservedHttpStatus(record.message, observedHttpStatus),
        };
    }
    if (record.partial !== null && typeof record.partial === "object") {
        return {
            ...record,
            partial: attachObservedHttpStatus(record.partial, observedHttpStatus),
        };
    }
    return event;
}
export async function openPiInstitutionalSession(options) {
    const label = options.label ?? "Institutional sub-session";
    const selection = options.selection;
    // 1. Scratch management
    let scratchDir;
    let resolvedAgentDir = options.agentDir;
    if (resolvedAgentDir === undefined) {
        scratchDir = await mkdtemp(join(options.credentialScratchParent ?? tmpdir(), "ak-institutional-"));
        resolvedAgentDir = scratchDir;
    }
    try {
        // 2. Auth resolution in Pi layer via explicit selection (Hop 3)
        // spec-2: adapter creates its OWN child-local ModelRuntime and ModelRegistry.
        // Auth is resolved strictly by explicit selection on the child registry — never
        // ambiently inherited from the parent ExtensionContext/modelRegistry.
        const childRuntime = await ModelRuntime.create();
        const childRegistry = new ModelRegistry(childRuntime);
        const childProvider = typeof childRegistry.getProvider === "function"
            ? childRegistry.getProvider(selection.provider)
            : undefined;
        const foundModel = typeof childRegistry.find === "function"
            ? childRegistry.find(selection.provider, selection.model)
            : undefined;
        const providerDefaultModel = childProvider?.getModels?.()[0];
        const fallbackApi = providerDefaultModel?.api
            ?? childProvider?.api
            ?? (selection.provider === "openai-codex" ? "openai-codex-responses" : "openai-completions");
        const modelToUse = foundModel ?? {
            id: selection.model,
            name: selection.model,
            api: fallbackApi,
            provider: selection.provider,
            baseUrl: providerDefaultModel?.baseUrl ?? "",
            reasoning: selection.thinking !== undefined && selection.thinking !== "off",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
        };
        let resolution;
        if (typeof childRegistry.getProviderAuth === "function") {
            resolution = await childRegistry.getProviderAuth(selection.provider).catch((error) => {
                throw new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            });
            if (resolution === undefined) {
                throw new Error(`${label} authentication failed: provider is not configured: ${selection.provider}`);
            }
        }
        let authResult;
        if (typeof childRegistry.getApiKeyAndHeaders === "function") {
            authResult = await childRegistry.getApiKeyAndHeaders(modelToUse);
            if (authResult && !authResult.ok) {
                throw new Error(`${label} authentication failed: ${authResult.error}`);
            }
        }
        const resolvedApiKey = authResult?.apiKey ?? resolution?.auth?.apiKey;
        const resolvedHeaders = authResult?.headers ?? resolution?.auth?.headers;
        const resolvedEnv = authResult?.env ?? resolution?.env;
        const effectiveBaseUrl = resolution?.auth?.baseUrl ?? modelToUse.baseUrl;
        const effectiveModel = {
            ...modelToUse,
            baseUrl: effectiveBaseUrl,
        };
        // 3. Standalone ModelRuntime + Provider with idle-only retry.
        // spec-2: the adapter constructs its OWN runtime/provider registration.
        // Auth is resolved only by explicit selection above and seeded into the
        // child runtime's own credential store — never inherited ambiently from
        // the parent ExtensionContext/Provider.
        const credentials = new InMemoryCredentialStore();
        const runtime = await ModelRuntime.create({
            credentials,
            modelsPath: null,
        });
        // Seed the child runtime's own credential store with the explicitly
        // resolved auth so stream auth resolution is self-contained. No ambient
        // fallback: absence of a resolved apiKey is not silently supplied.
        if (resolvedApiKey !== undefined) {
            await credentials.modify(selection.provider, async () => ({
                type: "api_key",
                key: resolvedApiKey,
                ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
            }));
        }
        const abortReason = (signal) => signal.reason ?? new Error(`${label} provider stream aborted`);
        let streamFailureValue;
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
        const createRetriedStream = (simple, model, context, request) => {
            const wrapped = createAssistantMessageEventStream();
            void (async () => {
                for (let attempt = 0;; attempt += 1) {
                    const idle = createStreamIdleGuard(options.signal === undefined ? {} : { parentSignal: options.signal });
                    let observedHttpStatus;
                    try {
                        const requestSignal = request?.signal;
                        const streamSignal = requestSignal === undefined
                            ? idle.signal
                            : AbortSignal.any([idle.signal, requestSignal]);
                        const priorOnResponse = request?.onResponse;
                        const retriedRequest = {
                            ...(request ?? {}),
                            ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
                            signal: streamSignal,
                            maxRetries: 0,
                            onResponse: async (response, resModel) => {
                                if (typeof response?.status === "number")
                                    observedHttpStatus = response.status;
                                await priorOnResponse?.(response, resModel);
                            },
                        };
                        if (childProvider === undefined) {
                            throw new Error(`${label} provider not found: ${model.provider}`);
                        }
                        const source = simple
                            ? childProvider.streamSimple(model, context, retriedRequest)
                            : childProvider.stream(model, context, retriedRequest);
                        let sawEvent = false;
                        const attemptEvents = [];
                        const iterator = source[Symbol.asyncIterator]();
                        while (true) {
                            const next = await waitForStream(iterator.next(), idle.signal);
                            if (next.done)
                                break;
                            sawEvent = true;
                            idle.poke();
                            attemptEvents.push(enrichStreamEvent(next.value, observedHttpStatus));
                        }
                        const response = attachObservedHttpStatus(await waitForStream(source.result(), idle.signal), observedHttpStatus);
                        // Some stream APIs (e.g. OpenAI-completions over an HTTP error)
                        // surface the failure as an error-stop message rather than throwing.
                        // Hold that primary provider failure at the adapter boundary so
                        // consumers surface a real transport failure, never a projected
                        // step-machine "error" response (ADR 0018 / #518 §3).
                        if (response.stopReason === "error") {
                            const errorMessage = response.errorMessage ?? `${label} provider stream failed`;
                            if (options.idleRetry !== false
                                && isStreamIdleTimeoutError(errorMessage)
                                && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES
                                && options.signal?.aborted !== true) {
                                continue;
                            }
                            const idleMatch = /stream idle timeout after (\d+)ms/i.exec(errorMessage);
                            if (idleMatch) {
                                streamFailureValue = new StreamIdleTimeoutError(Number(idleMatch[1]));
                            }
                        }
                        for (const ev of attemptEvents) {
                            wrapped.push(ev);
                        }
                        wrapped.end(response);
                        return;
                    }
                    catch (error) {
                        if (request?.signal?.aborted) {
                            const response = {
                                role: "assistant",
                                content: [],
                                api: model.api,
                                provider: model.provider,
                                model: model.id,
                                usage: emptyUsage(),
                                stopReason: "aborted",
                                errorMessage: `${label} session aborted`,
                                timestamp: Date.now(),
                            };
                            wrapped.push({ type: "error", reason: "aborted", error: response });
                            wrapped.end(response);
                            return;
                        }
                        const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
                        if (options.idleRetry !== false
                            && isStreamIdleTimeoutError(failure)
                            && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES
                            && options.signal?.aborted !== true) {
                            continue;
                        }
                        const idleMatch = /stream idle timeout after (\d+)ms/i.exec(failure instanceof Error ? failure.message : String(failure));
                        const typedFailure = idleMatch && !(failure instanceof StreamIdleTimeoutError)
                            ? new StreamIdleTimeoutError(Number(idleMatch[1]))
                            : failure;
                        // Hold the primary provider failure at the adapter boundary (ADR
                        // 0018 / 失败诚实宪法). Consumers that surface transport failures
                        // read this so the real cause is never masked by a projected
                        // step-machine "error" response.
                        streamFailureValue = typedFailure;
                        const projected = projectStructuredRemote(failure);
                        const httpStatus = projected.httpStatus ?? numericHttpStatus(observedHttpStatus);
                        const response = {
                            role: "assistant",
                            content: [],
                            api: model.api,
                            provider: model.provider,
                            model: model.id,
                            usage: emptyUsage(),
                            stopReason: "error",
                            errorMessage: failure instanceof Error ? failure.message : String(failure),
                            timestamp: Date.now(),
                            ...(projected.diagnostics === undefined ? {} : { diagnostics: projected.diagnostics }),
                            ...(httpStatus === undefined ? {} : { status: httpStatus, statusCode: httpStatus }),
                            ...(projected.body === undefined ? {} : { body: projected.body }),
                            ...(projected.code === undefined ? {} : { code: projected.code }),
                            ...(projected.errno === undefined ? {} : { errno: projected.errno }),
                        };
                        wrapped.push({ type: "error", reason: "error", error: response });
                        wrapped.end(response);
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
            id: selection.provider,
            name: childProvider?.name ?? label,
            ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
            ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
            auth: {
                apiKey: {
                    name: `${label} authentication`,
                    async resolve() {
                        return {
                            auth: {
                                ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
                                ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
                                ...(effectiveBaseUrl === undefined ? {} : { baseUrl: effectiveBaseUrl }),
                            },
                            ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
                        };
                    },
                },
            },
            getModels() { return [effectiveModel]; },
            stream(model, childContext, request) {
                return createRetriedStream(false, model, childContext, request);
            },
            streamSimple(model, childContext, request) {
                return createRetriedStream(true, model, childContext, request);
            },
        };
        runtime.registerNativeProvider(provider);
        await runtime.refresh({ allowNetwork: false });
        // 4. Settings and ResourceLoader (fixed adapter policies: no extensions/skills/themes/templates/context-files)
        const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
            cwd: options.cwd,
            agentDir: resolvedAgentDir,
            settingsManager: settings,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: options.systemPrompt,
        });
        await loader.reload();
        // 5. SessionManager resolution
        let sessionManager;
        if (options.sessionManager !== undefined) {
            sessionManager = options.sessionManager;
        }
        else if (options.sessionIdentity !== undefined) {
            sessionManager = createRecordSession({
                cwd: options.cwd,
                kind: options.sessionIdentity.kind,
                ...(options.sessionIdentity.subject === undefined ? {} : { subject: options.sessionIdentity.subject }),
                ...(options.sessionIdentity.parent === undefined ? {} : { parent: options.sessionIdentity.parent }),
            });
        }
        else {
            sessionManager = createRecordSession({
                cwd: options.cwd,
                kind: "institutional",
            });
        }
        // 6. Tools mapping
        const customTools = [];
        if (options.customTools !== undefined) {
            customTools.push(...options.customTools);
        }
        if (options.tools !== undefined) {
            for (const hostTool of options.tools) {
                customTools.push({
                    name: hostTool.name,
                    label: hostTool.label,
                    description: hostTool.description,
                    parameters: hostTool.parameters,
                    execute: async (toolCallId, params, signal, update, _ctx) => {
                        const res = await hostTool.execute(toolCallId, params, signal, update === undefined ? undefined : (u) => update(u), undefined);
                        return res;
                    },
                });
            }
        }
        // 7. Create AgentSession
        const { session } = await createAgentSession({
            cwd: options.cwd,
            model: effectiveModel,
            thinkingLevel: (options.selection.thinking ?? "off"),
            modelRuntime: runtime,
            sessionManager,
            settingsManager: settings,
            agentDir: resolvedAgentDir,
            resourceLoader: loader,
            ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
            ...(options.toolsAllowlist === undefined ? {} : { tools: options.toolsAllowlist }),
            ...(customTools.length === 0 ? {} : { customTools }),
        });
        // 8. Event subscriptions
        const listeners = new Set();
        const accumulatedUsage = emptyUsage();
        const unsubscribeSession = session.subscribe((event) => {
            if (event.type === "message_end") {
                const msg = event.message;
                if (msg.role === "assistant" && msg.usage) {
                    addUsage(accumulatedUsage, msg.usage);
                }
                for (const listener of listeners) {
                    listener({
                        type: "message_end",
                        role: msg.role,
                        message: msg,
                        ...(msg.usage === undefined ? {} : { usage: msg.usage }),
                    });
                }
            }
            else if (event.type === "turn_end") {
                const msg = event.message;
                for (const listener of listeners) {
                    listener({
                        type: "turn_end",
                        ...(msg.stopReason === undefined ? {} : { stopReason: msg.stopReason }),
                    });
                }
            }
            else if (event.type === "tool_execution_start") {
                for (const listener of listeners) {
                    listener({
                        type: "tool_call",
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        args: event.args ?? event.input,
                    });
                }
            }
            else if (event.type === "tool_execution_end") {
                for (const listener of listeners) {
                    listener({
                        type: "tool_result",
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        isError: event.isError,
                        details: event.result ?? event.details,
                    });
                }
            }
        });
        let closed = false;
        const sessionFile = sessionManager.getSessionFile();
        const sessionId = sessionManager.getHeader?.()?.id;
        const handle = {
            ...(sessionFile === undefined ? {} : { sessionFile }),
            ...(sessionId === undefined ? {} : { sessionId }),
            async prompt(text) {
                const abortSession = () => { void session.abort(); };
                if (options.signal?.aborted)
                    abortSession();
                else
                    options.signal?.addEventListener("abort", abortSession, { once: true });
                try {
                    await session.prompt(text);
                    const lastAssistant = [...session.messages]
                        .reverse()
                        .find((message) => message.role === "assistant");
                    return {
                        text: session.getLastAssistantText() ?? "",
                        ...(lastAssistant?.stopReason === undefined ? {} : { stopReason: lastAssistant.stopReason }),
                        ...(lastAssistant?.errorMessage === undefined ? {} : { errorMessage: lastAssistant.errorMessage }),
                        usage: accumulatedUsage,
                        messages: session.messages,
                    };
                }
                finally {
                    options.signal?.removeEventListener("abort", abortSession);
                }
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            abort() {
                void session.abort();
            },
            async close() {
                if (closed)
                    return;
                closed = true;
                listeners.clear();
                try {
                    unsubscribeSession();
                }
                finally {
                    // spec-3: handle.close must always dispose the child session even when
                    // unsubscribing throws (the throwing unsubscribe is a cleanup failure the
                    // caller aggregates, never a reason to skip session teardown).
                    session.dispose();
                }
                if (scratchDir !== undefined) {
                    try {
                        await rm(scratchDir, { recursive: true, force: true });
                    }
                    catch (error) {
                        throw error;
                    }
                }
            },
        };
        return {
            handle,
            // Read lazily: the provider stream runs during session.prompt, so the
            // primary failure is only known after that turn completes. A getter keeps
            // this reflecting the latest value instead of freezing it at open time.
            get streamFailure() {
                return streamFailureValue;
            },
        };
    }
    catch (openError) {
        if (scratchDir !== undefined) {
            try {
                await rm(scratchDir, { recursive: true, force: true });
            }
            catch (cleanupFailure) {
                // ADR 0018 / #518 §1④: primary failure and cleanup failure stay
                // separated — cleanup must not mask the original open cause.
                throw new AggregateError([openError, cleanupFailure], `${label} open failed and its scratch cleanup also failed`, { cause: openError });
            }
        }
        throw openError;
    }
}
