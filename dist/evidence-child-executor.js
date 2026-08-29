/**
 * Unique in-process child lifecycle helper (#236 established; #233 sinks auditor + navigator).
 * Owns scratch, inherited provider runtime, AgentSession, abort/dispose.
 * Not a subprocess RPC.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {} from "@earendil-works/pi-ai";
import { AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, } from "./compliance-transport.js";
import { auditorRunDirectory } from "./auditor-dossier-tool.js";
import { createEngineDetourToolDefinition } from "./engine-detour-tool.js";
import { engineNameFromEnv } from "./engine-detour.js";
import { appendEngineSessionMaterial, engineSessionMaterialFromOptions, } from "./package-resources/engine-material.js";
import { readPackageMaterial } from "./session-opening-materials.js";
import {} from "./public-cli/config.js";
import { readInstitutionalSeatSelection } from "./institutional-resolution.js";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.js";
import { hasUpstreamErrorTestimony, isNonSuccessHttpStatus, projectConfirmedRemotePayload, } from "./upstream-error-testimony.js";
/**
 * Shared Standards/Spec evidence-child system materials — path roster only.
 * Builder consumes this unique roster; cadence prose stays in owner material (ADR 0073).
 * Not exported — tests must not mirror internal roster structure.
 */
const EVIDENCE_CHILD_SESSION_MATERIALS = [
    "souls/quality-law.md",
];
/** Package-owned system prompt for Reviewer Standards/Spec evidence children (private carrier). */
async function buildEvidenceChildSystemPrompt(engineMaterial) {
    // ADR 0073: verification cadence lives in owner material only; no machine prose copy.
    const materials = [];
    for (const relativePath of EVIDENCE_CHILD_SESSION_MATERIALS) {
        materials.push(await readPackageMaterial(relativePath));
    }
    return appendEngineSessionMaterial(materials, engineMaterial).join("\n");
}
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
 * Run every child cleanup, aggregating failures so one throwing cleanup never
 * skips the rest (e.g. handle.close must still run when unsubscribe throws).
 * If a primary failure is supplied and cleanup also failed, the two are combined
 * into an AggregateError; otherwise only the failing branch is surfaced.
 */
