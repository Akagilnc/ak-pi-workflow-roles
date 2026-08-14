import { sha256Hex } from "./sha256.js";
import { reviewerScopePrompt } from "./reviewer-scope-prompt.js";
export const REVIEWER_CONSTRUCTION_RECIPE = Object.freeze({
    recipeId: "reviewer-common-bundle",
    version: 1,
    runtimeVersion: "1",
    implementationSha256: sha256Hex("reviewer-common-bundle:v1:direct-text-prompts"),
});
export const REVIEWER_AXIS_OUTPUT_ADAPTER = Object.freeze({
    adapterId: "reviewer-axis-output",
    version: 1,
    implementationSha256: sha256Hex("reviewer-axis-output:v1:single-axis-verbatim-report+standards-three-priorities"),
});
/**
 * Package-owned #1185 review verification cadence.
 * Single true source consumed by two real actor carriers: parent Reviewer system-prompt injection
 * and evidence-child system prompt. Not part of axis-adapter identity or axis leg prompts.
 * Graded guidance only: focused tests allowed; full suite not forbidden but avoid frequent every-round reruns.
 * Does not narrow ADR 0064 tools and adds no command ban, allowlist, or runtime block.
 */
export const REVIEWER_VERIFICATION_BOUNDARY = [
    "Verification-Boundary: you may run focused product tests during this review turn when independent verification needs them.",
    "A full repository test suite is not forbidden, but do not re-run it every review round;",
    "prefer once at family wrap-up unless this review specifically requires a broader run.",
    "Slice and review work should not trigger frequent full-suite reruns.",
    "Independently discover test facts (including existing coder/fixer receipts and any tests you run);",
    "do not treat caller prose as the source of those facts.",
].join(" ");
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
/** Package-owned mechanics layered over the unchanged canonical Skill semantics. */
export function reviewerAxisMethodAdapter(axis) {
    const contract = reviewerAxisOutputContract(axis);
    const question = axis === "standards"
        ? "Answer only the canonical Standards question, including its complete smell baseline and burden."
        : "Answer only the canonical Spec question.";
    return [
        `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}:${axis}`,
        "The complete canonical Skill text below remains authoritative semantic input.",
        "For this already-isolated leg, this package adapter supersedes that Skill's dual-agent orchestration, dual-axis aggregation, and dual-section presentation mechanics.",
        question,
        `Emit one substantive ${axis === "standards" ? "Standards" : "Spec"} report. Incidental cross-axis content, headings, and finding-count annotations are presentation matters, not defects.`,
        renderAxisPriorityClause(contract),
        "Before making any substantive claim, actually use the canonical Skill and fixed range facts; a citation without reading those facts is not evidence.",
        "Independently acquire issue, authority, and context; do not treat caller prose as controlling authority or as the Spec source.",
        "You may use any supplied common fact, including facts relevant to the other axis; access and citation do not change the assigned question.",
        "The returned report is the complete output envelope and its UTF-8 bytes are preserved verbatim; no heading parser, sanitizer, section splitter, rewrite, aggregation, or replacement leg follows.",
    ].join("\n");
}
/**
 * Spec-only evidence-child material carrier for durable authority references.
 * Exact values preserved; no prose extraction and no Standards/parent injection.
 */
export function reviewerAuthorityRefsMaterial(authorityRefs) {
    return [
        "Authority-Refs:",
        JSON.stringify(Object.freeze([...authorityRefs])),
        "These are durable authority references only. Read them as Spec grounding materials; do not invent Spec prose from caller instruction.",
    ].join("\n");
}
/** Deterministic compiler: fixed target/range plus discovery product in, dispatch text out. */
export function constructReviewerDispatch(input) {
    const launchSpec = input.specAuthority.status === "available";
    const authorityRefs = Object.freeze(input.specAuthority.status === "available" ? [...input.specAuthority.refs] : []);
    const specDisposition = launchSpec ? "launched" : "skipped-missing";
    const common = [
        `Target: ${input.range.target}`,
        `Base: ${input.range.base}`,
        `Diff: ${input.range.diffCommand}`,
        reviewerScopePrompt(input.reviewScopeKeys),
        `Recipe: ${REVIEWER_CONSTRUCTION_RECIPE.recipeId}@${REVIEWER_CONSTRUCTION_RECIPE.version}`,
        "Canonical-Skill:",
        input.canonicalSkill,
        "Fixed-Range:",
        JSON.stringify(input.range, null, 2),
    ].join("\n");
    const axes = launchSpec
        ? [{ axis: "standards" }, { axis: "spec" }]
        : [{ axis: "standards" }];
    const legs = axes.map((x) => {
        const parts = [common, reviewerAxisMethodAdapter(x.axis)];
        // Spec evidence-child only — never Standards or a parent replacement Spec leg.
        if (x.axis === "spec" && authorityRefs.length > 0) {
            parts.push(reviewerAuthorityRefsMaterial(authorityRefs));
        }
        return Object.freeze({
            axis: x.axis,
            prompt: `${parts.join("\n")}\n`,
        });
    });
    return Object.freeze({
        identity: input.identity,
        recipe: "reviewer-common-bundle-v1",
        input: Object.freeze({
            canonicalSkill: input.canonicalSkill,
            construction: REVIEWER_CONSTRUCTION_RECIPE,
        }),
        targetSnapshot: input.target,
        range: input.range,
        authorityRefs,
        specDisposition,
        legs: Object.freeze(legs),
    });
}
