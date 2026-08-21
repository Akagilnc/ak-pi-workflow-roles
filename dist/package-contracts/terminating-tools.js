/**
 * Package-owned terminating tool registry.
 * Package roles share these terminating leaves.
 */
import { COLLECTOR_ACCEPTED_TEXT, COLLECTOR_OUTPUT_TOOL, validateAcceptedCollectorReceipt, } from "./collector-output.js";
import { JUDGE_ACCEPTED_TEXT, JUDGE_OUTPUT_TOOL_NAME, validateAcceptedJudgeDetails, } from "./judge-output.js";
import { REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, projectReviewerIntentToReceipt, validateReviewerIntent, validateRuntimeReviewerReceipt, } from "./reviewer-output.js";
import { isAuditEscalationResult } from "../audit-escalation.js";
import { seatFallbackBaseStatus } from "../engine-labor-fallback.js";
import { DOCTOR_OUTPUT_TOOL_NAME, validateDoctorSubmissionShape, validateRecordedDoctorOutput } from "../doctor-contracts.js";
import { MERGER_ACCEPTED_TEXT, MERGER_OUTPUT_TOOL_NAME, validateMergerOutput } from "../merger-contracts.js";
import { CODER_ACCEPTED_TEXT, CODER_OUTPUT_TOOL_NAME, FIXER_ACCEPTED_TEXT, FIXER_OUTPUT_TOOL_NAME, validateAcceptedWorkerDetails, } from "./worker-output.js";
export { CODER_ACCEPTED_TEXT, CODER_OUTPUT_TOOL_NAME, COLLECTOR_ACCEPTED_TEXT, COLLECTOR_OUTPUT_TOOL, FIXER_ACCEPTED_TEXT, FIXER_OUTPUT_TOOL_NAME, JUDGE_ACCEPTED_TEXT, JUDGE_OUTPUT_TOOL_NAME, REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, MERGER_ACCEPTED_TEXT, MERGER_OUTPUT_TOOL_NAME, validateAcceptedCollectorReceipt, validateAcceptedJudgeDetails, projectReviewerIntentToReceipt, validateReviewerIntent, validateRuntimeReviewerReceipt, validateAcceptedWorkerDetails, validateDoctorSubmissionShape, validateRecordedDoctorOutput, validateMergerOutput, };
export const TERMINATING_TOOL_NAMES = [
    CODER_OUTPUT_TOOL_NAME,
    FIXER_OUTPUT_TOOL_NAME,
    REVIEWER_OUTPUT_TOOL_NAME,
    JUDGE_OUTPUT_TOOL_NAME,
    COLLECTOR_OUTPUT_TOOL,
    DOCTOR_OUTPUT_TOOL_NAME,
    MERGER_OUTPUT_TOOL_NAME,
];
export function isTerminatingToolName(name) {
    return TERMINATING_TOOL_NAMES.includes(name);
}
export function acceptedTextFor(toolName) {
    switch (toolName) {
        case CODER_OUTPUT_TOOL_NAME:
            return CODER_ACCEPTED_TEXT;
        case FIXER_OUTPUT_TOOL_NAME:
            return FIXER_ACCEPTED_TEXT;
        case REVIEWER_OUTPUT_TOOL_NAME:
            return REVIEWER_ACCEPTED_TEXT;
        case JUDGE_OUTPUT_TOOL_NAME:
            return JUDGE_ACCEPTED_TEXT;
        case COLLECTOR_OUTPUT_TOOL:
            return COLLECTOR_ACCEPTED_TEXT;
        case DOCTOR_OUTPUT_TOOL_NAME:
            return "Doctor output accepted";
        case MERGER_OUTPUT_TOOL_NAME:
            return MERGER_ACCEPTED_TEXT;
    }
}
export class AcceptedDetailsContractError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AcceptedDetailsContractError";
    }
}
function safeProperty(candidate, property) {
    try {
        return candidate?.[property];
    }
    catch {
        return undefined;
    }
}
export function validateAcceptedDetails(toolName, details) {
    const candidate = details !== null && typeof details === "object" && !Array.isArray(details)
        ? details
        : undefined;
    let auditEscalation = false;
    try {
        auditEscalation = isAuditEscalationResult(details);
    }
    catch {
        // Hostile getters are not recognizable audit escalation evidence.
    }
    if (auditEscalation || safeProperty(candidate, "kind") === "audit_escalation") {
        throw new AcceptedDetailsContractError("audit escalation is not an accepted role receipt");
    }
    const discriminator = safeProperty(candidate, toolName === JUDGE_OUTPUT_TOOL_NAME ? "judgeStatus" : "status");
    const lawfulStatuses = {
        [CODER_OUTPUT_TOOL_NAME]: ["planned", "completed", "refused", "unfinished"],
        [FIXER_OUTPUT_TOOL_NAME]: ["planned", "completed", "refused", "partially_completed", "unfinished"],
        [REVIEWER_OUTPUT_TOOL_NAME]: ["completed", "refused"],
        [JUDGE_OUTPUT_TOOL_NAME]: ["converged", "continue", "escalate"],
        [COLLECTOR_OUTPUT_TOOL]: [],
        [DOCTOR_OUTPUT_TOOL_NAME]: ["completed", "refused"],
        [MERGER_OUTPUT_TOOL_NAME]: ["completed", "escalate"],
    };
    const collectorDiscriminator = toolName === COLLECTOR_OUTPUT_TOOL && Array.isArray(candidate?.groups);
    const baseDiscriminator = typeof discriminator === "string" ? seatFallbackBaseStatus(discriminator) : discriminator;
    const runtimeBindingMissing = (toolName === DOCTOR_OUTPUT_TOOL_NAME && baseDiscriminator === "completed" && !(candidate?.cost !== null && typeof candidate?.cost === "object")) ||
        (toolName === REVIEWER_OUTPUT_TOOL_NAME && candidate?.version !== 2);
    if (runtimeBindingMissing || (!collectorDiscriminator && (typeof discriminator !== "string" || !lawfulStatuses[toolName].includes(baseDiscriminator)))) {
        throw new AcceptedDetailsContractError("terminating receipt has no recognized execution discriminator");
    }
    try {
        switch (toolName) {
            case CODER_OUTPUT_TOOL_NAME:
                return validateAcceptedWorkerDetails(details, "Coder");
            case FIXER_OUTPUT_TOOL_NAME:
                return validateAcceptedWorkerDetails(details, "Fixer");
            case REVIEWER_OUTPUT_TOOL_NAME:
                return validateRuntimeReviewerReceipt(details);
            case JUDGE_OUTPUT_TOOL_NAME:
                return validateAcceptedJudgeDetails(details);
            case COLLECTOR_OUTPUT_TOOL:
                return validateAcceptedCollectorReceipt(details);
            case DOCTOR_OUTPUT_TOOL_NAME:
                return validateRecordedDoctorOutput(details);
            case MERGER_OUTPUT_TOOL_NAME:
                return validateMergerOutput(details);
        }
    }
    catch (error) {
        if (error instanceof Error && error.constructor === Error)
            throw new AcceptedDetailsContractError(error.message, { cause: error });
        throw error;
    }
}
export function validateAcceptedLifecycle(toolName, argumentsValue, detailsValue) {
    const details = validateAcceptedDetails(toolName, detailsValue);
    if (toolName === DOCTOR_OUTPUT_TOOL_NAME) {
        const testimony = validateDoctorSubmissionShape(argumentsValue);
        if (seatFallbackBaseStatus(String(testimony.status)) === "refused") {
            if (!deepEqual(testimony, details))
                throw new Error("accepted tool lifecycle details mismatch");
            return details;
        }
        const receipt = details;
        if (seatFallbackBaseStatus(String(receipt.status)) !== "completed") {
            throw new Error("accepted tool lifecycle details mismatch");
        }
        const { cost: _runtimeCost, ...projected } = receipt;
        if (!deepEqual(testimony, projected))
            throw new Error("accepted tool lifecycle details mismatch");
        return details;
    }
    const argumentsDetails = validateAcceptedDetails(toolName, argumentsValue);
    if (!deepEqual(argumentsDetails, details))
        throw new Error("accepted tool lifecycle details mismatch");
    return details;
}
export function acceptedFacts(toolName, details) {
    switch (toolName) {
        case CODER_OUTPUT_TOOL_NAME:
        case FIXER_OUTPUT_TOOL_NAME:
        case REVIEWER_OUTPUT_TOOL_NAME:
        case DOCTOR_OUTPUT_TOOL_NAME: return { status: details.status };
        case JUDGE_OUTPUT_TOOL_NAME: return { status: details.judgeStatus };
        case MERGER_OUTPUT_TOOL_NAME: {
            const output = details;
            const status = output.status;
            return { status, ...(seatFallbackBaseStatus(status) === "completed" && typeof output.mergeCommitId === "string" ? { commit: output.mergeCommitId } : {}) };
        }
        case COLLECTOR_OUTPUT_TOOL:
            return { status: "collected" };
    }
}
/** Deep structural equality for lifecycle agreement checks. */
export function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null)
        return a === b;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    if (typeof a === "object") {
        if (typeof b !== "object" || b === null || Array.isArray(b))
            return false;
        const aKeys = Object.keys(a).sort();
        const bKeys = Object.keys(b).sort();
        if (aKeys.length !== bKeys.length)
            return false;
        if (!aKeys.every((key, index) => key === bKeys[index]))
            return false;
        return aKeys.every((key) => deepEqual(a[key], b[key]));
    }
    return false;
}
