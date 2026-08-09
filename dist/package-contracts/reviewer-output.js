/** Package-owned Reviewer intent and runtime-receipt leaves — no role registration surface. */
import { verifyBundleIdentity } from "../reviewer-construction.js";
import { sha256Hex } from "../sha256.js";
export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "Reviewer report accepted";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function read(value, key) {
    if (!isRecord(value))
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
export function validateReviewerIntent(output) {
    const status = read(output, "status");
    if (status === "completed")
        return { status };
    if (status === "refused")
        return { status, diagnostic: read(output, "diagnostic") };
    throw new Error("Reviewer output has no recognized execution intent");
}
/** Validate runtime-owned facts at their real identity and materialization seams. */
export function validateRuntimeReviewerReceipt(output) {
    const acceptedBatch = read(output, "acceptedBatch");
    const identities = read(output, "identities");
    const construction = read(identities, "construction");
    const target = read(identities, "target");
    const reports = read(output, "reports");
    const outcomes = read(output, "outcomes");
    const legs = read(acceptedBatch, "legs");
    // A recognizable accepted batch must remain bound to its exact bundle and target.
    if (acceptedBatch !== undefined || construction !== undefined || target !== undefined) {
        if (!isRecord(acceptedBatch) || !isRecord(construction) || !isRecord(target) || !Array.isArray(legs))
            throw new Error("Incomplete Reviewer accepted-batch identity");
        const bundle = read(construction, "bundle");
        const entries = read(bundle, "entries");
        const objectFormat = read(target, "objectFormat");
        const objectId = (value) => typeof value === "string" && new RegExp(objectFormat === "sha1" ? "^[0-9a-f]{40}$" : "^[0-9a-f]{64}$").test(value);
        const refs = read(target, "refs");
        const skillText = read(read(identities, "canonicalSkill"), "text");
        const skillEntry = Array.isArray(entries) ? entries.find((entry) => read(entry, "origin") === "canonical-skill") : undefined;
        if (typeof skillText !== "string" || !isRecord(skillEntry) || read(skillEntry, "sha256") !== sha256Hex(skillText) || read(skillEntry, "utf8Length") !== Buffer.byteLength(skillText, "utf8") ||
            read(construction, "recipe") !== "reviewer-common-bundle-v1" || !isRecord(bundle) || !Array.isArray(entries) || !verifyBundleIdentity(bundle) ||
            (objectFormat !== "sha1" && objectFormat !== "sha256") || !objectId(read(target, "targetHead")) || !isRecord(refs) ||
            Object.values(refs).some((ref) => !isRecord(ref) || !objectId(read(ref, "objectId")) || (read(ref, "peeledCommitId") !== null && !objectId(read(ref, "peeledCommitId")))))
            throw new Error("Invalid Reviewer construction or target identity");
        const expectedAxes = legs.map((leg) => read(leg, "axis"));
        if (expectedAxes[0] !== "standards" || (expectedAxes.length === 2 && expectedAxes[1] !== "spec") || expectedAxes.length < 1 || expectedAxes.length > 2)
            throw new Error("Invalid Reviewer accepted-leg projection");
        if (!isRecord(outcomes) || !isRecord(reports))
            throw new Error("Accepted Reviewer batch lacks outcomes or reports");
        const outcomeAxes = Object.keys(outcomes).filter(axis => axis === "standards" || axis === "spec");
        if (outcomeAxes.length !== expectedAxes.length || outcomeAxes.some((axis, index) => axis !== expectedAxes[index]))
            throw new Error("Reviewer outcomes must exactly cover accepted legs in canonical order");
        for (const [index, axisValue] of expectedAxes.entries()) {
            const axis = axisValue;
            const outcome = read(outcomes, axis);
            if (!isRecord(outcome))
                throw new Error("Reviewer accepted leg lacks outcome");
            const expectedPrompt = read(read(legs[index], "prompt"), "text");
            const actualPrompt = read(read(outcome, "prompt"), "text");
            if (expectedPrompt !== actualPrompt)
                throw new Error("Reviewer outcome prompt disagrees with accepted leg");
            const materialized = read(outcome, "runtimeConstructionEvidence");
            const status = read(outcome, "status");
            const report = read(reports, axis);
            if (status === "successful" && (report === undefined || materialized === undefined))
                throw new Error("Successful Reviewer outcome lacks report or materialization evidence");
            if (status === "failed" && (report !== undefined || typeof read(outcome, "diagnostic") !== "string" || read(outcome, "diagnostic").trim() === ""))
                throw new Error("Failed Reviewer outcome requires a diagnostic and cannot bind a report");
            if (materialized !== undefined) {
                const materialEntries = read(materialized, "entries");
                if (!isRecord(materialized) || read(materialized, "leg") !== axis || typeof read(materialized, "workspaceIdentity") !== "string" || read(materialized, "workspaceIdentity") === "" ||
                    read(materialized, "manifestSha256") !== read(bundle, "manifestSha256") || !Array.isArray(materialEntries) || materialEntries.length !== entries.length || materialEntries.some((entry, entryIndex) => {
                    const expected = entries[entryIndex];
                    return !isRecord(entry) || read(entry, "verified") !== true || read(entry, "readable") !== true ||
                        read(entry, "id") !== read(expected, "id") || read(entry, "relativeClonePath") !== read(expected, "relativeClonePath") ||
                        read(entry, "utf8Length") !== read(expected, "utf8Length") || read(entry, "sha256") !== read(expected, "sha256");
                }))
                    throw new Error("Reviewer runtime construction evidence disagrees with accepted bundle or leg");
            }
        }
    }
    return output;
}
/** Project thin submitted intent onto runtime enrichment without comparing runtime-owned fields. */
export function projectReviewerIntentToReceipt(intentValue, receiptValue) {
    const intent = validateReviewerIntent(intentValue);
    const receipt = validateRuntimeReviewerReceipt(receiptValue);
    if (receipt.status !== intent.status || (intent.status === "completed" ? receipt.diagnostic !== undefined : receipt.diagnostic !== intent.diagnostic)) {
        throw new Error("Reviewer intent and runtime receipt disagree");
    }
    return receipt;
}
