/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: pass | bounce.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";
import { openToolObject } from "./open-tool-schema.js";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.js";
export const NOTARY_OUTPUT_TOOL_NAME = "ak_notary_output";
export const NOTARY_ACCEPTED_TEXT = "符宝郎回执已接受";
export const NOTARY_SOURCE_RUN_FLAG = {
    name: "ak-notary-source-run",
    definition: {
        description: "Absolute source run directory bound for Notary self-fetch",
        type: "string",
    },
};
/** Optional ticket binding for court-diary (起居录) lookup — ADR 0075. */
export const NOTARY_TICKET_FLAG = {
    name: "ak-notary-ticket-number",
    definition: {
        description: "Optional ticket number for Notary court-diary lookup",
        type: "string",
    },
};
/** Package-owned kickoff only — callers supply zero prompt bytes (ADR 0067 / #448). */
export const NOTARY_FIXED_KICKOFF = "符宝郎案卷已受理；来源 run 定位见会话材料。";
export const notaryOutputSchema = withInfrastructureFailureDeclaration(openToolObject(Type.Object({
    status: Type.Unknown({
        description: "pass | bounce — 形状指引，非 schema 闸",
    }),
    findings: Type.Unknown({
        description: "string[] findings，随 pass 或 bounce 留存",
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
 * Project one lawful explicit Notary release (pass | bounce).
 * No throw on shape — ADR 0055 / 第 0 条: already-submitted params are retained as-is;
 * public-terminal projects non-usable releases via typed failure cause.
 */
export function projectLawfulNotaryOutput(value) {
    if (!isRecord(value))
        return undefined;
    const status = typeof value.status === "string" ? value.status : undefined;
    if (status === "bounce") {
        const clone = structuredClone(value);
        if (clone.disposition === undefined)
            clone.disposition = "rewrite";
        if (!Array.isArray(clone.findings))
            clone.findings = asStringArray(clone.findings);
        return clone;
    }
    if (status === "pass") {
        const clone = structuredClone(value);
        if (!Array.isArray(clone.findings))
            clone.findings = asStringArray(clone.findings);
        return clone;
    }
    return undefined;
}
/** Retain submitted Notary params as-is for the failure channel (no shape rewrite). */
export function retainNotarySubmission(value) {
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
 * Settlement/recording path: only lawful recorded pass/bounce.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedNotaryOutput(value) {
    const projected = projectLawfulNotaryOutput(value);
    if (projected === undefined) {
        throw new Error("Notary output has no recognized execution discriminator");
    }
    return projected;
}
export function notaryDecisiveFacts(output) {
    const status = String(output.status);
    const facts = { status, officer: "notary" };
    if (status === "pass" || status === "bounce") {
        const findings = output.findings;
        facts.findingsCount = Array.isArray(findings) ? findings.length : 0;
    }
    if (status === "bounce") {
        facts.disposition = "rewrite";
    }
    return facts;
}
