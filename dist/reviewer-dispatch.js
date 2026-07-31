import { exactUtf8 } from "./exact-utf8.js";
import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
export { createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
import { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
import { reviewerScopePrompt } from "./reviewer-scope-prompt.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
import { sha256Hex } from "./sha256.js";
import { bundlePromptReferences, compileMechanicalBundle, reviewerAxisMethodAdapter } from "./reviewer-construction.js";
export { sha256Hex } from "./sha256.js";
export { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
export const REVIEWER_CHILD_TOOLS = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    "edit",
];
export const REVIEWER_PREREQUISITES = [
    "preflight.git.pin-target",
    "preflight.git.resolve-base",
    "preflight.git.derive-range",
    "preflight.git.list-ordered-commits",
    "preflight.git.read-material",
    "runner.git.materialize-mirror",
    "runner.git.materialize-workspace",
    "runner.git.verify-snapshot",
];
const DISPATCH_PREREQUISITES = REVIEWER_PREREQUISITES.filter((operation) => operation.startsWith("preflight."));
export const REVIEWER_PREFLIGHT_VIOLATIONS = [
    "proposal-invalid", "base-invalid", "material-invalid", "spec-invalid",
    "capability-invalid", "prerequisite-missing", "range-invalid",
    "prompt-identity-invalid", "prompt-identity-mismatch", "target-drift",
];
export class ReviewerPreflightError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const violation = (code) => { throw new ReviewerPreflightError(code); };
const classifyReadFailure = (error) => {
    if (error instanceof ReviewerCorrectablePreflightError)
        violation(error.code);
    throw error;
};
function isExactObject(value, keys) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function hasUniqueValues(values) {
    return new Set(values).size === values.length;
}
function freezeStrings(values) {
    return Object.freeze([...values]);
}
function validateCapabilityRequestShape(value) {
    if (!isExactObject(value, ["tools", "bashCommands", "prerequisiteOperations"]))
        throw new ReviewerPreflightError("capability-invalid");
    const { tools, bashCommands, prerequisiteOperations } = value;
    if (!Array.isArray(tools) || !Array.isArray(bashCommands) || !Array.isArray(prerequisiteOperations) ||
        !tools.every((item) => typeof item === "string" && REVIEWER_CHILD_TOOLS.includes(item)) ||
        !bashCommands.every((item) => typeof item === "string") ||
        !prerequisiteOperations.every((item) => typeof item === "string" && REVIEWER_PREREQUISITES.includes(item)) ||
        !hasUniqueValues(tools) || !hasUniqueValues(bashCommands) || !hasUniqueValues(prerequisiteOperations))
        throw new ReviewerPreflightError("capability-invalid");
    if (bashCommands.length > 0 && !tools.includes("bash"))
        violation("capability-invalid");
    return { tools, bashCommands, prerequisiteOperations };
}
function immutableRequest(request) {
    return Object.freeze({
        tools: freezeStrings(request.tools),
        bashCommands: freezeStrings(request.bashCommands),
        prerequisiteOperations: freezeStrings(request.prerequisiteOperations),
    });
}
/** The sole dispatch-owned projection across the opaque runner boundary. */
export function toReviewerExecution(dispatch) {
    return Object.freeze({
        identity: dispatch.identity,
        recipe: dispatch.recipe,
        targetSnapshot: immutableReviewerPin(dispatch.targetSnapshot),
        bundle: dispatch.bundle,
        prerequisiteOperations: freezeStrings(dispatch.prerequisiteOperations),
        legs: Object.freeze(dispatch.legs.map((leg) => Object.freeze({
            axis: leg.axis,
            prompt: Object.freeze({ text: leg.prompt.text, utf8Length: leg.prompt.utf8Length, sha256: leg.prompt.sha256 }),
            grant: immutableRequest(leg.grant),
        }))),
    });
}
export function parseReviewerCapabilities(raw, task) {
    let value;
    let documentText;
    try {
        documentText = exactUtf8(raw, "Reviewer capabilities");
        value = JSON.parse(documentText);
    }
    catch {
        throw new Error("Invalid Reviewer capabilities UTF-8 JSON");
    }
    if (!isExactObject(value, [
        "version",
        "taskSha256",
        "tools",
        "bashCommands",
        "prerequisiteOperations",
    ])) {
        throw new Error("Invalid Reviewer capabilities keys");
    }
    const { version, taskSha256, tools, bashCommands, prerequisiteOperations } = value;
    if (version !== 1 ||
        typeof taskSha256 !== "string" ||
        !Array.isArray(tools) ||
        !Array.isArray(bashCommands) ||
        !Array.isArray(prerequisiteOperations)) {
        throw new Error("Invalid Reviewer capabilities schema");
    }
    if (!/^[0-9a-f]{64}$/.test(taskSha256) || taskSha256 !== sha256Hex(task)) {
        throw new Error("Reviewer capabilities task digest mismatch");
    }
    let request;
    try {
        request = validateCapabilityRequestShape({ tools, bashCommands, prerequisiteOperations });
    }
    catch {
        throw new Error("Reviewer capabilities contain unknown or duplicate values");
    }
    return Object.freeze({
        version: 1,
        taskSha256,
        document: reviewerPromptIdentity(documentText),
        ...immutableRequest(request),
    });
}
function validateRequest(value, ceiling, hostTools) {
    const { tools, bashCommands, prerequisiteOperations } = validateCapabilityRequestShape(value);
    if (tools.some((tool) => !ceiling.tools.includes(tool) || !hostTools.includes(tool)) ||
        prerequisiteOperations.some((operation) => !ceiling.prerequisiteOperations.includes(operation))) {
        violation("capability-invalid");
    }
    return immutableRequest({ tools, bashCommands, prerequisiteOperations });
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function validateMaterialSelection(value) {
    if (!isExactObject(value, ["id", "repositoryPath"]) ||
        typeof value.id !== "string" || !SAFE_ID.test(value.id)) {
        throw new ReviewerPreflightError("material-invalid");
    }
    if (typeof value.repositoryPath !== "string" || value.repositoryPath.length === 0 ||
        value.repositoryPath.startsWith("/") || value.repositoryPath.includes("\\") ||
        /[\u0000-\u001f\u007f]/u.test(value.repositoryPath) ||
        value.repositoryPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        violation("material-invalid");
    }
}
function skillSection(skill, heading, nextHeading) {
    const start = skill.indexOf(heading);
    if (start < 0)
        throw new Error("Canonical Skill section extraction failed");
    const end = skill.indexOf(nextHeading, start + heading.length);
    if (end < 0 || end <= start)
        throw new Error("Canonical Skill section extraction failed");
    return skill.slice(start, end).trim();
}
function proposalIdentity(proposal) {
    let encoded;
    try {
        encoded = JSON.stringify(proposal);
    }
    catch {
        encoded = "[unserializable proposal]";
    }
    return sha256Hex(encoded);
}
export function createReviewerDispatcher(dependencies) {
    const task = Uint8Array.from(dependencies.task);
    const canonicalSkill = dependencies.canonicalSkill;
    const capabilities = dependencies.capabilities;
    const hostTools = freezeStrings(dependencies.hostTools);
    const targetSnapshot = immutableReviewerPin(dependencies.reader.pin);
    let accepted;
    let fatalInfrastructure;
    let accepting = false;
    const rejections = [];
    const closedAttempts = [];
    function close(identity) {
        const evidence = Object.freeze({ identity, reason: "acceptance-closed", started: false });
        dependencies.decisionEvidence?.(Object.freeze({ disposition: "closed", ...evidence }));
        closedAttempts.push(evidence);
        return Object.freeze({ status: "closed", ...evidence });
    }
    function reject(identity, error) {
        const violations = Object.freeze([error.code]);
        const evidence = Object.freeze({ identity, violations, started: false });
        dependencies.decisionEvidence?.(Object.freeze({ disposition: "rejected", ...evidence }));
        rejections.push(evidence);
        return Object.freeze({ status: "rejected", identity, violations });
    }
    async function preflightAndCompileDispatch(proposal, identity) {
        const allowedKeys = proposal.relevanceHints === undefined
            ? ["version", "base", "materials", "spec", "required"]
            : ["version", "base", "materials", "relevanceHints", "spec", "required"];
        if (!isExactObject(proposal, allowedKeys) || proposal.version !== 1)
            violation("proposal-invalid");
        if (!isExactObject(proposal.base, ["revision"]) || typeof proposal.base.revision !== "string" || proposal.base.revision.length === 0)
            violation("base-invalid");
        if (!Array.isArray(proposal.materials))
            violation("material-invalid");
        proposal.materials.forEach(validateMaterialSelection);
        if (!hasUniqueValues(proposal.materials.map(x => x.id)) || !hasUniqueValues(proposal.materials.map(x => x.repositoryPath.normalize("NFC"))))
            violation("material-invalid");
        if (!isExactObject(proposal.spec, ["state"]) || (proposal.spec.state !== "established" && proposal.spec.state !== "not-established"))
            violation("spec-invalid");
        const requiredKeys = proposal.spec.state === "established" ? ["standards", "spec"] : ["standards"];
        if (!isExactObject(proposal.required, requiredKeys))
            violation("capability-invalid");
        if (proposal.relevanceHints !== undefined) {
            if (typeof proposal.relevanceHints !== "object" || proposal.relevanceHints === null || Array.isArray(proposal.relevanceHints) || Object.keys(proposal.relevanceHints).some(k => k !== "standards" && k !== "spec"))
                violation("material-invalid");
            const ids = new Set(proposal.materials.map(x => x.id));
            for (const hints of [proposal.relevanceHints.standards, proposal.relevanceHints.spec]) {
                if (hints !== undefined && (!Array.isArray(hints) || !hints.every(x => typeof x === "string" && ids.has(x)) || !hasUniqueValues(hints)))
                    violation("material-invalid");
            }
        }
        for (const operation of DISPATCH_PREREQUISITES)
            if (!capabilities.prerequisiteOperations.includes(operation))
                violation("prerequisite-missing");
        const standardsGrant = validateRequest(proposal.required.standards, capabilities, hostTools);
        const specGrant = proposal.spec.state === "established" ? validateRequest(proposal.required.spec, capabilities, hostTools) : undefined;
        const runnerOperations = REVIEWER_PREREQUISITES.filter(x => x.startsWith("runner."));
        for (const operation of runnerOperations)
            if (!capabilities.prerequisiteOperations.includes(operation))
                violation("prerequisite-missing");
        const acceptedPrerequisites = freezeStrings([...new Set([...standardsGrant.prerequisiteOperations, ...(specGrant?.prerequisiteOperations ?? []), ...runnerOperations])]);
        let base;
        let readRange;
        try {
            base = await dependencies.reader.resolve(proposal.base.revision);
            readRange = await dependencies.reader.range(base);
        }
        catch (error) {
            classifyReadFailure(error);
        }
        if (readRange.base !== base || readRange.target !== targetSnapshot.targetHead || readRange.diffCommand !== `git diff ${base}...${targetSnapshot.targetHead}` || !/^[0-9a-f]{64}$/.test(readRange.diffSha256) || readRange.diffSha256 === sha256Hex("") || !Array.isArray(readRange.commits) || !readRange.commits.every(x => typeof x === "string") || !hasUniqueValues(readRange.commits))
            violation("range-invalid");
        const range = Object.freeze({ ...readRange, commits: freezeStrings(readRange.commits) });
        if (!capabilities.tools.includes("bash") || !capabilities.bashCommands.includes(range.diffCommand))
            violation("capability-invalid");
        for (const grant of [standardsGrant, ...(specGrant ? [specGrant] : [])])
            if (!grant.tools.includes("bash") || !grant.bashCommands.includes(range.diffCommand) || grant.bashCommands.some(c => !capabilities.bashCommands.includes(c)))
                violation("capability-invalid");
        const materialEvidence = [];
        for (const item of proposal.materials) {
            let bytes;
            try {
                bytes = await dependencies.reader.material(item.repositoryPath, targetSnapshot.targetHead);
            }
            catch (error) {
                classifyReadFailure(error);
            }
            let text;
            try {
                text = exactUtf8(bytes, "Reviewer material");
            }
            catch {
                violation("material-invalid");
            }
            materialEvidence.push(Object.freeze({ ...item, text, utf8Length: bytes.byteLength, sha256: sha256Hex(bytes) }));
        }
        let taskText;
        try {
            taskText = exactUtf8(task, "Reviewer task");
        }
        catch {
            violation("prompt-identity-invalid");
        }
        const taskEvidence = reviewerPromptIdentity(taskText);
        const compiled = compileMechanicalBundle({ canonicalSkill, task: taskText, range, materials: materialEvidence });
        const common = [
            `Task-SHA256: ${taskEvidence.sha256}`, `Target: ${range.target}`, `Base: ${range.base}`, `Diff: ${range.diffCommand}`,
            reviewerScopePrompt(dependencies.reviewScopeKeys), `Recipe: ${compiled.construction.recipeId}@${compiled.construction.version}`,
            `Bundle-Manifest-SHA256: ${compiled.bundle.manifestSha256}`, bundlePromptReferences(compiled.bundle),
        ].join("\n");
        const axes = [{ axis: "standards", grant: standardsGrant }, ...(specGrant ? [{ axis: "spec", grant: specGrant }] : [])];
        const compilePrompt = dependencies.compilePrompt ?? ((prompt) => reviewerPromptIdentity(prompt));
        const build = (axis, grant, pass) => compilePrompt(`${common}\nGrant: ${JSON.stringify(grant)}\n${reviewerAxisMethodAdapter(axis)}\n`, axis, pass);
        const first = axes.map(x => build(x.axis, x.grant, 1));
        const second = axes.map(x => build(x.axis, x.grant, 2));
        for (let i = 0; i < first.length; i++)
            if (!isReviewerPromptIdentity(first[i]) || !isReviewerPromptIdentity(second[i]) || !sameReviewerPromptIdentity(first[i], second[i]))
                violation(!isReviewerPromptIdentity(first[i]) || !isReviewerPromptIdentity(second[i]) ? "prompt-identity-invalid" : "prompt-identity-mismatch");
        const legs = Object.freeze(axes.map((x, i) => Object.freeze({ axis: x.axis, prompt: first[i], grant: x.grant })));
        return Object.freeze({ identity, recipe: "reviewer-common-bundle-v1", input: Object.freeze({ task: taskEvidence, canonicalSkill: compiled.canonicalSkill, construction: compiled.construction, capabilityDocument: capabilities.document }), targetSnapshot, prerequisiteOperations: acceptedPrerequisites, range, materials: Object.freeze(materialEvidence), ...(proposal.relevanceHints === undefined ? {} : { relevanceHints: Object.freeze(proposal.relevanceHints) }), bundle: compiled.bundle, legs });
    }
    return Object.freeze({
        get rejections() {
            return Object.freeze([...rejections]);
        },
        get acceptance() {
            return accepted;
        },
        get closedAttempts() {
            return Object.freeze([...closedAttempts]);
        },
        async propose(proposal, invocation) {
            const identity = proposalIdentity(proposal);
            if (fatalInfrastructure !== undefined)
                throw fatalInfrastructure;
            if (accepted || accepting)
                return close(identity);
            let dispatch;
            try {
                dispatch = await preflightAndCompileDispatch(proposal, identity);
            }
            catch (error) {
                // Compilation awaits repository I/O; another proposal may accept meanwhile.
                if (accepted || accepting)
                    return close(identity);
                if (error instanceof ReviewerPreflightError)
                    return reject(identity, error);
                fatalInfrastructure = error;
                throw error;
            }
            // Another async proposal may have completed preflight while this one awaited pin reads.
            if (accepted || accepting)
                return close(identity);
            try {
                const live = await dependencies.reader.snapshot();
                if (!sameReviewerPinnedTarget(live, targetSnapshot)) {
                    violation("target-drift");
                }
            }
            catch (error) {
                if (accepted || accepting)
                    return close(identity);
                if (error instanceof ReviewerPreflightError)
                    return reject(identity, error);
                fatalInfrastructure = error;
                throw error;
            }
            if (accepted || accepting)
                return close(identity);
            dependencies.decisionEvidence?.(Object.freeze({ disposition: "accepted", identity, dispatch }));
            accepting = true;
            accepted = Object.freeze({
                identity,
                recipe: "reviewer-dispatch-v1",
                cardinality: dispatch.legs.length,
            });
            const results = await dependencies.run(toReviewerExecution(dispatch), invocation);
            return Object.freeze({ status: "accepted", dispatch, results });
        },
    });
}
