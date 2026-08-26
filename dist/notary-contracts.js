/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: pass | bounce.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { Type } from "typebox";
import { readActivationEngineLaborFallbackField, seatFallbackBaseStatus, seatFallbackStatusHasLawfulEvidence, withEngineLaborFallbackField, } from "./engine-labor-fallback.js";
import { openToolObject } from "./open-tool-schema.js";
export const NOTARY_OUTPUT_TOOL_NAME = "ak_notary_output";
export const NOTARY_ACCEPTED_TEXT = "Notary output accepted";
export const NOTARY_SOURCE_RUN_FLAG = {
    name: "ak-notary-source-run",
    definition: {
        description: "Absolute source run directory bound for Notary self-fetch",
        type: "string",
    },
};
/** Package-owned kickoff only — callers supply zero prompt bytes (ADR 0067 / #448). */
export const NOTARY_FIXED_KICKOFF = "Notary review. Bound source-run locator is on the session materials; fetch authoritative ticket, git, and dossier evidence yourself; submit one typed decision.";
export const notaryOutputSchema = openToolObject(Type.Object({
    status: Type.Unknown({
        description: "pass | bounce — guidance, not a schema gate.",
    }),
    findings: Type.Unknown({
        description: "string[] findings retained with pass or bounce.",
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
    if (statusRaw === undefined || !seatFallbackStatusHasLawfulEvidence(statusRaw, value)) {
        throw new Error("Notary output has no recognized execution discriminator");
    }
    const status = seatFallbackBaseStatus(statusRaw);
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
/** Shape check for recorded accepted details (may include engineLaborFallback). */
export function validateRecordedNotaryOutput(value) {
    return validateNotaryOutput(value);
}
export function withNotaryAcceptedDetails(output) {
    return withEngineLaborFallbackField(output, readActivationEngineLaborFallbackField());
}
export function notaryDecisiveFacts(output) {
    const status = seatFallbackBaseStatus(String(output.status));
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
