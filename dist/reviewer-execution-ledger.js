import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { isReviewerPromptText, sameReviewerPromptText } from "./reviewer-prompt-identity.js";
import { REVIEWER_PREFLIGHT_VIOLATIONS, } from "./reviewer-dispatch.js";
export function projectAcceptedDispatch(dispatch) {
    return {
        source: "reviewer-dispatch", type: "accepted", identity: dispatch.identity,
        recipe: dispatch.recipe, input: dispatch.input, target: dispatch.targetSnapshot,
        range: dispatch.range, legs: dispatch.legs,
    };
}
export function projectReviewerDispatchOutcome(ledger, dispatch, result) {
    if (result.identity !== dispatch.identity)
        throw new Error("Reviewer runner identity does not match accepted dispatch");
    if (!sameReviewerPinnedTarget(result.target, dispatch.targetSnapshot))
        throw new Error("Reviewer runner target does not match accepted pinned target");
    const expectedAxes = dispatch.legs.map(({ axis }) => axis).sort();
    const actualAxes = Object.keys(result.legs).sort();
    if (actualAxes.length !== expectedAxes.length || actualAxes.some((axis, index) => axis !== expectedAxes[index])) {
        throw new Error(`Reviewer runner result axes do not match accepted dispatch: expected ${expectedAxes.join(",")}; received ${actualAxes.join(",")}`);
    }
    for (const leg of dispatch.legs) {
        const actual = result.legs[leg.axis];
        if (actual === undefined)
            throw new Error(`Reviewer runner omitted ${leg.axis} result`);
        ledger.append(actual.status === "failed"
            ? { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: dispatch.identity, axis: leg.axis, status: "failed", prompt: actual.prompt, target: actual.target, failure: actual.failure, diagnostic: actual.diagnostic, workspaceDisposition: actual.workspaceDisposition }
            : { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: dispatch.identity, axis: leg.axis, status: "successful", prompt: actual.prompt, target: actual.target, report: actual.report, usage: actual.usage, workspaceDisposition: actual.workspaceDisposition });
    }
}
function cloneFreeze(value) {
    if (Array.isArray(value))
        return Object.freeze(value.map(cloneFreeze));
    if (typeof value === "object" && value !== null) {
        const copy = {};
        for (const [key, item] of Object.entries(value))
            copy[key] = cloneFreeze(item);
        return Object.freeze(copy);
    }
    return value;
}
function hasExactEventShape(event, keys) {
    const actual = Object.keys(event);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function fatal(error) {
    const record = typeof error === "object" && error !== null ? error : undefined;
    return cloneFreeze({
        diagnostics: "infrastructure-failure",
        cause: error,
        ...(record?.targetSnapshot === undefined ? {} : { targetSnapshot: record.targetSnapshot }),
        ...(record?.workspaceDisposition === undefined ? {} : { workspaceDisposition: record.workspaceDisposition }),
    });
}
export function createReviewerExecutionLedger() {
    const transportRejections = [];
    const rejections = [];
    const closedAttempts = [];
    let accepted;
    let started;
    const results = {};
    let infrastructureFailure;
    function append(raw) {
        const event = cloneFreeze(raw);
        if (event.source === "reviewer-transport" && event.type === "transport-rejected") {
            if (!hasExactEventShape(event, ["source", "type", "identity", "violation", "started"]) || event.violation !== "schema" || event.started !== false)
                throw new Error("Transport rejection must contain only immutable bounded non-start evidence");
            if (accepted !== undefined || started !== undefined)
                throw new Error("Transport rejection cannot follow an accepted dispatch");
            transportRejections.push(cloneFreeze({ identity: event.identity, violation: event.violation, started: false }));
            return;
        }
        if (event.source === "reviewer-transport" && event.type === "closed-attempt") {
            if (!hasExactEventShape(event, ["source", "type", "identity", "reason", "started"]) || event.reason !== "transport-after-acceptance" || event.started !== false)
                throw new Error("Closed transport attempt must contain only immutable bounded non-start evidence");
            if (accepted === undefined)
                throw new Error("Closed transport attempt requires acceptance");
            closedAttempts.push(cloneFreeze({ identity: event.identity, reason: event.reason, started: false }));
            return;
        }
        if (event.source === "reviewer-dispatch" && event.type === "rejected") {
            if (!hasExactEventShape(event, ["source", "type", "identity", "violations", "started"]) || event.started !== false ||
                event.violations.length === 0 || event.violations.some((code) => !REVIEWER_PREFLIGHT_VIOLATIONS.includes(code)))
                throw new Error("Rejected dispatch must contain only closed bounded non-start evidence");
            if (accepted !== undefined || started !== undefined)
                throw new Error("Rejection cannot follow an accepted dispatch");
            rejections.push(cloneFreeze({ identity: event.identity, violations: event.violations, started: false }));
            return;
        }
        if (event.source === "reviewer-dispatch" && event.type === "closed-attempt") {
            if (!hasExactEventShape(event, ["source", "type", "identity", "reason", "started"]) || event.reason !== "acceptance-closed" || event.started !== false)
                throw new Error("Closed attempt must contain only immutable non-start outcome evidence");
            if (accepted === undefined)
                throw new Error("Closed attempt requires a closed acceptance lifecycle");
            closedAttempts.push(cloneFreeze({ identity: event.identity, reason: event.reason, started: false }));
            return;
        }
        if (event.source === "reviewer-dispatch" && event.type === "accepted") {
            if (accepted !== undefined)
                throw new Error("Projection permits exactly one accepted dispatch");
            const axes = event.legs.map((leg) => leg.axis);
            if (axes[0] !== "standards" || (axes.length !== 1 && (axes.length !== 2 || axes[1] !== "spec")))
                throw new Error("Accepted dispatch sibling axes disagree");
            if (!isReviewerPromptText(event.input.task))
                throw new Error("Accepted task must be plain text");
            for (const leg of event.legs) {
                if (!isReviewerPromptText(leg.prompt))
                    throw new Error("Accepted compiled prompt must be plain text");
            }
            accepted = event;
            return;
        }
        if (event.source === "reviewer-runtime" && event.type === "fatal") {
            if (infrastructureFailure === undefined)
                infrastructureFailure = cloneFreeze({
                    diagnostics: event.diagnostics,
                    cause: event.cause,
                    ...(event.targetSnapshot === undefined ? {} : { targetSnapshot: event.targetSnapshot }),
                    ...(event.workspaceDisposition === undefined ? {} : { workspaceDisposition: event.workspaceDisposition }),
                });
            return;
        }
        if (event.type === "dispatch-started") {
            if (accepted === undefined || event.dispatchIdentity !== accepted.identity)
                throw new Error("Start requires its accepted dispatch");
            if (started !== undefined)
                throw new Error("Accepted dispatch can start exactly once");
            if (event.cardinality !== accepted.legs.length)
                throw new Error("Dispatch start cardinality disagrees with acceptance");
            started = cloneFreeze({ dispatchIdentity: event.dispatchIdentity, cardinality: event.cardinality });
            return;
        }
        if (accepted === undefined || started === undefined || event.dispatchIdentity !== accepted.identity)
            throw new Error("Runner result requires its irreversible accepted dispatch start");
        if (results[event.axis] !== undefined)
            throw new Error(`Reviewer ${event.axis} result can settle exactly once`);
        const compiled = accepted.legs.find((leg) => leg.axis === event.axis);
        if (compiled === undefined)
            throw new Error(`Reviewer ${event.axis} was not an accepted leg`);
        if (!sameReviewerPromptText(event.prompt, compiled.prompt) || !isReviewerPromptText(event.prompt))
            throw new Error("Actual runner prompt does not exactly match compiled prompt text");
        if (!sameReviewerPinnedTarget(event.target, accepted.target))
            throw new Error("Runner target does not match shared pinned target");
        if (event.status === "successful") {
            if (typeof event.report !== "string" || event.report.length === 0 || event.failure !== undefined)
                throw new Error("Successful settlement requires a report");
        }
        else if (event.failure === undefined || event.report !== undefined) {
            throw new Error("Failed settlement requires a bounded failure classification and no report");
        }
        results[event.axis] = event;
    }
    function recordInfrastructureFailure(error) {
        if (infrastructureFailure === undefined) {
            const evidence = fatal(error);
            append({ source: "reviewer-runtime", type: "fatal", ...evidence });
        }
        return error;
    }
    function recordForAudit(status) {
        if (infrastructureFailure !== undefined)
            throw Object.assign(new Error(`Reviewer infrastructure previously failed: ${infrastructureFailure.diagnostics}`), { fatalReviewerInfrastructure: true });
        if (status === "completed") {
            if (accepted === undefined || started === undefined)
                throw new Error("Reviewer completed requires exactly one accepted and started dispatch");
            const expected = accepted.legs.map((leg) => leg.axis);
            if (expected.some((axis) => results[axis]?.status !== "successful") || Object.keys(results).length !== expected.length)
                throw new Error(expected.length === 2 ? "Reviewer completed requires both axes settled successfully" : "Reviewer completed requires Standards settled successfully and no Spec evidence");
        }
        else if (accepted !== undefined) {
            const expected = accepted.legs.map((leg) => leg.axis);
            if (started === undefined || expected.some((axis) => results[axis] === undefined) || Object.keys(results).length !== expected.length)
                throw new Error("Reviewer refused after acceptance requires every expected leg terminal outcome");
        }
        return cloneFreeze({ transportRejections, rejections, closedAttempts, ...(accepted === undefined ? {} : { accepted }), ...(started === undefined ? {} : { started }), results });
    }
    return Object.freeze({ append, recordInfrastructureFailure, recordForAudit });
}