async function runChildCleanup(cleanups, primaryFailure, label) {
    let cleanupFailure;
    for (const cleanup of cleanups) {
        try {
            await cleanup();
        }
        catch (failure) {
            cleanupFailure = cleanupFailure === undefined
                ? failure
                : new AggregateError([cleanupFailure, failure], `${label} cleanup failed`, {
                    cause: cleanupFailure,
                });
        }
    }
    if (cleanupFailure === undefined)
        return;
    if (primaryFailure !== undefined) {
        throw new AggregateError([primaryFailure, cleanupFailure], `${label} execution and cleanup failed`, { cause: primaryFailure });
    }
    throw new AggregateError([cleanupFailure], `${label} cleanup failed`, {
        cause: cleanupFailure,
    });
}
function numericHttpStatus(value) {
    return isNonSuccessHttpStatus(value) ? value : undefined;
}
/**
 * Cause-chain reader over the shared upstream-testimony authority.
 * Shape walking stays here; testimony + confirmed-remote payload rules are shared.
 */
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
        // Payload only from confirmed-remote nodes — never arbitrary local Error.code.
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
/**
 * Attach a directly observed HTTP status onto an error/aborted assistant message.
 * Does not invent status from errorMessage prose; skips when already held.
 */
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
function classifiedError(error, evidenceChildFailure) {
    const diagnostic = typeof error === "object" && error !== null && typeof error.errorMessage === "string"
        ? error.errorMessage
        : error === undefined ? "" : String(error);
    const wrapped = error instanceof Error
        ? error
        : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
    const classification = "evidenceChildFailure" in wrapped
        ? wrapped.evidenceChildFailure
        : evidenceChildFailure === "provider" && !projectStructuredRemote(error).hasTestimony
            ? "unknown"
            : evidenceChildFailure;
    return Object.assign(wrapped, { evidenceChildFailure: classification });
}
/** Extract the first text diagnostic from a flattened toolResult error `details`. */
function extractToolResultText(details) {
    if (typeof details !== "object" || details === null)
        return undefined;
    const record = details;
    const content = record.content;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === "object" && part !== null) {
                const text = part.text;
                if (typeof text === "string" && text.trim() !== "")
                    return text;
            }
        }
    }
    return undefined;
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
    const runDirectory = options.runDirectory ?? auditorRunDirectory(context);
    if (runDirectory === undefined) {
        throw new Error("Evidence child requires a run directory carrying the institutional resolution page");
    }
    const selection = await readInstitutionalSeatSelection(runDirectory, "evidenceChild");
    return withInProcessScratch({
        prefix: "ak-evidence-child-",
        ...(options.credentialScratchParent === undefined
            ? {}
            : { parentDirectory: options.credentialScratchParent }),
    }, async (childConfigDir) => {
        const { openPiInstitutionalSession } = await import("./pi/in-process-session.js");
        const { createRecordSession } = await import("./archivist-record-entry.js");
        // #378: when labor engine is configured, legs get the same detour tool + material
        // dual-path as the parent seat (ADR 0069 detour-rejoins-main-road).
        const engineName = engineNameFromEnv();
        const engineMaterial = engineName === undefined
            ? undefined
            : options.packageRoot === undefined || options.packageRoot.trim() === ""
                // Name-only when package root is unavailable (still a valid #376 path).
                ? Object.freeze({ name: engineName })
                : engineSessionMaterialFromOptions({
                    engine: engineName,
                    packageRoot: options.packageRoot,
                });
        // Evidence legs use the parent detour tool; retain any engine process cause
        // so the enclosing child boundary, rather than a tool-error result, terminates.
        let engineDetourFailure;
        const engineDetourTool = engineName === undefined
            ? undefined
            : createEngineDetourToolDefinition({
                engineName,
                fail(error) {
                    engineDetourFailure ??= error instanceof Error ? error : new Error(String(error));
                    throw engineDetourFailure;
                },
            });
        // No tools allowlist — Pi defaults + unrestricted evidence surface (ADR 0064).
        // Single open seam owner: pi/in-process-session.ts.
        let opened;
        try {
            opened = await openPiInstitutionalSession({
                cwd: workspace,
                agentDir: childConfigDir,
                selection,
                systemPrompt: await buildEvidenceChildSystemPrompt(engineMaterial),
                ...(engineDetourTool === undefined
                    ? {}
                    : { customTools: [engineDetourTool] }),
                sessionManager: createRecordSession({
                    cwd: workspace,
                    kind: "evidence-children",
                    ...(context.sessionManager === undefined ? {} : { parent: context.sessionManager }),
                }),
                ...(signal === undefined ? {} : { signal }),
                label: "Evidence child",
            });
        }
        catch (error) {
            throw classifiedError(error, "provider");
        }
        const { handle } = opened;
        const usage = emptyUsage();
        const unsubscribe = handle.subscribe((event) => {
            if (event.type === "message_end" && event.role === "assistant") {
                if (event.usage)
                    addUsage(usage, event.usage);
            }
        });
        const abortChild = () => { handle.abort(); };
        if (signal?.aborted)
            abortChild();
        else
            signal?.addEventListener("abort", abortChild, { once: true });
        let primaryFailure;
        try {
            const delivered = prompt;
            let turnResult;
            try {
                turnResult = await handle.prompt(delivered);
            }
            catch (error) {
                if (engineDetourFailure !== undefined) {
                    throw classifiedError(engineDetourFailure, "child");
                }
                throw classifiedError(error, "provider");
            }
            if (engineDetourFailure !== undefined) {
                throw classifiedError(engineDetourFailure, "child");
            }
            if (signal?.aborted)
                throw new Error("Evidence child was cancelled");
            const lastAssistant = turnResult.messages !== undefined
                ? [...turnResult.messages].reverse().find((message) => message?.role === "assistant")
                : undefined;
            // error|aborted assistant stops share the upstream-testimony rule: provider only
            // with direct HTTP/SDK testimony, otherwise existing unknown. child is reserved
            // for real local child/report failures (no assistant / blank report / cleanup).
            if (turnResult.stopReason === "error" || turnResult.stopReason === "aborted"
                || (lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted"))) {
                const errMsg = turnResult.errorMessage ?? lastAssistant?.errorMessage ?? "";
                throw classifiedError(new Error(errMsg, { cause: lastAssistant }), lastAssistant && projectStructuredRemote(lastAssistant).hasTestimony ? "provider" : "unknown");
            }
            if (lastAssistant !== undefined && lastAssistant.role !== "assistant") {
                throw classifiedError(new Error("Evidence child child terminated without a report", {
                    cause: lastAssistant ?? turnResult.messages,
                }), "child");
            }
            const report = turnResult.text;
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
            await runChildCleanup([() => unsubscribe(), () => handle.close()], primaryFailure, "Reviewer child");
        }
    });
}
/** Resolution-page seat key for an auditor invocation: province gate seats map
 * to their own page seats; doctor/judge compliance audits use the auditor seat. */
