/**
 * Package-owned terminating tool registry.
 * Recorder and roles share these leaves; Recorder must not load role registration.
 */
import { COLLECTOR_ACCEPTED_TEXT, COLLECTOR_OUTPUT_TOOL, validateAcceptedCollectorReceipt, } from "./collector-output.js";
import { JUDGE_ACCEPTED_TEXT, JUDGE_OUTPUT_TOOL_NAME, validateAcceptedJudgeDetails, } from "./judge-output.js";
import { REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, projectReviewerIntentToReceipt, validateReviewerIntent, validateRuntimeReviewerReceipt, } from "./reviewer-output.js";
import { DOCTOR_OUTPUT_TOOL_NAME, validateRecordedDoctorOutput } from "../doctor-contracts.js";
import { CODER_ACCEPTED_TEXT, CODER_OUTPUT_TOOL_NAME, FIXER_ACCEPTED_TEXT, FIXER_OUTPUT_TOOL_NAME, validateAcceptedWorkerDetails, } from "./worker-output.js";
export { CODER_ACCEPTED_TEXT, CODER_OUTPUT_TOOL_NAME, COLLECTOR_ACCEPTED_TEXT, COLLECTOR_OUTPUT_TOOL, FIXER_ACCEPTED_TEXT, FIXER_OUTPUT_TOOL_NAME, JUDGE_ACCEPTED_TEXT, JUDGE_OUTPUT_TOOL_NAME, REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, validateAcceptedCollectorReceipt, validateAcceptedJudgeDetails, projectReviewerIntentToReceipt, validateReviewerIntent, validateRuntimeReviewerReceipt, validateAcceptedWorkerDetails, validateRecordedDoctorOutput, };
export const TERMINATING_TOOL_NAMES = [
    CODER_OUTPUT_TOOL_NAME,
    FIXER_OUTPUT_TOOL_NAME,
    REVIEWER_OUTPUT_TOOL_NAME,
    JUDGE_OUTPUT_TOOL_NAME,
    COLLECTOR_OUTPUT_TOOL,
    DOCTOR_OUTPUT_TOOL_NAME,
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
    }
}
export class AcceptedDetailsContractError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AcceptedDetailsContractError";
    }
}
export function validateAcceptedDetails(toolName, details) {
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
        }
    }
    catch (error) {
        if (error instanceof Error && error.constructor === Error)
            throw new AcceptedDetailsContractError(error.message, { cause: error });
        throw error;
    }
}
export function acceptedFacts(toolName, details) {
    switch (toolName) {
        case CODER_OUTPUT_TOOL_NAME:
        case FIXER_OUTPUT_TOOL_NAME: {
            const output = details;
            return { status: output.status, ...(output.commitSha ? { commit: output.commitSha } : {}) };
        }
        case REVIEWER_OUTPUT_TOOL_NAME: return { status: details.status };
        case JUDGE_OUTPUT_TOOL_NAME: return { status: details.judgeStatus };
        case DOCTOR_OUTPUT_TOOL_NAME: return { status: details.status };
        case COLLECTOR_OUTPUT_TOOL: return {};
    }
}
export function carriesPackageAuditObservation(toolName) {
    return (toolName === JUDGE_OUTPUT_TOOL_NAME ||
        toolName === REVIEWER_OUTPUT_TOOL_NAME ||
        toolName === DOCTOR_OUTPUT_TOOL_NAME);
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
