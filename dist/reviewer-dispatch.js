import { exactUtf8 } from "./exact-utf8.js";
import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { acquireReviewerPinnedEvidence, createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
export { createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
import { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
import { sha256Hex } from "./sha256.js";
import { admitReviewerProposal, ReviewerAdmissionError, REVIEWER_CHILD_TOOLS, REVIEWER_PREREQUISITES } from "./reviewer-admission.js";
export { REVIEWER_CHILD_TOOLS, REVIEWER_PREREQUISITES } from "./reviewer-admission.js";
import { constructReviewerDispatch, ReviewerConstructionError } from "./reviewer-construction.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
export { sha256Hex } from "./sha256.js";
export { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
export const REVIEWER_PREFLIGHT_VIOLATIONS = ["proposal-invalid", "base-invalid", "material-invalid", "spec-invalid", "capability-invalid", "prerequisite-missing", "range-invalid", "prompt-identity-invalid", "prompt-identity-mismatch", "target-drift"];
export class ReviewerPreflightError extends Error {
    code;
    diagnostic;
    constructor(code, diagnostic = `${code} constraint failed`) {
        super(`${code}: ${diagnostic}`);
        this.code = code;
        this.diagnostic = diagnostic;
    }
}
const frozen = (xs) => Object.freeze([...xs]);
const exact = (v, keys) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function toReviewerExecution(dispatch) { return Object.freeze({ identity: dispatch.identity, recipe: dispatch.recipe, targetSnapshot: immutableReviewerPin(dispatch.targetSnapshot), bundle: dispatch.bundle, prerequisiteOperations: frozen(dispatch.prerequisiteOperations), legs: Object.freeze(dispatch.legs.map(l => Object.freeze({ axis: l.axis, prompt: Object.freeze({ ...l.prompt }), grant: Object.freeze({ tools: frozen(l.grant.tools), bashCommands: frozen(l.grant.bashCommands), prerequisiteOperations: frozen(l.grant.prerequisiteOperations) }) }))) }); }
export function parseReviewerCapabilities(raw, task) { let value, text; try {
    text = exactUtf8(raw, "Reviewer capabilities");
    value = JSON.parse(text);
}
catch {
    throw new Error("Invalid Reviewer capabilities UTF-8 JSON");
} if (!exact(value, ["version", "taskSha256", "tools", "prerequisiteOperations"]))
    throw new Error("Invalid Reviewer capabilities keys"); const v = value; if (v.version !== 1 || typeof v.taskSha256 !== "string" || !Array.isArray(v.tools) || !Array.isArray(v.prerequisiteOperations))
    throw new Error("Invalid Reviewer capabilities schema"); if (!/^[0-9a-f]{64}$/.test(v.taskSha256) || v.taskSha256 !== sha256Hex(task))
    throw new Error("Reviewer capabilities task digest mismatch"); if (!v.tools.every((x) => typeof x === "string" && REVIEWER_CHILD_TOOLS.includes(x)) || !v.prerequisiteOperations.every((x) => typeof x === "string" && REVIEWER_PREREQUISITES.includes(x)) || new Set(v.tools).size !== v.tools.length || new Set(v.prerequisiteOperations).size !== v.prerequisiteOperations.length)
    throw new Error("Reviewer capabilities contain unknown or duplicate values"); return Object.freeze({ version: 1, taskSha256: v.taskSha256, document: reviewerPromptIdentity(text), tools: frozen(v.tools), prerequisiteOperations: frozen(v.prerequisiteOperations) }); }
const identity = (proposal) => { const serialized = JSON.stringify(proposal); if (serialized === undefined)
    throw new TypeError("Reviewer proposal is not serializable"); return sha256Hex(serialized); };
const preflight = (error) => error instanceof ReviewerPreflightError ? error : error instanceof ReviewerAdmissionError || error instanceof ReviewerConstructionError || error instanceof ReviewerCorrectablePreflightError ? new ReviewerPreflightError(error.code, error.diagnostic) : undefined;
export function createReviewerDispatcher(d) {
    const task = Uint8Array.from(d.task), target = immutableReviewerPin(d.reader.pin), host = frozen(d.hostTools);
    let accepted, fatal, accepting = false;
    const rejections = [], closedAttempts = [];
    const close = (id) => { const e = Object.freeze({ identity: id, reason: "acceptance-closed", started: false }); d.decisionEvidence?.(Object.freeze({ disposition: "closed", ...e })); closedAttempts.push(e); return Object.freeze({ status: "closed", ...e }); };
    const reject = (id, e) => { const evidence = Object.freeze({ identity: id, violations: Object.freeze([e.code]), started: false }); d.decisionEvidence?.(Object.freeze({ disposition: "rejected", ...evidence })); rejections.push(evidence); return Object.freeze({ status: "rejected", identity: id, violations: evidence.violations, diagnostic: e.diagnostic }); };
    return Object.freeze({ get rejections() { return Object.freeze([...rejections]); }, get acceptance() { return accepted; }, get closedAttempts() { return Object.freeze([...closedAttempts]); }, async propose(proposal, invocation) { const id = identity(proposal); if (fatal !== undefined)
            throw fatal; if (accepted || accepting)
            return close(id); let dispatch; try {
            const admitted = admitReviewerProposal(proposal, d.capabilities, host);
            const evidence = await acquireReviewerPinnedEvidence(d.reader, target, admitted);
            let taskText;
            try {
                taskText = exactUtf8(task, "Reviewer task");
            }
            catch {
                throw new ReviewerPreflightError("prompt-identity-invalid", "Reviewer task must be valid UTF-8 before prompt identity compilation");
            }
            dispatch = constructReviewerDispatch({ identity: id, taskText, canonicalSkill: d.canonicalSkill, capabilityDocument: d.capabilities.document, target, admitted, evidence, ...(d.reviewScopeKeys === undefined ? {} : { reviewScopeKeys: d.reviewScopeKeys }), ...(d.compilePrompt === undefined ? {} : { compilePrompt: d.compilePrompt }) });
        }
        catch (error) {
            if (accepted || accepting)
                return close(id);
            const p = preflight(error);
            if (p)
                return reject(id, p);
            fatal = error;
            throw error;
        } if (accepted || accepting)
            return close(id); try {
            if (!sameReviewerPinnedTarget(await d.reader.snapshot(), target))
                throw new ReviewerPreflightError("target-drift", "pinned target snapshot changed before child execution");
        }
        catch (error) {
            if (accepted || accepting)
                return close(id);
            const p = preflight(error);
            if (p)
                return reject(id, p);
            fatal = error;
            throw error;
        } if (accepted || accepting)
            return close(id); d.decisionEvidence?.(Object.freeze({ disposition: "accepted", identity: id, dispatch })); accepting = true; accepted = Object.freeze({ identity: id, recipe: "reviewer-dispatch-v1", cardinality: dispatch.legs.length }); const results = await d.run(toReviewerExecution(dispatch), invocation); return Object.freeze({ status: "accepted", dispatch, results }); } });
}
