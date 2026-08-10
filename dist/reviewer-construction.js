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
        "Before making any substantive claim, actually use the supplied task, canonical Skill, and fixed range facts; a citation without reading those facts is not evidence.",
        "You may use any supplied common fact, including facts relevant to the other axis; access and citation do not change the assigned question.",
        "The returned report is the complete output envelope and its UTF-8 bytes are preserved verbatim; no heading parser, sanitizer, section splitter, rewrite, aggregation, or replacement leg follows.",
    ].join("\n");
}
/** Deterministic compiler: admitted immutable policy plus frozen evidence in, dispatch text out. */
export function constructReviewerDispatch(input) {
    const common = [
        `Task:\n${input.taskText}`,
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
    const axes = [{ axis: "standards" }, { axis: "spec" }];
    const legs = axes.map((x) => Object.freeze({
        axis: x.axis,
        prompt: `${common}\n${reviewerAxisMethodAdapter(x.axis)}\n`,
    }));
    return Object.freeze({
        identity: input.identity,
        recipe: "reviewer-common-bundle-v1",
        input: Object.freeze({
            task: input.taskText,
            canonicalSkill: input.canonicalSkill,
            construction: REVIEWER_CONSTRUCTION_RECIPE,
        }),
        targetSnapshot: input.target,
        range: input.range,
        legs: Object.freeze(legs),
    });
}
