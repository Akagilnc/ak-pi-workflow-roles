/** Package-owned Reviewer intent and runtime-receipt leaves — no role registration surface. */
import { isReviewerPromptIdentity } from "../reviewer-prompt-identity.js";
import { sha256Hex } from "../sha256.js";
import { verifyBundleIdentity } from "../reviewer-construction.js";
export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "Reviewer report accepted";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
    const keys = Object.keys(value);
    return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function validWorkspace(value) {
    return value === "deleted" || value === "not-created" || (isRecord(value) && exactKeys(value, ["retained"]) && typeof value.retained === "string" && value.retained.length > 0);
}
const failures = new Set(["cancelled", "provider", "snapshot", "workspace", "child", "unknown"]);
export function validateReviewerIntent(output) {
    if (!isRecord(output))
        throw new Error("Reviewer output must be a completed or refused intent");
    if (output.status === "completed" && exactKeys(output, ["status"]))
        return { status: "completed" };
    if (output.status === "refused" && exactKeys(output, ["status", "diagnostic"]) && typeof output.diagnostic === "string" && output.diagnostic.trim().length > 0) {
        return { status: "refused", diagnostic: output.diagnostic };
    }
    throw new Error("Reviewer completed intent has no report; refused requires only a separate non-blank diagnostic");
}
/** Validate the runtime-owned V2 receipt, including all byte identities and outcome/report laws. */
export function validateRuntimeReviewerReceipt(output) {
    if (!isRecord(output) || !exactKeys(output, ["version", "status", "reports", "outcomes", "identities"], ["diagnostic", "batchIdentity"]) || output.version !== 2 ||
        (output.status !== "completed" && output.status !== "refused") || !isRecord(output.reports) || !isRecord(output.outcomes) || !isRecord(output.identities))
        throw new Error("Invalid Reviewer V2 receipt");
    if (output.status === "completed" ? Object.hasOwn(output, "diagnostic") : typeof output.diagnostic !== "string" || output.diagnostic.trim().length === 0)
        throw new Error("Reviewer receipt diagnostic disagrees with status");
    if (!exactKeys(output.reports, [], ["standards", "spec"]) || !exactKeys(output.outcomes, [], ["standards", "spec"]) ||
        !exactKeys(output.identities, ["canonicalSkill"], ["construction", "target"]))
        throw new Error("Invalid Reviewer receipt projection keys");
    const skill = output.identities.canonicalSkill;
    if (!isRecord(skill) || !exactKeys(skill, ["sha256", "utf8Length", "snapshotIdentity"]) || !isRecord(skill.snapshotIdentity) ||
        !exactKeys(skill.snapshotIdentity, ["text", "utf8Length", "sha256"]) || !isReviewerPromptIdentity(skill.snapshotIdentity) ||
        skill.sha256 !== skill.snapshotIdentity.sha256 || skill.utf8Length !== skill.snapshotIdentity.utf8Length)
        throw new Error("Invalid canonical Skill content identity");
    const hasBatch = Object.hasOwn(output, "batchIdentity");
    if (hasBatch !== Object.hasOwn(output.identities, "construction") || hasBatch !== Object.hasOwn(output.identities, "target") ||
        (hasBatch && (typeof output.batchIdentity !== "string" || output.batchIdentity.length === 0 || !isRecord(output.identities.construction) || !isRecord(output.identities.target))))
        throw new Error("Incomplete Reviewer accepted-batch identity");
    if (hasBatch) {
        const construction = output.identities.construction;
        const target = output.identities.target;
        if (!exactKeys(construction, ["recipe", "bundle"]) || construction.recipe !== "reviewer-common-bundle-v1" || !isRecord(construction.bundle) || !verifyBundleIdentity(construction.bundle) ||
            !exactKeys(target, ["repositoryRoot", "objectFormat", "targetHead", "refs"]) || typeof target.repositoryRoot !== "string" || target.repositoryRoot.length === 0 ||
            (target.objectFormat !== "sha1" && target.objectFormat !== "sha256") || typeof target.targetHead !== "string" || target.targetHead.length === 0 || !isRecord(target.refs) ||
            Object.values(target.refs).some((ref) => !isRecord(ref) || !exactKeys(ref, ["objectId", "peeledCommitId"]) || typeof ref.objectId !== "string" || typeof ref.peeledCommitId !== "string"))
            throw new Error("Invalid Reviewer construction or target identity");
    }
    for (const axis of ["standards", "spec"]) {
        const report = output.reports[axis];
        const outcome = output.outcomes[axis];
        if (report !== undefined && (!isRecord(report) || !exactKeys(report, ["text", "utf8Length", "sha256"]) || typeof report.text !== "string" ||
            report.utf8Length !== Buffer.byteLength(report.text, "utf8") || report.sha256 !== sha256Hex(report.text)))
            throw new Error("Invalid Reviewer report identity");
        if (outcome === undefined) {
            if (report !== undefined)
                throw new Error("Reviewer report lacks outcome");
            continue;
        }
        if (!isRecord(outcome) || !exactKeys(outcome, ["status", "prompt", "workspaceDisposition"], ["failure"]) ||
            (outcome.status !== "successful" && outcome.status !== "failed") || !isRecord(outcome.prompt) || !exactKeys(outcome.prompt, ["text", "utf8Length", "sha256"]) ||
            !isReviewerPromptIdentity(outcome.prompt) || !validWorkspace(outcome.workspaceDisposition))
            throw new Error("Invalid Reviewer outcome");
        if (outcome.status === "successful") {
            if (Object.hasOwn(outcome, "failure") || report === undefined)
                throw new Error("Successful Reviewer outcome requires exactly one report");
        }
        else if (!failures.has(outcome.failure) || report !== undefined)
            throw new Error("Failed Reviewer outcome requires a classification and no report");
    }
    const outcomeCount = Object.keys(output.outcomes).length;
    if (output.status === "completed" && (!hasBatch || outcomeCount === 0 || Object.values(output.outcomes).some((item) => item.status !== "successful")))
        throw new Error("Completed Reviewer receipt requires a successful accepted batch");
    if (!hasBatch && outcomeCount !== 0)
        throw new Error("Pre-acceptance Reviewer refusal cannot contain outcomes");
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
/** Legacy entry point validates only terminating-tool arguments. */
export const validateAcceptedReviewerDetails = validateReviewerIntent;