function auditorSeatKey(gateSeat) {
    return gateSeat ?? "auditor";
}
/**
 * Auditor lifecycle via the shared institutional sub-session adapter.
 * Adapter keeps role label / soul / decision tool / result projection only.
 * No tools allowlist (ADR 0064). Provider-stream idle-only retry (ADR 0059).
 * Durable child session via ADR 0065 archivist entry.
 */
export async function executeAuditorChild(options) {
    const { createRecordSession } = await import("./archivist-record-entry.js");
    const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
    if (runDirectory === undefined) {
        throw new Error(`${options.roleLabel} requires a run directory carrying the institutional resolution page`);
    }
    const seat = auditorSeatKey(options.gateSeat);
    const selection = await readInstitutionalSeatSelection(runDirectory, seat);
    return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
        const cwd = options.context.cwd ?? process.cwd();
        let decision;
        let noReceiptLifecycle;
        let decisionSubmitted = false;
        let decisionCallId;
        let decisionToolFailure;
        const decisionToolFailures = new Map();
        const delivery = createReceiptDeliveryPolicy();
        const tool = {
            ...options.tool,
            label: options.roleLabel,
            async execute(...args) {
                if (decisionSubmitted && decisionCallId !== args[0]) {
                    throw new Error("Auditor decision was submitted more than once");
                }
                // Pi may already have issued several decision calls in one assistant
                // response. Execute every issued call: the budget limits future
                // solicitations, not terminal calls already in flight.
                try {
                    const result = await options.tool.execute(...args);
                    delivery.recordAccepted();
                    const rawDecision = args[1];
                    const isMissingArgs = rawDecision === undefined
                        || (typeof rawDecision === "object" && rawDecision !== null && !Array.isArray(rawDecision) && Object.keys(rawDecision).length === 0);
                    decision = isMissingArgs ? undefined : rawDecision;
                    decisionCallId = args[0];
                    decisionToolFailure = undefined;
                    decisionToolFailures.delete(args[0]);
                    decisionSubmitted = true;
                    return { ...result, terminate: true };
                }
                catch (error) {
                    decisionToolFailure = error;
                    decisionToolFailures.set(args[0], error);
                    throw error;
                }
            },
        };
        const parentSessionManager = options.context.sessionManager;
        const parentHeader = parentSessionManager?.getHeader?.();
        const parentSessionFile = parentSessionManager?.getSessionFile?.();
        const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
        const auditorSessionManager = createRecordSession({
            cwd,
            kind: "auditor-roles",
            ...(parentSessionManager === undefined ? {} : { parent: parentSessionManager }),
        });
        // Shared session open — no tools allowlist (ADR 0064). Auth resolved
        // child-locally from the explicit seat selection; adapter owns runtime/provider.
        const { openPiInstitutionalSession } = await import("./pi/in-process-session.js");
        const evidenceToolFailures = new Map();
        const wrappedDossierTool = {
            ...options.dossierTool,
            label: options.roleLabel,
            async execute(...args) {
                try {
                    return await options.dossierTool.execute(...args);
                }
                catch (error) {
                    evidenceToolFailures.set(args[0], error);
                    throw error;
                }
            },
        };
        const opened = await openPiInstitutionalSession({
            cwd,
            agentDir: scratch,
            selection,
            systemPrompt: options.systemPrompt,
            customTools: [wrappedDossierTool, tool],
            sessionManager: auditorSessionManager,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            idleRetry: true,
            label: options.roleLabel,
        });
        const { handle } = opened;
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
        const findToolFailure = (response) => {
            const callIds = response.content.flatMap((part) => part.type === "toolCall" && part.name !== tool.name ? [part.id] : []);
            for (const callId of callIds) {
                if (evidenceToolFailures.has(callId))
                    return evidenceToolFailures.get(callId);
            }
            return undefined;
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
        const retainedAssistants = [];
        const unsubscribe = handle.subscribe((event) => {
            // Capture evidence-tool (non-decision) failures from the handle's real
            // tool_result events. The old runCompletion path wrapped every child tool's
            // execute to observe failures; through the real handle the adapter forwards
            // tool_execution_end isError. Record the errored tool call id so an adjacent
            // evidence failure can outrank a settled/correctable decision feedback.
            if (event.type === "tool_result" && event.isError === true && event.toolName !== tool.name) {
                // Through the real handle the child flattens a throwing evidence tool
                // into a toolResult error whose content text carries the diagnostic
                // (e.g. "ENOENT: no such file or directory..."). Recover that text so
                // the adjacent evidence failure outranks a settled decision feedback
                // with its original diagnostic, mirroring the pre-migration wrapped
                // execute capture (which held the raw error object).
                const detailText = extractToolResultText(event.details);
                // A native unknown-tool receipt ("Tool <name> not found") is not an
                // evidence-tool failure: the child session has no such tool registered,
                // so its errored toolResult must not short-circuit the auditor (it keeps
                // prompting to the turn limit, mirroring the pre-migration
                // registeredToolNames exclusion in findToolFailure).
                if (detailText !== undefined && /^Tool\s+.+ not found$/.test(detailText.trim()))
                    return;
                const failure = detailText === undefined
                    ? new Error(event.toolName ?? "evidence tool failed")
                    : new Error(detailText);
                // Recover the errno code from the flattened diagnostic so an evidence
                // failure's identity (e.g. code "ENOENT") is preserved across the real
                // HTTP round-trip, mirroring the pre-migration raw error object.
                const errno = /^([A-Z_]+):/.exec(detailText ?? "");
                if (errno !== null && errno[1] !== undefined)
                    failure.code = errno[1];
                evidenceToolFailures.set(event.toolCallId, failure);
            }
            if (event.type === "message_end" && event.role === "assistant" && boundaryResponse === undefined) {
                turns += 1;
                if (event.usage)
                    addUsage(sessionUsage, event.usage);
                const msg = event.message;
                retainedResponse = msg;
                if (msg) {
                    retainedAssistants.push(msg);
                    try {
                        options.retainResponse?.(msg);
                    }
                    catch (error) {
                        retentionFailure = error;
                    }
                    // A tool call in assistant output is only an observation. Preserve its
                    // candidate for typed malformed-decision settlement, but the wrapped
                    // execute path above is the sole owner of accepted-receipt state; a
                    // rejected execution must remain retryable in this same session.
                    for (const part of msg.content) {
                        if (part.type === "toolCall" && part.name === tool.name) {
                            rejectedDecisionResponse = msg;
                            if (decision === undefined) {
                                decision = (part.arguments === undefined
                                    || (typeof part.arguments === "object" && part.arguments !== null
                                        && !Array.isArray(part.arguments) && Object.keys(part.arguments).length === 0))
                                    ? undefined
                                    : part.arguments;
                                decisionCallId = part.id;
                                // Pi can reject malformed root arguments before invoking execute;
                                // that remains the existing unreadable-candidate failure path.
                                // A missing root argument reaches the real provider adapter as an
                                // empty object after serialization — treat it as missing too so a
                                // one-shot typed missing-args settlement does not solicit another turn.
                                if (part.arguments === undefined
                                    || (typeof part.arguments === "object" && part.arguments !== null
                                        && !Array.isArray(part.arguments) && Object.keys(part.arguments).length === 0)) {
                                    decisionSubmitted = true;
                                }
                            }
                        }
                    }
                    if (turns >= AUDITOR_TURN_LIMIT || msg.stopReason === "error")
                        boundaryResponse = msg;
                }
            }
            if (event.type === "turn_end") {
                if (rejectedDecisionResponse !== undefined) {
                    promptNeighboringFailure = findToolFailure(rejectedDecisionResponse);
                    drainRejectedDecisionFailures(rejectedDecisionResponse);
                }
                if (decisionSubmitted || promptNeighboringFailure !== undefined
                    || (boundaryResponse !== undefined && rejectedDecisionResponse === undefined)
                    || retentionFailure !== undefined) {
                    handle.abort();
                }
            }
        });
        const abort = () => { handle.abort(); };
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        let auditorFailure;
        try {
            try {
                const promptAllowingRejectedDecision = async (prompt) => {
                    rejectedDecisionResponse = undefined;
                    promptNeighboringFailure = undefined;
                    decisionToolFailure = undefined;
                    promptDecisionFailures = [];
                    let promptFailure;
                    try {
                        await handle.prompt(prompt);
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
                    if (retentionFailure !== undefined)
                        return;
                    if (opened.streamFailure !== undefined)
                        throw opened.streamFailure;
                    if (promptFailure !== undefined)
                        throw promptFailure;
                };
                const chargeAndClearRejectedDecisionFailures = (failures) => {
                    for (const failure of failures) {
                        delivery.recordRejected(failure instanceof Error ? failure.message : String(failure));
                    }
                    decisionToolFailure = undefined;
                    promptDecisionFailures = [];
                };
                await promptAllowingRejectedDecision(options.prompt);
                while (!decisionSubmitted && retentionFailure === undefined && (boundaryResponse === undefined || decisionToolFailure !== undefined)
                    && opened.streamFailure === undefined && delivery.nextAction() === "request-delivery") {
                    if (decisionToolFailure !== undefined) {
                        const failures = promptDecisionFailures.length === 0
                            ? [decisionToolFailure]
                            : promptDecisionFailures;
                        chargeAndClearRejectedDecisionFailures(failures);
                        if (delivery.nextAction() === "no-receipt")
                            boundaryResponse = undefined;
                        if (delivery.nextAction() === "request-delivery") {
                            // A rejection and its correction solicitation are one budget unit;
                            // recordRejected already charged it.
                            if (retainedResponse === rejectedDecisionResponse) {
                                await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
                                chargeAndClearRejectedDecisionFailures(promptDecisionFailures);
                            }
                        }
                    }
                    else {
                        delivery.recordDeliveryRequest();
                        await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
                    }
                }
                if (!decisionSubmitted && retentionFailure === undefined && opened.streamFailure === undefined
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
                if (opened.streamFailure !== undefined)
                    throw opened.streamFailure;
                if (retentionFailure === undefined)
                    throw error;
            }
            if (options.signal?.aborted)
                throw options.signal.reason;
            if (opened.streamFailure !== undefined)
                throw opened.streamFailure;
            if (!decisionSubmitted && decisionToolFailure !== undefined)
                throw decisionToolFailure;
            const relevantResponse = !decisionSubmitted
                ? boundaryResponse
                : (retainedResponse && retainedResponse.role === "assistant" && retainedResponse.content.some((part) => part.type === "toolCall" && part.name === tool.name)
                    ? retainedResponse
                    : undefined);
            if (relevantResponse !== undefined) {
                const toolFailure = findToolFailure(relevantResponse);
                if (toolFailure !== undefined)
                    throw toolFailure;
            }
            const assistants = [...retainedAssistants].reverse();
            const response = !decisionSubmitted
                ? assistants[0]
                : assistants.find((message) => message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
            if (boundaryResponse !== undefined && boundaryResponse.stopReason !== "error" && !decisionSubmitted && noReceiptLifecycle === undefined) {
                const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
                throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, {
                    stopReason: boundaryResponse.stopReason,
                    toolNames,
                });
            }
            if (response !== undefined) {
                try {
                    if (retentionFailure !== undefined)
                        throw retentionFailure;
                    if (retainedResponse === undefined)
                        options.retainResponse?.(response);
                }
                catch (retentionFailure) {
                    if (response.stopReason !== "error")
                        throw retentionFailure;
                    // Do not trim/rewrite the held errorMessage bytes.
                    const diagnostic = typeof response.errorMessage === "string" && response.errorMessage.trim() !== ""
                        ? response.errorMessage
                        : undefined;
                    const projected = projectStructuredRemote(response);
                    const failure = new Error(diagnostic ?? "", { cause: retentionFailure });
                    if (projected.hasTestimony && (response.model || response.provider)) {
                        failure.name = response.model || response.provider || "Error";
                        failure.failureCode = response.provider || response.model;
                    }
                    failure.knownCause = projected.hasTestimony ? "provider" : "unrecognized";
                    const retentionError = retentionFailure instanceof Error ? retentionFailure : undefined;
                    const retentionCause = retentionError?.cause;
                    failure.details = {
                        ...(diagnostic === undefined ? {} : { errorMessage: diagnostic }),
                        ...(projected.hasTestimony && response.provider ? { provider: response.provider } : {}),
                        ...(projected.hasTestimony && response.model ? { model: response.model } : {}),
                        ...(response.api ? { api: response.api } : {}),
                        ...(response.rawStopReason ? { rawStopReason: response.rawStopReason } : {}),
                        ...(projected.httpStatus === undefined ? {} : { httpStatus: projected.httpStatus }),
                        ...(projected.diagnostics === undefined ? {} : { diagnostics: projected.diagnostics }),
                        ...(projected.body === undefined ? {} : { body: projected.body }),
                        ...(projected.code === undefined ? {} : { code: projected.code }),
                        ...(projected.errno === undefined ? {} : { errno: projected.errno }),
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
                            ...(failure.failureCode === undefined ? {} : { identity: { name: failure.name, code: failure.failureCode } }),
                            ...(failure.message === "" ? {} : { diagnostic: failure.message }),
                            details: failure.details,
                        },
                    });
                    throw failure;
                }
            }
            if (response === undefined
                || response.stopReason === "error"
                || (!decisionSubmitted && (response.stopReason === "aborted" || decision === undefined))) {
                throw new Error(response?.errorMessage ?? `${options.roleLabel} exited without a readable decision receipt`);
            }
            return {
                decision,
                response: { ...response, usage: sessionUsage },
                ...(noReceiptLifecycle === undefined ? {} : { noReceiptLifecycle }),
            };
        }
        catch (error) {
            auditorFailure = error;
            throw error;
        }
        finally {
            options.signal?.removeEventListener("abort", abort);
            await runChildCleanup([() => unsubscribe(), () => handle.close()], auditorFailure, options.roleLabel);
        }
    });
}
