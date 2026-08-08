export const REVIEWER_CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit"];
export const REVIEWER_PREREQUISITES = [
    "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
    "preflight.git.list-ordered-commits", "preflight.git.read-material",
    "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot",
];
export class ReviewerAdmissionError extends Error {
    code;
    diagnostic;
    constructor(code, diagnostic) {
        super(`${code}: ${diagnostic}`);
        this.code = code;
        this.diagnostic = diagnostic;
    }
}
const fail = (code, diagnostic) => { throw new ReviewerAdmissionError(code, diagnostic); };
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const unique = (xs) => new Set(xs).size === xs.length;
const frozen = (xs) => Object.freeze([...xs]);
const immutableRequest = (r) => Object.freeze({ tools: frozen(r.tools), prerequisiteOperations: frozen(r.prerequisiteOperations) });
function request(value, ceiling, hostTools) {
    if (!record(value))
        fail("capability-invalid", "required capability request must be an object");
    const { tools, prerequisiteOperations } = value;
    if (!Array.isArray(tools) || !Array.isArray(prerequisiteOperations) || !tools.every(x => typeof x === "string" && REVIEWER_CHILD_TOOLS.includes(x)) || !prerequisiteOperations.every(x => typeof x === "string" && REVIEWER_PREREQUISITES.includes(x)) || !unique(tools) || !unique(prerequisiteOperations) || tools.some(x => !ceiling.tools.includes(x) || !hostTools.includes(x)) || prerequisiteOperations.some(x => !ceiling.prerequisiteOperations.includes(x)))
        fail("capability-invalid", "required.tools/prerequisiteOperations must be unique, known, and within the capability and host ceilings");
    return immutableRequest({ tools: tools, prerequisiteOperations: prerequisiteOperations });
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function admitReviewerProposal(proposal, ceiling, hostTools) {
    if (!record(proposal) || proposal.version !== 1)
        fail("proposal-invalid", "proposal.version must equal 1");
    const p = proposal;
    if (!record(p.base) || typeof p.base.revision !== "string" || !p.base.revision)
        fail("base-invalid", "base.revision must be a nonempty string");
    const base = p.base;
    if (!Array.isArray(p.materials))
        fail("material-invalid", "materials must be an array");
    const materialValues = p.materials;
    const materials = [];
    for (const value of materialValues) {
        if (!record(value) || typeof value.id !== "string" || !SAFE_ID.test(value.id) || typeof value.repositoryPath !== "string" || !value.repositoryPath)
            fail("material-invalid", "each materials entry requires a safe id and nonempty repositoryPath");
        const material = value;
        const sourceValue = material.source === undefined ? "pinned-git" : material.source;
        if (sourceValue !== "pinned-git" && sourceValue !== "host-input")
            fail("material-invalid", "material source must be pinned-git or host-input");
        const source = sourceValue;
        if (source === "host-input" && (typeof material.sourcePath !== "string" || !material.sourcePath.trim()))
            fail("material-invalid", "host-input material requires an explicit sourcePath");
        if (source === "pinned-git" && material.sourcePath !== undefined)
            fail("material-invalid", "pinned-git material cannot carry a host sourcePath");
        materials.push(Object.freeze({ id: material.id, repositoryPath: material.repositoryPath, source, ...(source === "host-input" ? { sourcePath: material.sourcePath } : {}) }));
    }
    if (!unique(materials.map(x => x.id)) || !unique(materials.map(x => x.repositoryPath.normalize("NFC"))))
        fail("material-invalid", "materials ids and normalized repositoryPath values must be unique");
    if (!record(p.spec) || (p.spec.state !== "established" && p.spec.state !== "not-established"))
        fail("spec-invalid", "spec.state must be established or not-established");
    const spec = p.spec;
    if (!record(p.required) || p.required.standards === undefined || (spec.state === "established" && p.required.spec === undefined))
        fail("capability-invalid", "required.standards is mandatory and required.spec is mandatory when spec.state is established");
    const required = p.required;
    let relevanceHints;
    if (p.relevanceHints !== undefined) {
        if (!record(p.relevanceHints))
            fail("material-invalid", "relevanceHints must be an object");
        const hints = p.relevanceHints;
        for (const hs of [hints.standards, hints.spec])
            if (hs !== undefined && (!Array.isArray(hs) || !hs.every(x => typeof x === "string") || !unique(hs)))
                fail("material-invalid", "relevanceHints axes must contain unique strings");
        relevanceHints = Object.freeze({ ...(hints.standards === undefined ? {} : { standards: frozen(hints.standards) }), ...(hints.spec === undefined ? {} : { spec: frozen(hints.spec) }) });
    }
    for (const op of REVIEWER_PREREQUISITES.filter(x => x.startsWith("preflight.")))
        if (!ceiling.prerequisiteOperations.includes(op))
            fail("prerequisite-missing", `capability prerequisiteOperations is missing ${op}`);
    const standardsGrant = request(required.standards, ceiling, hostTools);
    const specGrant = spec.state === "established" ? request(required.spec, ceiling, hostTools) : undefined;
    const runner = REVIEWER_PREREQUISITES.filter(x => x.startsWith("runner."));
    for (const op of runner)
        if (!ceiling.prerequisiteOperations.includes(op))
            fail("prerequisite-missing", `capability prerequisiteOperations is missing ${op}`);
    return Object.freeze({ baseRevision: base.revision, materials: Object.freeze(materials), ...(relevanceHints === undefined ? {} : { relevanceHints }), standardsGrant, ...(specGrant ? { specGrant } : {}), prerequisiteOperations: frozen([...new Set([...standardsGrant.prerequisiteOperations, ...(specGrant?.prerequisiteOperations ?? []), ...runner])]) });
}
