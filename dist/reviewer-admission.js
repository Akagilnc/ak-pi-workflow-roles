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
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const unique = (xs) => new Set(xs).size === xs.length;
const frozen = (xs) => Object.freeze([...xs]);
const immutableRequest = (r) => Object.freeze({ tools: frozen(r.tools), prerequisiteOperations: frozen(r.prerequisiteOperations) });
function request(value, ceiling, hostTools) {
    if (!record(value))
        fail("capability-invalid");
    const { tools, prerequisiteOperations } = value;
    if (!Array.isArray(tools) || !Array.isArray(prerequisiteOperations) || !tools.every(x => typeof x === "string" && REVIEWER_CHILD_TOOLS.includes(x)) || !prerequisiteOperations.every(x => typeof x === "string" && REVIEWER_PREREQUISITES.includes(x)) || !unique(tools) || !unique(prerequisiteOperations) || tools.some(x => !ceiling.tools.includes(x) || !hostTools.includes(x)) || prerequisiteOperations.some(x => !ceiling.prerequisiteOperations.includes(x)))
        fail("capability-invalid");
    return immutableRequest({ tools: tools, prerequisiteOperations: prerequisiteOperations });
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function admitReviewerProposal(proposal, ceiling, hostTools) {
    if (!record(proposal) || proposal.version !== 1)
        fail("proposal-invalid");
    const p = proposal;
    if (!record(p.base) || typeof p.base.revision !== "string" || !p.base.revision)
        fail("base-invalid");
    const base = p.base;
    if (!Array.isArray(p.materials))
        fail("material-invalid");
    const materialValues = p.materials;
    const materials = [];
    for (const value of materialValues) {
        if (!record(value) || typeof value.id !== "string" || !SAFE_ID.test(value.id) || typeof value.repositoryPath !== "string" || !value.repositoryPath)
            fail("material-invalid");
        const material = value;
        materials.push(Object.freeze({ id: material.id, repositoryPath: material.repositoryPath }));
    }
    if (!unique(materials.map(x => x.id)) || !unique(materials.map(x => x.repositoryPath.normalize("NFC"))))
        fail("material-invalid");
    if (!record(p.spec) || (p.spec.state !== "established" && p.spec.state !== "not-established"))
        fail("spec-invalid");
    const spec = p.spec;
    if (!record(p.required) || p.required.standards === undefined || (spec.state === "established" && p.required.spec === undefined))
        fail("capability-invalid");
    const required = p.required;
    let relevanceHints;
    if (p.relevanceHints !== undefined) {
        if (!record(p.relevanceHints))
            fail("material-invalid");
        const hints = p.relevanceHints;
        for (const hs of [hints.standards, hints.spec])
            if (hs !== undefined && (!Array.isArray(hs) || !hs.every(x => typeof x === "string") || !unique(hs)))
                fail("material-invalid");
        relevanceHints = Object.freeze({ ...(hints.standards === undefined ? {} : { standards: frozen(hints.standards) }), ...(hints.spec === undefined ? {} : { spec: frozen(hints.spec) }) });
    }
    for (const op of REVIEWER_PREREQUISITES.filter(x => x.startsWith("preflight.")))
        if (!ceiling.prerequisiteOperations.includes(op))
            fail("prerequisite-missing");
    const standardsGrant = request(required.standards, ceiling, hostTools);
    const specGrant = spec.state === "established" ? request(required.spec, ceiling, hostTools) : undefined;
    const runner = REVIEWER_PREREQUISITES.filter(x => x.startsWith("runner."));
    for (const op of runner)
        if (!ceiling.prerequisiteOperations.includes(op))
            fail("prerequisite-missing");
    return Object.freeze({ baseRevision: base.revision, materials: Object.freeze(materials), ...(relevanceHints === undefined ? {} : { relevanceHints }), standardsGrant, ...(specGrant ? { specGrant } : {}), prerequisiteOperations: frozen([...new Set([...standardsGrant.prerequisiteOperations, ...(specGrant?.prerequisiteOperations ?? []), ...runner])]) });
}
