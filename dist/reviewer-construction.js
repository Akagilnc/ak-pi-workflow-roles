import { exactUtf8 } from "./exact-utf8.js";
import { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
import { sha256Hex } from "./sha256.js";
import { reviewerScopePrompt } from "./reviewer-scope-prompt.js";
export const REVIEWER_CONSTRUCTION_RECIPE = Object.freeze({
    recipeId: "reviewer-common-bundle",
    version: 1,
    runtimeVersion: "1",
    implementationSha256: sha256Hex("reviewer-common-bundle:v1:path-digest-prompts"),
});
export const REVIEWER_AXIS_OUTPUT_ADAPTER = Object.freeze({
    adapterId: "reviewer-axis-output",
    version: 1,
    implementationSha256: sha256Hex("reviewer-axis-output:v1:single-axis-verbatim-report+standards-three-priorities"),
});
/** Typed Standards conclusion keys owned by reviewer construction (presentation labels are not the contract). */
export const REVIEWER_STANDARDS_CONCLUSION_KEYS = Object.freeze([
    "constitutionality",
    "minimum-necessary-test-cost",
    "complexity",
]);
const REVIEWER_STANDARDS_CONCLUSION_LABELS = Object.freeze({
    constitutionality: "constitutionality",
    "minimum-necessary-test-cost": "minimum-necessary test cost",
    complexity: "complexity",
});
export function reviewerAxisOutputContract(axis) {
    const three = REVIEWER_STANDARDS_CONCLUSION_KEYS;
    return axis === "standards"
        ? Object.freeze({ axis, requiredConclusions: three, excludedConclusions: Object.freeze([]) })
        : Object.freeze({ axis, requiredConclusions: Object.freeze([]), excludedConclusions: three });
}
function renderConclusionList(keys, finalJoiner) {
    const labels = keys.map((key) => REVIEWER_STANDARDS_CONCLUSION_LABELS[key]);
    if (labels.length === 0)
        return "";
    if (labels.length === 1)
        return labels[0];
    if (labels.length === 2)
        return `${labels[0]} ${finalJoiner} ${labels[1]}`;
    return `${labels.slice(0, -1).join(", ")}, ${finalJoiner} ${labels[labels.length - 1]}`;
}
function renderAxisPriorityClause(contract) {
    if (contract.requiredConclusions.length > 0) {
        return `Inside that single Standards report, explicitly conclude on ${renderConclusionList(contract.requiredConclusions, "and")}; a finding or clear no-finding on each counts as a conclusion.`;
    }
    return `Do not discuss ${renderConclusionList(contract.excludedConclusions, "or")}; those are Standards judgements.`;
}
export function reviewerAxisMethodAdapter(axis, materialReferences = []) {
    const contract = reviewerAxisOutputContract(axis);
    const question = axis === "standards"
        ? "Answer only the canonical Standards question, including its complete smell baseline and burden."
        : "Answer only the canonical Spec question.";
    const other = axis === "standards" ? "Spec" : "Standards";
    return [
        `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}:${axis}`,
        "The complete canonical Skill snapshot in the common bundle remains authoritative semantic input.",
        "For this already-isolated leg, this package adapter supersedes that Skill's dual-agent orchestration, dual-axis aggregation, and dual-section presentation mechanics.",
        question,
        `Emit exactly one substantive ${axis === "standards" ? "Standards" : "Spec"} report. Do not emit a ${other} assessment, ${other} finding count, ${other} conclusion, or second-axis section.`,
        renderAxisPriorityClause(contract),
        "Before making any substantive claim, actually read the assigned bundle materials at their typed paths and verify their supplied byte lengths and SHA-256 digests; a path or digest citation without a successful read is not evidence.",
        "You may read and cite any supplied common material, including material relevant to the other axis; material access and citation do not change the assigned question.",
        "The returned report is the complete output envelope and its UTF-8 bytes are preserved verbatim; no heading parser, sanitizer, section splitter, rewrite, aggregation, or replacement leg follows.",
        ...(materialReferences.length === 0 ? [] : ["Typed material reads required for this leg:", ...materialReferences.map((reference) => `Read-and-verify: ${JSON.stringify(reference)}`)]),
    ].join("\n");
}
function entry(id, path, origin, sourceIdentity, bytes) {
    return Object.freeze({ id, relativeClonePath: path, origin, sourceIdentity, bytes, utf8Length: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) });
}
function manifestBytes(entries) {
    return JSON.stringify({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, entries: entries.map((entry) => {
            const { bytes: _bytes, ...identity } = entry;
            return identity;
        }) });
}
export function compileMechanicalBundle(input) {
    const skillIdentity = reviewerPromptIdentity(input.canonicalSkill);
    const canonicalSkill = Object.freeze({ sha256: skillIdentity.sha256, utf8Length: skillIdentity.utf8Length, snapshotIdentity: skillIdentity });
    const entries = Object.freeze([
        entry("canonical-skill", ".ak-reviewer/materials/canonical-skill.md", "canonical-skill", skillIdentity.sha256, input.canonicalSkill),
        entry("opaque-task", ".ak-reviewer/materials/task.md", "runtime-recipe", sha256Hex(input.task), input.task),
        entry("review-range", ".ak-reviewer/materials/range.json", "derived-range", input.range.diffSha256, JSON.stringify(input.range, null, 2) + "\n"),
        ...input.materials.map((item) => entry(`material-${item.id}`, `.ak-reviewer/materials/selected/${item.id}.md`, item.source === "host-input" ? "host-input" : "pinned-target", `${item.source === "host-input" ? `host-input:${item.sourcePath}` : `pinned-git:${item.repositoryPath}@${input.range.target}`}@${item.sha256}`, item.text)),
    ]);
    const paths = entries.map((item) => item.relativeClonePath.normalize("NFC"));
    if (new Set(paths).size !== paths.length)
        throw new Error("Mechanical bundle path collision");
    const bundle = Object.freeze({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, manifestSha256: sha256Hex(manifestBytes(entries)), entries });
    return { canonicalSkill, construction: REVIEWER_CONSTRUCTION_RECIPE, bundle };
}
/** Deterministic compiler: admitted immutable policy plus frozen evidence in, dispatch bytes out. */
export function constructReviewerDispatch(input) {
    const task = reviewerPromptIdentity(input.taskText);
    const compiled = compileMechanicalBundle({ canonicalSkill: input.canonicalSkill, task: input.taskText, range: input.evidence.range, materials: input.evidence.materials });
    const common = [`Task-SHA256: ${task.sha256}`, `Target: ${input.evidence.range.target}`, `Base: ${input.evidence.range.base}`, `Diff: ${input.evidence.range.diffCommand}`, reviewerScopePrompt(input.reviewScopeKeys), `Recipe: ${compiled.construction.recipeId}@${compiled.construction.version}`, `Bundle-Manifest-SHA256: ${compiled.bundle.manifestSha256}`, bundlePromptReferences(compiled.bundle)].join("\n");
    const finalize = (grant) => Object.freeze({ prerequisiteOperations: Object.freeze([...grant.prerequisiteOperations]) });
    const axes = [{ axis: "standards", grant: finalize(input.admitted.standardsGrant) }, ...(input.admitted.specGrant ? [{ axis: "spec", grant: finalize(input.admitted.specGrant) }] : [])];
    const compile = input.compilePrompt ?? ((text) => reviewerPromptIdentity(text));
    const materialReferences = compiled.bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => ({ id, relativeClonePath, utf8Length, sha256 }));
    const build = (x, pass) => compile(`${common}\nGrant: ${JSON.stringify(x.grant)}\n${reviewerAxisMethodAdapter(x.axis, materialReferences)}\n`, x.axis, pass);
    const first = axes.map(x => build(x, 1)), second = axes.map(x => build(x, 2));
    for (let i = 0; i < first.length; i++) {
        if (!isReviewerPromptIdentity(first[i]) || !isReviewerPromptIdentity(second[i]))
            throw new ReviewerConstructionError("prompt-identity-invalid");
        if (!sameReviewerPromptIdentity(first[i], second[i]))
            throw new ReviewerConstructionError("prompt-identity-mismatch");
    }
    return Object.freeze({ identity: input.identity, recipe: "reviewer-common-bundle-v1", input: Object.freeze({ task, canonicalSkill: compiled.canonicalSkill, construction: compiled.construction, capabilityDocument: input.capabilityDocument }), targetSnapshot: input.target, prerequisiteOperations: input.admitted.prerequisiteOperations, range: input.evidence.range, materials: input.evidence.materials, ...(input.admitted.relevanceHints === undefined ? {} : { relevanceHints: input.admitted.relevanceHints }), bundle: compiled.bundle, legs: Object.freeze(axes.map((x, i) => Object.freeze({ ...x, prompt: first[i] }))) });
}
export class ReviewerConstructionError extends Error {
    code;
    diagnostic;
    constructor(code, diagnostic = code === "prompt-identity-invalid"
        ? "compiled prompt identity must contain canonical text, UTF-8 length, and SHA-256"
        : "repeated prompt compilation must produce the same prompt identity") {
        super(`${code}: ${diagnostic}`);
        this.code = code;
        this.diagnostic = diagnostic;
    }
}
export function bundlePromptReferences(bundle) {
    return bundle.entries.map(({ id, relativeClonePath, origin, sourceIdentity, sha256 }) => `Bundle-Material: ${JSON.stringify({ id, relativeClonePath, origin, sourceIdentity, sha256 })}`).join("\n");
}
export function projectMechanicalBundleIdentity(bundle) {
    return Object.freeze({
        recipeIdentity: bundle.recipeIdentity,
        manifestSha256: bundle.manifestSha256,
        entries: Object.freeze(bundle.entries.map(({ bytes: _bytes, ...identity }) => Object.freeze(identity))),
    });
}
export function verifyBundleIdentity(bundle) {
    return bundle.entries.every((item) => {
        if ("bytes" in item) {
            const bytes = item.bytes;
            return exactUtf8(Buffer.from(bytes), item.id) === bytes && Buffer.byteLength(bytes) === item.utf8Length && sha256Hex(bytes) === item.sha256;
        }
        return typeof item.id === "string" && typeof item.relativeClonePath === "string" && typeof item.origin === "string" && typeof item.sourceIdentity === "string" && Number.isInteger(item.utf8Length) && item.utf8Length >= 0 && /^[0-9a-f]{64}$/.test(item.sha256);
    }) && sha256Hex(manifestBytes(bundle.entries)) === bundle.manifestSha256;
}
