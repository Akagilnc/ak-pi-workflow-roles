export const REVIEWER_CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit"];
export const REVIEWER_PREREQUISITES = [
    "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
    "preflight.git.list-ordered-commits", "preflight.git.read-material",
    "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot",
];
export class ReviewerAdmissionError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const fail = (code) => { throw new ReviewerAdmissionError(code); };
const exact = (value, keys) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const unique = (xs) => new Set(xs).size === xs.length;
const frozen = (xs) => Object.freeze([...xs]);
const immutableRequest = (r) => Object.freeze({ tools: frozen(r.tools), bashCommands: frozen(r.bashCommands), prerequisiteOperations: frozen(r.prerequisiteOperations) });
function request(value, ceiling, hostTools) {
    if (!exact(value, ["tools", "bashCommands", "prerequisiteOperations"]))
        fail("capability-invalid");
    const { tools, bashCommands, prerequisiteOperations } = value;
    if (!Array.isArray(tools) || !Array.isArray(bashCommands) || !Array.isArray(prerequisiteOperations) || !tools.every(x => typeof x === "string" && REVIEWER_CHILD_TOOLS.includes(x)) || !bashCommands.every(x => typeof x === "string") || !prerequisiteOperations.every(x => typeof x === "string" && REVIEWER_PREREQUISITES.includes(x)) || !unique(tools) || !unique(bashCommands) || !unique(prerequisiteOperations) || (bashCommands.length > 0 && !tools.includes("bash")) || tools.some(x => !ceiling.tools.includes(x) || !hostTools.includes(x)) || prerequisiteOperations.some(x => !ceiling.prerequisiteOperations.includes(x)))
        fail("capability-invalid");
    return immutableRequest({ tools: tools, bashCommands: bashCommands, prerequisiteOperations: prerequisiteOperations });
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function admitReviewerProposal(proposal, ceiling, hostTools) {
    const p = proposal;
    const keys = p?.relevanceHints === undefined ? ["version", "base", "materials", "spec", "required"] : ["version", "base", "materials", "relevanceHints", "spec", "required"];
    if (!exact(p, keys) || p.version !== 1)
        fail("proposal-invalid");
    if (!exact(p.base, ["revision"]) || typeof p.base.revision !== "string" || !p.base.revision)
        fail("base-invalid");
    if (!Array.isArray(p.materials))
        fail("material-invalid");
    for (const m of p.materials) {
        if (!exact(m, ["id", "repositoryPath"]) || typeof m.id !== "string" || !SAFE_ID.test(m.id) || typeof m.repositoryPath !== "string" || !m.repositoryPath || m.repositoryPath.startsWith("/") || m.repositoryPath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(m.repositoryPath) || m.repositoryPath.split("/").some(s => !s || s === "." || s === ".."))
            fail("material-invalid");
    }
    if (!unique(p.materials.map(x => x.id)) || !unique(p.materials.map(x => x.repositoryPath.normalize("NFC"))))
        fail("material-invalid");
    if (!exact(p.spec, ["state"]) || (p.spec.state !== "established" && p.spec.state !== "not-established"))
        fail("spec-invalid");
    const requiredKeys = p.spec.state === "established" ? ["standards", "spec"] : ["standards"];
    if (!exact(p.required, requiredKeys))
        fail("capability-invalid");
    if (p.relevanceHints !== undefined) {
        if (!exact(p.relevanceHints, Object.keys(p.relevanceHints)) || Object.keys(p.relevanceHints).some(k => k !== "standards" && k !== "spec"))
            fail("material-invalid");
        const ids = new Set(p.materials.map(x => x.id));
        for (const hs of [p.relevanceHints.standards, p.relevanceHints.spec])
            if (hs !== undefined && (!Array.isArray(hs) || !hs.every(x => typeof x === "string" && ids.has(x)) || !unique(hs)))
                fail("material-invalid");
    }
    for (const op of REVIEWER_PREREQUISITES.filter(x => x.startsWith("preflight.")))
        if (!ceiling.prerequisiteOperations.includes(op))
            fail("prerequisite-missing");
    const standardsGrant = request(p.required.standards, ceiling, hostTools);
    const specGrant = p.spec.state === "established" ? request(p.required.spec, ceiling, hostTools) : undefined;
    const runner = REVIEWER_PREREQUISITES.filter(x => x.startsWith("runner."));
    for (const op of runner)
        if (!ceiling.prerequisiteOperations.includes(op))
            fail("prerequisite-missing");
    return Object.freeze({ baseRevision: p.base.revision, materials: Object.freeze(p.materials.map(m => Object.freeze({ ...m }))), ...(p.relevanceHints === undefined ? {} : { relevanceHints: Object.freeze({ ...p.relevanceHints }) }), standardsGrant, ...(specGrant ? { specGrant } : {}), prerequisiteOperations: frozen([...new Set([...standardsGrant.prerequisiteOperations, ...(specGrant?.prerequisiteOperations ?? []), ...runner])]) });
}
