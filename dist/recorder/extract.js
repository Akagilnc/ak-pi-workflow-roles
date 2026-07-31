import { carriesPackageAuditObservation, COLLECTOR_OUTPUT_TOOL, deepEqual, isTerminatingToolName, validateAcceptedDetails, } from "../package-contracts/terminating-tools.js";
import { RecorderError } from "./errors.js";
import { combineReports, scanJsonValue } from "./scanner.js";
const emptyReport = { hits: [], redacted: false };
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, required, optional = []) => required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const invalid = () => { throw new RecorderError("acceptance-invalid"); };
function collectorProjection(argumentsValue, details) {
    if (!isRecord(argumentsValue) || !hasExactKeys(argumentsValue, ["legs"]) || !Array.isArray(argumentsValue.legs) || !isRecord(details) || !Array.isArray(details.legs))
        return false;
    const projected = details.legs.map((leg) => {
        if (!isRecord(leg))
            return leg;
        const { unavailableScope: _omitted, ...rest } = leg;
        return rest;
    });
    return deepEqual(argumentsValue.legs, projected);
}
function usageOf(value) {
    if (!isRecord(value))
        return undefined;
    const usage = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        const count = value[key];
        if (typeof count === "number" && Number.isFinite(count) && count >= 0)
            usage[key] = count;
    }
    return Object.keys(usage).length ? usage : undefined;
}
function receiptKind(toolName) {
    if (toolName === "ak_collector_output")
        return "collector";
    if (toolName === "ak_judge_output")
        return "judge";
    if (toolName === "ak_reviewer_output")
        return "reviewer";
    return "worker";
}
function directIssuance(row, index) {
    if (row.type !== "message" || !isRecord(row.message))
        return null;
    const message = row.message;
    if (message.role !== "assistant" || !Array.isArray(message.content))
        return null;
    const packageCalls = message.content.filter((part) => isRecord(part) && typeof part.name === "string" && isTerminatingToolName(part.name));
    if (!packageCalls.length)
        return null;
    if (!hasExactKeys(row, ["type", "id", "parentId", "timestamp", "message"]) ||
        !hasExactKeys(message, ["role", "content", "stopReason", "timestamp"]) ||
        message.stopReason !== "toolUse" || typeof message.timestamp !== "number" || message.content.length !== 1)
        invalid();
    const call = packageCalls[0];
    if (!hasExactKeys(call, ["type", "id", "name", "arguments"]) || call.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !isTerminatingToolName(call.name))
        invalid();
    return { index, rowId: row.id, toolCallId: call.id, toolName: call.name, arguments: call.arguments };
}
function directResult(row) {
    if (row.type !== "message" || !isRecord(row.message))
        return null;
    const message = row.message;
    if (message.role !== "toolResult" || typeof message.toolName !== "string" || !isTerminatingToolName(message.toolName))
        return null;
    if (!hasExactKeys(row, ["type", "id", "parentId", "timestamp", "message"]) ||
        !hasExactKeys(message, ["role", "toolCallId", "toolName", "content", "isError", "details"], ["timestamp", "usage"]) ||
        typeof message.toolCallId !== "string" || !message.toolCallId ||
        (Object.hasOwn(message, "timestamp") && typeof message.timestamp !== "number"))
        invalid();
    return message;
}
/** Streaming reducer for the direct package lifecycle. Rejected payloads are discarded as each pair closes. */
export class AcceptanceCollector {
    #pendingIssuance = null;
    #acceptedPair = null;
    #usedCallIds = new Set();
    #sawPackageLifecycle = false;
    accept(value, index) {
        if (!isRecord(value))
            return;
        const issuance = directIssuance(value, index);
        const resultMessage = directResult(value);
        if (!issuance && !resultMessage)
            return;
        this.#sawPackageLifecycle = true;
        if (issuance) {
            if (this.#pendingIssuance || this.#usedCallIds.has(issuance.toolCallId))
                invalid();
            this.#pendingIssuance = issuance;
            return;
        }
        const pending = this.#pendingIssuance;
        if (!pending || index !== pending.index + 1 || value.parentId !== pending.rowId ||
            resultMessage.toolCallId !== pending.toolCallId || resultMessage.toolName !== pending.toolName) {
            throw new RecorderError("acceptance-invalid");
        }
        this.#usedCallIds.add(pending.toolCallId);
        this.#pendingIssuance = null;
        if (resultMessage.isError === true)
            return;
        if (resultMessage.isError !== false || this.#acceptedPair)
            invalid();
        this.#acceptedPair = { issuance: pending, resultIndex: index, resultMessage: resultMessage };
    }
    finish(rowCount) {
        if (this.#pendingIssuance)
            invalid();
        if (!this.#acceptedPair) {
            if (this.#sawPackageLifecycle)
                throw new RecorderError("acceptance-missing");
            throw new RecorderError("acceptance-missing");
        }
        if (this.#acceptedPair.resultIndex !== rowCount - 1 || this.#acceptedPair.issuance.index !== rowCount - 2)
            invalid();
        return finalizeAcceptedPair(this.#acceptedPair);
    }
}
function finalizeAcceptedPair(pair) {
    const { issuance, resultMessage } = pair;
    const content = resultMessage.content;
    if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0]) ||
        !hasExactKeys(content[0], ["type", "text"]) || content[0].type !== "text" || typeof content[0].text !== "string")
        invalid();
    const detailsMatch = issuance.toolName === COLLECTOR_OUTPUT_TOOL
        ? collectorProjection(issuance.arguments, resultMessage.details)
        : deepEqual(issuance.arguments, resultMessage.details);
    if (!detailsMatch)
        invalid();
    let details;
    try {
        details = validateAcceptedDetails(issuance.toolName, resultMessage.details);
    }
    catch {
        throw new RecorderError("acceptance-invalid");
    }
    const accepted = { toolName: issuance.toolName, toolCallId: issuance.toolCallId, details };
    const scanned = scanJsonValue(accepted, "receipt");
    try {
        validateAcceptedDetails(issuance.toolName, scanned.value.details);
    }
    catch {
        throw new RecorderError("scan-failed");
    }
    const receipt = { ...scanned.value, kind: receiptKind(issuance.toolName) };
    let auditObservation = null;
    let report = scanned.report;
    if (carriesPackageAuditObservation(issuance.toolName)) {
        const usage = usageOf(resultMessage.usage);
        auditObservation = { toolName: issuance.toolName, toolCallId: issuance.toolCallId, auditPassed: true, ...(usage ? { usage } : {}) };
        if (usage)
            report = combineReports(report, scanJsonValue(usage, "audit.usage").report);
    }
    return {
        receipt,
        auditObservation,
        artifactKind: JSON.stringify(accepted) === JSON.stringify(scanned.value) ? "acceptedReceipt" : "sanitizedDerivativeOfAcceptedReceipt",
        report: report ?? emptyReport,
    };
}
