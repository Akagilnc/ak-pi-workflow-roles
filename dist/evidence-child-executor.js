/**
 * Unique in-process child lifecycle helper (#236 established; #233 sinks auditor + navigator).
 * Owns scratch, inherited provider runtime, AgentSession, abort/dispose.
 * Not a subprocess RPC.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, } from "@earendil-works/pi-ai";
import { AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, prepareComplianceDispatch, } from "./compliance-transport.js";
import { wrapPackageOwnedToolDefinition } from "./package-owned-tool-idle.js";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.js";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.js";
// ── shared constants / types ──────────────────────────────────────────────
export const AUDITOR_TURN_LIMIT = 32;
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
export class AuditorTurnLimitError extends Error {
    limit;
    observedTurns;
    lastResponse;
    constructor(limit, observedTurns, lastResponse) {
        super(observedTurns === undefined
            ? `Auditor exceeded ${limit} turns`
            : `Auditor exhausted its ${limit}-turn limit after ${observedTurns} provider turns`);
        this.limit = limit;
        this.observedTurns = observedTurns;
        this.lastResponse = lastResponse;
        this.name = "AuditorTurnLimitError";
    }
}
/** Shared scratch directory with guaranteed cleanup. */
export async function withInProcessScratch(options, run) {
    const scratch = await mkdtemp(join(options.parentDirectory ?? tmpdir(), options.prefix));
    let failure;
    try {
        return await run(scratch);
    }
    catch (error) {
        failure = error;
        throw error;
    }
    finally {
        try {
            await rm(scratch, { recursive: true, force: true });
        }
        catch (cleanupFailure) {
            if (failure !== undefined) {
                throw new AggregateError([failure, cleanupFailure], "in-process child scratch cleanup failed", { cause: failure });
            }
            throw cleanupFailure;
        }
    }
}
/**
 * Build an inherited ModelRuntime + provider. Optional idle-only retry is the
 * ADR 0059 provider-stream seam (not package-owned-tool idle).
 */
