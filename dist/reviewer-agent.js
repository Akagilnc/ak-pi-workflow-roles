import { isReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
import { executeReviewerChild } from "./reviewer-child-executor.js";
import { createReviewerWorkspaceOwner } from "./reviewer-workspace.js";
const RUNNER_PREREQUISITES = ["runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot"];
export class ReviewerDispatchExecutionError extends Error {
    outcome;
    constructor(outcome) {
        super("Reviewer dispatch execution failed");
        this.outcome = outcome;
        this.name = "ReviewerDispatchExecutionError";
    }
}
function classify(error, signal) { if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
    return "cancelled"; if (typeof error === "object" && error !== null && "reviewerFailure" in error)
    return error.reviewerFailure; return "unknown"; }
function failed(error, target, prompt, signal, retained) { const attached = typeof error === "object" && error !== null ? error : {}; return Object.freeze({ status: "failed", failure: classify(error, signal), target: attached.targetSnapshot ?? target, prompt, workspaceDisposition: retained === undefined ? attached.workspaceDisposition ?? "not-created" : { retained } }); }
export function createReviewerAgentRunner(dependencies = {}) {
    const workspaceOwner = createReviewerWorkspaceOwner(dependencies.fault === undefined ? {} : { fault: dependencies.fault });
    let accepted = false;
    return {
        async run(dispatch, options) {
            if (dispatch.recipe !== "reviewer-common-bundle-v1" || dispatch.legs.length < 1 || dispatch.legs.length > 2 || dispatch.legs[0]?.axis !== "standards" || (dispatch.legs.length === 2 && dispatch.legs[1]?.axis !== "spec"))
                throw new Error("Invalid accepted Reviewer dispatch cardinality or axes");
            if (accepted)
                throw new Error("Reviewer runner accepts exactly one dispatch");
            accepted = true;
            for (const leg of dispatch.legs)
                if (!isReviewerPromptIdentity(leg.prompt))
                    throw new Error("Accepted Reviewer prompt evidence mismatch");
            for (const operation of RUNNER_PREREQUISITES)
                if (!dispatch.prerequisiteOperations.includes(operation))
                    throw new Error(`Missing accepted runner prerequisite: ${operation}`);
            let batch;
            try {
                batch = await workspaceOwner.prepare(dispatch.targetSnapshot, dispatch.legs.map(l => l.axis), dispatch.bundle, options.signal);
            }
            catch (error) {
                const prepared = typeof error === "object" && error !== null && "preparedWorkspaces" in error ? error.preparedWorkspaces ?? [] : [];
                const failedIndex = prepared.length;
                const legs = Object.fromEntries(dispatch.legs.map((leg, index) => [leg.axis, failed(error, dispatch.targetSnapshot, leg.prompt, options.signal, index < failedIndex ? prepared[index].path : undefined)]));
                // Siblings not yet attempted have no workspace; do not borrow the failed leg's retained path.
                for (let index = failedIndex + 1; index < dispatch.legs.length; index += 1) {
                    const axis = dispatch.legs[index].axis;
                    legs[axis] = Object.freeze({ ...legs[axis], workspaceDisposition: "not-created" });
                }
                const target = Object.values(legs)[0].target;
                throw new ReviewerDispatchExecutionError(Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(legs) }));
            }
            const settled = await Promise.allSettled(batch.workspaces.map(async (workspace) => {
                const leg = dispatch.legs.find(candidate => candidate.axis === workspace.axis);
                try {
                    const child = await executeReviewerChild(workspace.path, leg, options.context, options.signal, dependencies.fault);
                    const disposition = await workspaceOwner.dispose(workspace);
                    return [leg.axis, Object.freeze({ status: "successful", report: child.report, usage: child.usage, target: batch.target, prompt: child.prompt, workspaceDisposition: disposition, runtimeConstructionEvidence: workspace.evidence })];
                }
                catch (error) {
                    return [leg.axis, failed(error, batch.target, leg.prompt, options.signal, workspace.path)];
                }
            }));
            const pairs = settled.map(item => item.status === "fulfilled" ? item.value : (() => { throw item.reason; })());
            const outcome = Object.freeze({ identity: dispatch.identity, target: batch.target, legs: Object.freeze(Object.fromEntries(pairs)) });
            if (Object.values(outcome.legs).some(leg => leg?.status === "failed"))
                throw new ReviewerDispatchExecutionError(outcome);
            return outcome;
        },
        shutdown: () => workspaceOwner.shutdown(),
    };
}
