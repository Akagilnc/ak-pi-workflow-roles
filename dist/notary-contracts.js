/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: pass | bounce.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";
import { openToolObject } from "./open-tool-schema.js";
export const NOTARY_OUTPUT_TOOL_NAME = "ak_notary_output";
export const NOTARY_ACCEPTED_TEXT = "符宝郎回执已接受";
export const NOTARY_SOURCE_RUN_FLAG = {
    name: "ak-notary-source-run",
    definition: {
        description: "Absolute source run directory bound for Notary self-fetch",
        type: "string",
    },
};
/** Package-owned kickoff only — callers supply zero prompt bytes (ADR 0067 / #448). */
export const NOTARY_FIXED_KICKOFF = "符宝郎案卷已受理；来源 run 定位见会话材料。";
export const notaryOutputSchema = openToolObject(Type.Object({
    status: Type.Unknown({
        description: "pass | bounce — 形状指引，非 schema 闸",
    }),
    findings: Type.Unknown({
        description: "string[] findings，随 pass 或 bounce 留存",
    }),
}));
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
/**
 * Project one explicit Notary release. Throws when there is no lawful explicit
 * pass / bounce — callers map that to the existing non-zero failure channel.
 */
export function validateNotaryOutput(value) {
    if (!isRecord(value)) {
        throw new Error("Notary output has no recognized execution discriminator");
    }
    const statusRaw = typeof value.status === "string" ? value.status : undefined;
    if (statusRaw === undefined) {
        throw new Error("Notary output has no recognized execution discriminator");
    }
    const status = statusRaw;
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
    throw new Error("Notary output has no recognized execution discriminator");
}
export function validateRecordedNotaryOutput(value) {
    return validateNotaryOutput(value);
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