export async function createInheritedRuntime(options) {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const activeModel = options.context.model;
    if (activeModel === undefined)
        throw new Error(`${options.label} requires an active model`);
    const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.label);
    const parentProvider = options.runCompletion === undefined
        ? options.context.modelRegistry.getProvider(activeModel.provider)
        : undefined;
    if (parentProvider === undefined && options.runCompletion === undefined) {
        throw new Error(`${options.label} provider not found: ${activeModel.provider}`);
    }
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
    });
    // Injected completions historically accepted the minimal model exposed by an
    // ExtensionContext. AgentSession crosses ModelRuntime first, so complete the
    // model metadata required by that runtime without changing provider identity.
    const inheritedModel = options.runCompletion === undefined
        ? dispatch.model
        : {
            ...dispatch.model,
            name: dispatch.model.name ?? dispatch.model.id,
            baseUrl: dispatch.model.baseUrl ?? "",
            reasoning: dispatch.model.reasoning ?? false,
            input: dispatch.model.input ?? ["text"],
            cost: dispatch.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: dispatch.model.contextWindow ?? 1,
            maxTokens: dispatch.model.maxTokens ?? 1,
        };
    const state = {
        runtime,
        model: inheritedModel,
        dispatch,
        streamFailure: undefined,
    };
    const abortReason = (signal) => signal.reason ?? new Error(`${options.label} provider stream aborted`);
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
                try {
                    const requestSignal = request?.signal;
                    const streamSignal = requestSignal === undefined
                        ? idle.signal
                        : AbortSignal.any([idle.signal, requestSignal]);
                    const inheritedRequest = {
                        ...(request ?? {}),
                        ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }),
                        signal: streamSignal,
                    };
                    if (options.runCompletion !== undefined) {
                        await new Promise((resolve) => setImmediate(resolve));
                        if (streamSignal.aborted)
                            throw abortReason(streamSignal);
                        const completed = await waitForStream(options.runCompletion(model, options.injectedSystemPrompt === undefined
                            ? context
                            : { ...context, systemPrompt: options.injectedSystemPrompt }, inheritedRequest), streamSignal);
                        const response = {
                            ...completed,
                            api: model.api,
                            provider: model.provider,
                            model: model.id,
                        };
                        if (response.stopReason === "error" || response.stopReason === "aborted") {
                            wrapped.push({ type: "error", reason: response.stopReason, error: response });
                        }
                        else {
                            wrapped.end(response);
                        }
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
                    if (request?.signal?.aborted) {
                        const response = {
                            role: "assistant",
                            content: [],
                            api: model.api,
                            provider: model.provider,
                            model: model.id,
                            usage: emptyUsage(),
                            stopReason: "aborted",
                            errorMessage: "Auditor session aborted",
                            timestamp: Date.now(),
                        };
                        wrapped.push({ type: "error", reason: "aborted", error: response });
                        wrapped.end(response);
                        return;
                    }
                    const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
                    if (options.idleRetry === true
                        && isStreamIdleTimeoutError(failure)
                        && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES
                        && options.signal?.aborted !== true) {
                        continue;
                    }
                    state.streamFailure = failure;
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
    const provider = options.idleRetry === true || options.runCompletion !== undefined
        ? {
            id: parentProvider?.id ?? activeModel.provider,
            name: parentProvider?.name ?? options.label,
            auth: {
                apiKey: {
                    name: `Inherited ${options.label} authentication`,
                    async resolve() {
                        const { env, ...auth } = dispatch.auth;
                        return {
                            auth: {
                                ...auth,
                                ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }),
                            },
                            ...(env === undefined ? {} : { env }),
                        };
                    },
                },
            },
            getModels() { return [inheritedModel]; },
            stream(model, context, request) {
                return createRetriedStream(false, model, context, request);
            },
            streamSimple(model, context, request) {
                return createRetriedStream(true, model, context, request);
            },
        }
        : {
            id: parentProvider.id,
            name: parentProvider.name,
            ...(parentProvider.baseUrl === undefined ? {} : { baseUrl: parentProvider.baseUrl }),
            ...(parentProvider.headers === undefined ? {} : { headers: parentProvider.headers }),
            auth: {
                apiKey: {
                    name: `Inherited ${options.label} authentication`,
                    async resolve() {
                        return {
                            auth: {
                                ...(dispatch.auth.apiKey === undefined ? {} : { apiKey: dispatch.auth.apiKey }),
                                ...(dispatch.auth.headers === undefined ? {} : { headers: dispatch.auth.headers }),
                                ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }),
                            },
                            ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }),
                        };
                    },
                },
            },
            getModels() { return [inheritedModel]; },
            stream(model, childContext, streamOptions) {
                return parentProvider.stream(model, childContext, streamOptions);
            },
            streamSimple(model, childContext, streamOptions) {
                return parentProvider.streamSimple(model, childContext, streamOptions);
            },
        };
    runtime.registerNativeProvider(provider);
    return state;
}
function classifiedError(error, evidenceChildFailure) {
    const diagnostic = typeof error === "object" && error !== null && typeof error.errorMessage === "string"
        ? error.errorMessage
        : error === undefined ? "" : String(error);
    const wrapped = error instanceof Error
        ? error
        : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
    const classification = "evidenceChildFailure" in wrapped
        ? wrapped.evidenceChildFailure
        : evidenceChildFailure;
    return Object.assign(wrapped, { evidenceChildFailure: classification });
}
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
    total.input += next.input;
    total.output += next.output;
    total.cacheRead += next.cacheRead;
    total.cacheWrite += next.cacheWrite;
    total.totalTokens += next.totalTokens;
    total.cost.input += next.cost.input;
    total.cost.output += next.cost.output;
    total.cost.cacheRead += next.cost.cacheRead;
    total.cost.cacheWrite += next.cost.cacheWrite;
    total.cost.total += next.cost.total;
}
export async function executeEvidenceChild(workspace, prompt, context, options = {}) {
    const signal = options.signal;
    return withInProcessScratch({
        prefix: "ak-evidence-child-",
        ...(options.credentialScratchParent === undefined
            ? {}
            : { parentDirectory: options.credentialScratchParent }),
    }, async (childConfigDir) => {
        const { openInProcessAgentSession } = await import("./in-process-session.js");
        const { childSessionManager } = await import("./activation-ledger-session.js");
        let inherited;
        try {
            inherited = await createInheritedRuntime({
                context,
                label: "Evidence child",
            });
        }
        catch (error) {
            throw classifiedError(error, "provider");
        }
        // No tools allowlist — Pi defaults + unrestricted evidence surface (ADR 0064).
        // Single createAgentSession owner: in-process-session.ts.
        const { session, dispose } = await openInProcessAgentSession({
            cwd: workspace,
            agentDir: childConfigDir,
            model: inherited.model,
            thinkingLevel: context.thinkingLevel ?? "off",
            modelRuntime: inherited.runtime,
            systemPrompt: [
                "Work only in the supplied workspace.",
                "Use the available evidence tools to investigate. Do not commit, push, or mutate remotes.",
                "Return one substantive non-blank report.",
            ].join("\n"),
            sessionManager: childSessionManager(context.sessionManager, workspace, "evidence-children"),
        });
        const usage = emptyUsage();
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "assistant") {
                addUsage(usage, event.message.usage);
            }
        });
        const abortChild = () => { void session.abort(); };
        if (signal?.aborted)
            abortChild();
        else
            signal?.addEventListener("abort", abortChild, { once: true });
        let primaryFailure;
        try {
            const delivered = prompt;
            try {
                await session.prompt(delivered);
            }
            catch (error) {
                throw classifiedError(error, "provider");
            }
            if (signal?.aborted)
                throw new Error("Evidence child was cancelled");
            const lastAssistant = [...session.messages]
                .reverse()
                .find((message) => message.role === "assistant");
            if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
                throw classifiedError(new Error(lastAssistant.errorMessage ?? "", { cause: lastAssistant }), "provider");
            }
            if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason === "aborted") {
                throw classifiedError(new Error("Evidence child child terminated without a report", {
                    cause: lastAssistant ?? session.messages,
                }), "child");
            }
            const report = session.getLastAssistantText() ?? "";
            if (report.trim().length === 0) {
                throw new Error("Evidence child returned a blank child report");
            }
            return { report, usage, prompt: delivered };
        }
        catch (error) {
            primaryFailure = classifiedError(error, "child");
            throw primaryFailure;
        }
        finally {
            signal?.removeEventListener("abort", abortChild);
            let cleanupFailure;
            for (const cleanup of [() => unsubscribe(), () => dispose()]) {
                try {
                    cleanup();
                }
                catch (failure) {
                    cleanupFailure = cleanupFailure === undefined
                        ? failure
                        : new AggregateError([cleanupFailure, failure], "Reviewer child cleanup failed", {
                            cause: cleanupFailure,
                        });
                }
            }
            if (cleanupFailure !== undefined) {
                if (primaryFailure !== undefined) {
                    throw new AggregateError([primaryFailure, cleanupFailure], "Reviewer child execution and cleanup failed", { cause: primaryFailure });
                }
                throw new AggregateError([cleanupFailure], "Reviewer child cleanup failed", {
                    cause: cleanupFailure,
                });
            }
        }
    });
}
/**
 * Auditor lifecycle via the shared in-process helper.
 * Adapter keeps role label / soul / decision tool / result projection only.
 * No tools allowlist (ADR 0064). Provider-stream idle-only retry (ADR 0059).
 * Durable child session via ADR 0065 sitian entry.
 */
