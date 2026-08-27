import { sha256Hex } from "./sha256.ts";
import { reviewerScopePrompt } from "./reviewer-scope-prompt.ts";
import type { ReviewerPinnedTarget, ReviewerRange } from "./reviewer-pinned-git.ts";
import type { ReviewerPromptText } from "./reviewer-prompt-identity.ts";

export const REVIEWER_CONSTRUCTION_RECIPE = Object.freeze({
  recipeId: "reviewer-common-bundle",
  version: 1,
  runtimeVersion: "1",
  implementationSha256: sha256Hex("reviewer-common-bundle:v1:direct-text-prompts"),
});
export type ReviewerConstructionIdentity = typeof REVIEWER_CONSTRUCTION_RECIPE;
export type ReviewerAxis = "standards" | "spec";

export const REVIEWER_AXIS_OUTPUT_ADAPTER = Object.freeze({
  adapterId: "reviewer-axis-output",
  version: 1,
});

/** Package-owned axis identity + neutral report-byte fact (ADR 0073: no instruction copy of soul). */
export function reviewerAxisMethodAdapter(axis: ReviewerAxis): string {
  return [
    `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}:${axis}`,
    "报告字节原样保留，其后无解析器/清洗器/重写/聚合腿",
  ].join("\n");
}

export type ConstructedReviewerLeg = Readonly<{ axis: "standards" | "spec"; prompt: ReviewerPromptText }>;

/** Ticket-number provenance for Spec self-fetch (#343). High-priority source wins. */
export type ReviewerTicketNumberSource =
  | "typed-ticket-number"
  | "branch-token"
  | "commit-message";

export type ReviewerTicketNumberCandidate = Readonly<{
  source: ReviewerTicketNumberSource;
  ticketNumber: number;
}>;

/** One docs/adr path referenced by the fetched issue body. */
export type ReviewerFetchedAdr =
  | Readonly<{ path: string; status: "present"; body: string }>
  | Readonly<{ path: string; status: "missing" }>;

/**
 * Actual Spec bytes pulled on the self-fetch primary path (fetch-then-store).
 * Carried into Spec-child material and retained on the accepted dispatch for audit.
 */
export type ReviewerSpecFetchedMaterial = Readonly<{
  issueRef: string;
  owner: string;
  repo: string;
  ticketNumber: number;
  adopted: ReviewerTicketNumberCandidate;
  abandoned: readonly ReviewerTicketNumberCandidate[];
  issueBody: string;
  adrs: readonly ReviewerFetchedAdr[];
}>;

/**
 * Unique discovery product for Skill step 2: durable refs Spec child can read, or confirmed missing.
 * Optional `fetched` is present only when the self-fetch primary path produced issue bytes.
 * Construction builds Standards/Spec solely from this product — no secondary launch decision.
 */
export type ReviewerSpecAuthorityDiscovery =
  | Readonly<{
      status: "available";
      refs: readonly string[];
      fetched?: ReviewerSpecFetchedMaterial;
    }>
  | Readonly<{ status: "missing" }>;
/** Spec-child cardinality decision recorded on the accepted dispatch. */
export type ReviewerSpecDisposition = "launched" | "skipped-missing";
export type ConstructedReviewerDispatch = Readonly<{
  identity: string;
  recipe: "reviewer-common-bundle-v1";
  input: Readonly<{
    canonicalSkill: ReviewerPromptText;
    construction: ReviewerConstructionIdentity;
  }>;
  targetSnapshot: ReviewerPinnedTarget;
  range: ReviewerRange;
  /** Frozen durable authority references carried into Spec evidence-child material only. */
  authorityRefs: readonly string[];
  /** Honest Spec-child disposition: launched, or skipped after confirmed missing Spec. */
  specDisposition: ReviewerSpecDisposition;
  /** Self-fetch bytes + source annotation when primary path produced material. */
  specFetchedMaterial?: ReviewerSpecFetchedMaterial;
  legs: readonly ConstructedReviewerLeg[];
}>;

/**
 * Spec-only evidence-child material carrier for durable authority references.
 * Exact values preserved; no prose extraction and no Standards/parent injection.
 */
export function reviewerAuthorityRefsMaterial(authorityRefs: readonly string[]): string {
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
export function reviewerFetchedSpecMaterial(fetched: ReviewerSpecFetchedMaterial): string {
  return [
    "权威取回-Spec：",
    JSON.stringify(
      Object.freeze({
        source: fetched.adopted.source,
        ticketNumber: fetched.ticketNumber,
        issueRef: fetched.issueRef,
        abandoned: Object.freeze([...fetched.abandoned]),
        issueBody: fetched.issueBody,
        adrs: Object.freeze(
          fetched.adrs.map((adr) =>
            adr.status === "present"
              ? Object.freeze({ path: adr.path, status: adr.status, body: adr.body })
              : Object.freeze({ path: adr.path, status: adr.status }),
          ),
        ),
      }),
    ),
  ].join("\n");
}

/** Deterministic compiler: fixed target/range plus discovery product in, dispatch text out. */
export function constructReviewerDispatch(input: {
  identity: string;
  canonicalSkill: string;
  target: ReviewerPinnedTarget;
  range: ReviewerRange;
  reviewScopeKeys?: readonly string[];
  /** Unique discovery product (available+refs material, or missing). */
  specAuthority: ReviewerSpecAuthorityDiscovery;
}): ConstructedReviewerDispatch {
  const launchSpec = input.specAuthority.status === "available";
  const authorityRefs = Object.freeze(
    input.specAuthority.status === "available" ? [...input.specAuthority.refs] : [],
  );
  const specFetchedMaterial =
    input.specAuthority.status === "available" && input.specAuthority.fetched !== undefined
      ? input.specAuthority.fetched
      : undefined;
  const specDisposition: ReviewerSpecDisposition = launchSpec ? "launched" : "skipped-missing";
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
  const axes: readonly { axis: "standards" | "spec" }[] = launchSpec
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
