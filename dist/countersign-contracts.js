/**
 * Public Countersign (给事中) terminating receipt contracts.
 * Lawful verdicts: converged (署) | continue (封驳) | escalate (上呈).
 * (#572 / ADR 0074)
 */
import { Type } from "typebox";
import { openToolObject } from "./open-tool-schema.js";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.js";
export const COUNTERSIGN_OUTPUT_TOOL_NAME = "ak_countersign_output";
export const COUNTERSIGN_ACCEPTED_TEXT = "给事中回执已接受";
export const countersignOutputSchema = withInfrastructureFailureDeclaration(openToolObject(Type.Object({
    countersignStatus: Type.Unknown({
        description: "converged（署）| continue（封驳）| escalate（上呈）— 形状指引，非 schema 闸",
    }),
    note: Type.Unknown({
        description: "裁决理由叙事，随态留存",
    }),
    findings: Type.Unknown({
        description: "string[] 逐条理由与证据指针",
    }),
})));
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
/**
 * Project one lawful explicit Countersign verdict (署 | 封驳 | 上呈).
 * No throw on shape — ADR 0055 / 第 0 条: already-submitted params are retained
 * as-is; public-terminal projects non-usable verdicts via typed failure cause.
 */
export function projectLawfulCountersignOutput(value) {
    if (!isRecord(value))
        return undefined;
    const status = typeof value.countersignStatus === "string" ? value.countersignStatus : undefined;
    if (status === "continue") {
        const clone = structuredClone(value);
        if (clone.disposition === undefined)
            clone.disposition = "rewrite";
        if (!Array.isArray(clone.findings))
            clone.findings = asStringArray(clone.findings);
        return clone;
    }
    if (status === "converged" || status === "escalate") {
        const clone = structuredClone(value);
        if (!Array.isArray(clone.findings))
            clone.findings = asStringArray(clone.findings);
        return clone;
    }
    return undefined;
}
/** Retain submitted Countersign params as-is for the failure channel (no shape rewrite). */
export function retainCountersignSubmission(value) {
    if (value === undefined)
        return { missing: "arguments" };
    try {
        return structuredClone(value);
    }
    catch {
        return value;
    }
}
/**
 * Settlement/recording path: only lawful recorded verdicts.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedCountersignOutput(value) {
    const projected = projectLawfulCountersignOutput(value);
    if (projected === undefined) {
        throw new Error("Countersign output has no recognized execution discriminator");
    }
    return projected;
}
export function countersignDecisiveFacts(output) {
    const facts = { countersignStatus: output.countersignStatus };
    facts.findingsCount = Array.isArray(output.findings) ? output.findings.length : 0;
    if (output.countersignStatus === "continue") {
        facts.disposition = "rewrite";
    }
    return facts;
}