export async function executeAuditorChild(options) {
    const { createRecordSession } = await import("./sitian-record-entry.js");
    return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
        const inherited = await createInheritedRuntime({
            context: options.context,
            label: options.roleLabel,
            idleRetry: true,
            ...(options.runCompletion === undefined
                ? {}
                : { runCompletion: options.runCompletion, injectedSystemPrompt: options.systemPrompt }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const cwd = options.context.cwd ?? process.cwd();
        let decision;
        let noReceiptLifecycle;
        let decisionSubmitted = false;
        let decisionCallId;
        let decisionToolFailure;
        const decisionToolFailures = new Map();
        const delivery = createReceiptDeliveryPolicy();
        const tool = wrapPackageOwnedToolDefinition({
            ...options.tool,
            label: options.roleLabel,
            async execute(...args) {
                if (decisionSubmitted && decisionCallId !== args[0]) {
                    throw new Error("Auditor decision was submitted more than once");
                }
                // Pi may execute several decision calls from one assistant response.
                // Reserve shared-policy capacity before invoking the role tool so an
                // excess batched sibling cannot execute before its rejection is drained.
                if (!delivery.reserveTerminalExecution()) {
                    throw new Error("Auditor decision rejection budget exhausted");
                }
                try {
                    const result = await options.tool.execute(...args);
                    delivery.recordAccepted();
                    decision = args[1];
                    decisionCallId = args[0];
                    decisionToolFailure = undefined;
                    decisionToolFailures.delete(args[0]);
                    decisionSubmitted = true;
                    return result;
                }
                catch (error) {
                    decisionToolFailure = error;
                    decisionToolFailures.set(args[0], error);
                    throw error;
                }
            },
        });
        const parentSessionManager = options.context.sessionManager;
        const parentHeader = parentSessionManager?.getHeader?.();
        const parentSessionFile = parentSessionManager?.getSessionFile?.();
        const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
        const auditorSessionManager = createRecordSession({
            cwd,
            kind: "auditor-roles",
            ...(parentSessionManager === undefined ? {} : { parent: parentSessionManager }),
        });
        // Shared session open — no tools allowlist (ADR 0064).
        const { openInProcessAgentSession: openSession } = await import("./in-process-session.js");
        const { session, dispose } = await openSession({
            cwd,
            agentDir: scratch,
            model: inherited.model,
            thinkingLevel: options.context.thinkingLevel ?? "off",
            modelRuntime: inherited.runtime,
            systemPrompt: options.systemPrompt,
            customTools: [wrapPackageOwnedToolDefinition({ ...options.dossierTool, label: options.roleLabel }), tool],
            sessionManager: auditorSessionManager,
        });
        const binding = {
            version: 1,
            parent: {
                ...(parentHeader?.id === undefined ? {} : { sessionId: parentHeader.id }),
                ...(parentSessionFile === undefined ? {} : { sessionFile: parentSessionFile }),
                ...(parentAttemptEntryId === null || parentAttemptEntryId === undefined
                    ? {}
                    : { attemptEntryId: parentAttemptEntryId }),
            },
        };
        // Durable binding is a prerequisite: never observe the provider when its
        // response could not later be tied to the current parent attempt.
        auditorSessionManager.appendCustomEntry(AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, binding);
        let turns = 0;
        const sessionUsage = emptyUsage();
        let boundaryResponse;
        let retentionFailure;
        let retainedResponse;
        let rejectedDecisionResponse;
        let promptNeighboringFailure;
        let promptDecisionFailures = [];
        const registeredToolNames = new Set(session.getAllTools().map((entry) => entry.name));
        const evidenceToolFailures = new Map();
        for (const name of registeredToolNames) {
            if (name === tool.name)
                continue;
            const definition = session.getToolDefinition(name);
            if (definition === undefined)
                continue;
            const execute = definition.execute.bind(definition);
            definition.execute = async (...args) => {
                try {
                    return await execute(...args);
                }
                catch (error) {
                    evidenceToolFailures.set(args[0], error);
                    throw error;
                }
            };
        }
        const findToolFailure = (response) => {
            const callIds = response.content.flatMap((part) => part.type === "toolCall" && part.name !== tool.name && registeredToolNames.has(part.name) ? [part.id] : []);
            for (const callId of callIds) {
                if (evidenceToolFailures.has(callId))
                    return evidenceToolFailures.get(callId);
            }
            const callIdSet = new Set(callIds);
            return [...session.messages].reverse().find((message) => message.role === "toolResult" && callIdSet.has(message.toolCallId) && message.isError);
        };
        const drainRejectedDecisionFailures = (response) => {
            for (const part of response.content) {
                if (part.type !== "toolCall" || part.name !== tool.name || !decisionToolFailures.has(part.id))
                    continue;
                decisionToolFailure = decisionToolFailures.get(part.id);
                promptDecisionFailures.push(decisionToolFailure);
                decisionToolFailures.delete(part.id);
            }
        };
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "assistant" && boundaryResponse === undefined) {
                turns += 1;
                addUsage(sessionUsage, event.message.usage);
                retainedResponse = event.message;
                try {
                    options.retainResponse?.(event.message);
                }
                catch (error) {
                    retentionFailure = error;
                }
                // A tool call in assistant output is only an observation. Preserve its
                // candidate for typed malformed-decision settlement, but the wrapped
                // execute path above is the sole owner of accepted-receipt state; a
                // rejected execution must remain retryable in this same session.
                for (const part of event.message.content) {
                    if (part.type === "toolCall" && part.name === tool.name) {
                        rejectedDecisionResponse = event.message;
                        if (decision === undefined) {
                            decision = part.arguments;
                            decisionCallId = part.id;
                            // Pi can reject malformed root arguments before invoking execute;
                            // that remains the existing typed audit-incomplete candidate path.
                            if (part.arguments === undefined)
                                decisionSubmitted = true;
                        }
                    }
                }
                if (turns >= AUDITOR_TURN_LIMIT)
                    boundaryResponse = event.message;
            }
            if (event.type === "turn_end") {
                if (rejectedDecisionResponse !== undefined) {
                    promptNeighboringFailure = findToolFailure(rejectedDecisionResponse);
                    drainRejectedDecisionFailures(rejectedDecisionResponse);
                }
                if (decisionSubmitted || promptNeighboringFailure !== undefined
                    || boundaryResponse !== undefined || retentionFailure !== undefined) {
                    void session.abort();
                }
            }
        });
        const abort = () => { void session.abort(); };
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        try {
            try {
                const promptAllowingRejectedDecision = async (prompt) => {
                    rejectedDecisionResponse = undefined;
                    promptNeighboringFailure = undefined;
                    decisionToolFailure = undefined;
                    promptDecisionFailures = [];
                    let promptFailure;
                    try {
                        await session.prompt(prompt);
                    }
                    catch (error) {
                        promptFailure = error;
                    }
                    // Prefer turn_end correlation, but Pi may reject prompt() before that
                    // event. In that case correlate against this prompt's captured decision
                    // response and call-id maps at the catch boundary.
                    const correlatedResponse = rejectedDecisionResponse;
                    if (correlatedResponse !== undefined) {
                        promptNeighboringFailure ??= findToolFailure(correlatedResponse);
                        drainRejectedDecisionFailures(correlatedResponse);
                    }
                    // An adjacent failure outranks correctable decision feedback.
                    if (promptNeighboringFailure !== undefined)
                        throw promptNeighboringFailure;
                    // An accepted correction in the same response owns the terminal
                    // outcome; correlated rejected siblings remain observations, not a
                    // stale failure capable of replacing that accepted receipt.
                    if (decisionSubmitted) {
                        decisionToolFailure = undefined;
                        return;
                    }
                    if (decisionToolFailure !== undefined)
                        return;
                    if (promptFailure !== undefined)
                        throw promptFailure;
                };
                await promptAllowingRejectedDecision(options.prompt);
                while (!decisionSubmitted && boundaryResponse === undefined && inherited.streamFailure === undefined
                    && delivery.nextAction() === "request-delivery") {
                    if (decisionToolFailure !== undefined) {
                        const failures = promptDecisionFailures.length === 0
                            ? [decisionToolFailure]
                            : promptDecisionFailures;
                        for (const failure of failures) {
                            delivery.recordRejected(failure instanceof Error ? failure.message : String(failure));
                        }
                        decisionToolFailure = undefined;
                        promptDecisionFailures = [];
                        if (delivery.nextAction() === "no-receipt")
                            boundaryResponse = undefined;
                        if (delivery.nextAction() === "request-delivery") {
                            // The correction solicitation itself consumes the remaining shared
                            // turn at issuance; prose cannot defer charging it to a later loop.
                            delivery.recordDeliveryRequest();
                            if (retainedResponse === rejectedDecisionResponse) {
                                await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
                                for (const failure of promptDecisionFailures) {
                                    delivery.recordRejected(failure instanceof Error ? failure.message : String(failure));
                                }
                                decisionToolFailure = undefined;
                                promptDecisionFailures = [];
                            }
                        }
                    }
                    else {
                        delivery.recordDeliveryRequest();
                        await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
                    }
                }
                if (!decisionSubmitted && boundaryResponse === undefined && inherited.streamFailure === undefined
                    && delivery.nextAction() === "no-receipt") {
                    const runPointer = options.context.sessionManager.getSessionFile() ?? options.context.cwd ?? process.cwd();
                    const attemptPointer = binding.parent.attemptEntryId ?? binding.parent.sessionId ?? `current:${runPointer}`;
                    const facts = delivery.facts({ runPointer, attemptPointer });
                    decision = facts;
                    // Late turn_end feedback cannot overturn a lifecycle that has already
                    // charged this prompt to the exhausted shared budget.
                    decisionToolFailure = undefined;
                    auditorSessionManager.appendCustomEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
                    // Provenance is granted only after the lifecycle owner persisted the
                    // current child record; accepted model arguments can never set it.
                    noReceiptLifecycle = facts;
                }
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw options.signal.reason;
                if (inherited.streamFailure !== undefined)
                    throw inherited.streamFailure;
                throw error;
            }
            if (options.signal?.aborted)
                throw options.signal.reason;
            if (inherited.streamFailure !== undefined)
                throw inherited.streamFailure;
            if (!decisionSubmitted && decisionToolFailure !== undefined)
                throw decisionToolFailure;
            const relevantResponse = !decisionSubmitted
                ? boundaryResponse
                : [...session.messages].reverse().find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
            if (relevantResponse !== undefined) {
                const toolFailure = findToolFailure(relevantResponse);
                if (toolFailure !== undefined)
                    throw toolFailure;
            }
            if (retentionFailure !== undefined && retainedResponse?.stopReason !== "error")
                throw retentionFailure;
            if (boundaryResponse !== undefined && !decisionSubmitted) {
                const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
                throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, {
                    stopReason: boundaryResponse.stopReason,
                    toolNames,
                });
            }
            const assistants = [...session.messages]
                .reverse()
                .filter((message) => message.role === "assistant");
            const response = !decisionSubmitted
                ? assistants[0]
                : assistants.find((message) => message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
            if (response !== undefined) {
                try {
                    if (retainedResponse === undefined)
                        options.retainResponse?.(response);
                    else if (retentionFailure !== undefined)
                        throw retentionFailure;
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
                            ...(retentionError?.code !== undefined
                                ? { code: retentionError.code }
                                : {}),
                            ...(retentionCause === undefined
                                ? {}
                                : {
                                    cause: retentionCause instanceof Error
                                        ? {
                                            name: retentionCause.name,
                                            message: retentionCause.message,
                                            ...(retentionCause.code === undefined
                                                ? {}
                                                : { code: retentionCause.code }),
                                        }
                                        : retentionCause,
                                }),
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
            }
            if (response === undefined
                || response.stopReason === "error"
                || response.stopReason === "aborted"
                || (!decisionSubmitted && decision === undefined)) {
                throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
            }
            return {
                decision,
                response: { ...response, usage: sessionUsage },
                ...(noReceiptLifecycle === undefined ? {} : { noReceiptLifecycle }),
            };
        }
        finally {
            options.signal?.removeEventListener("abort", abort);
            unsubscribe();
            dispose();
        }
    });
}
