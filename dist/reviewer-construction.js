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
/** Package-owned axis identity + neutral report-byte fact (ADR 0073: no instruction copy of soul). */
export function reviewerAxisMethodAdapter(axis) {
    return [
        `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}:${axis}`,
        "报告字节原样保留，其后无解析器/清洗器/重写/聚合腿",
    ].join("\n");
}
/**
 * Spec-only evidence-child material carrier for durable authority references.
 * Exact values preserved; no prose extraction and no Standards/parent injection.
 */
export function reviewerAuthorityRefsMaterial(authorityRefs) {
    return [
        "权威引用：",
        JSON.stringify(Object.freeze([...authorityRefs])),
    ].join("\n");
}
/**
 * Spec-only material carrier for self-fetched issue bytes + source annotation (#343).
 * Actual issue body and referenced ADR bytes are embedded for audit (fetch-then-store).
 * Single JSON payload keeps external issue/ADR bytes inside structured field values so they
 * cannot forge package framing markers on the same text layer (no plain-text section protocol).
 */
export function reviewerFetchedSpecMaterial(fetched) {
    return [
        "权威取回-Spec：",
        JSON.stringify(Object.freeze({
            source: fetched.adopted.source,
            ticketNumber: fetched.ticketNumber,
            issueRef: fetched.issueRef,
            abandoned: Object.freeze([...fetched.abandoned]),
            issueBody: fetched.issueBody,
            adrs: Object.freeze(fetched.adrs.map((adr) => adr.status === "present"
                ? Object.freeze({ path: adr.path, status: adr.status, body: adr.body })
                : Object.freeze({ path: adr.path, status: adr.status }))),
        })),
    ].join("\n");
}
/** Deterministic compiler: fixed target/range plus discovery product in, dispatch text out. */
export function constructReviewerDispatch(input) {
    const launchSpec = input.specAuthority.status === "available";
    const authorityRefs = Object.freeze(input.specAuthority.status === "available" ? [...input.specAuthority.refs] : []);
    const specFetchedMaterial = input.specAuthority.status === "available" && input.specAuthority.fetched !== undefined
        ? input.specAuthority.fetched
        : undefined;
    const specDisposition = launchSpec ? "launched" : "skipped-missing";
    const common = [
        `目标：${input.range.target}`,
        `基点：${input.range.base}`,
        `差异命令：${input.range.diffCommand}`,
        reviewerScopePrompt(input.reviewScopeKeys),
        `配方：${REVIEWER_CONSTRUCTION_RECIPE.recipeId}@${REVIEWER_CONSTRUCTION_RECIPE.version}`,
        "Canonical-Skill:",
        input.canonicalSkill,
        "固定范围：",
        JSON.stringify(input.range, null, 2),
    ].join("\n");
    const axes = launchSpec
        ? [{ axis: "standards" }, { axis: "spec" }]
        : [{ axis: "standards" }];
    const legs = axes.map((x) => {
        const parts = [common, reviewerAxisMethodAdapter(x.axis)];
        // Spec evidence-child only — never Standards or a parent replacement Spec leg.
        if (x.axis === "spec") {
            if (specFetchedMaterial !== undefined) {
                parts.push(reviewerFetchedSpecMaterial(specFetchedMaterial));
            }
            if (authorityRefs.length > 0) {
                parts.push(reviewerAuthorityRefsMaterial(authorityRefs));
            }
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
        ...(specFetchedMaterial === undefined ? {} : { specFetchedMaterial }),
        legs: Object.freeze(legs),
    });
}
