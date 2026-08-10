import { exactUtf8 } from "./exact-utf8.ts";
import { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import { sha256Hex } from "./sha256.ts";
import { reviewerScopePrompt } from "./reviewer-scope-prompt.ts";
import type { AdmittedReviewerProposal, ReviewerCapabilityRequest, ReviewerPrerequisiteOperation } from "./reviewer-admission.ts";
import type { ReviewerFrozenEvidence, ReviewerPinnedTarget } from "./reviewer-pinned-git.ts";

export const REVIEWER_CONSTRUCTION_RECIPE = Object.freeze({
  recipeId: "reviewer-common-bundle",
  version: 1,
  runtimeVersion: "1",
  implementationSha256: sha256Hex("reviewer-common-bundle:v1:path-digest-prompts"),
});
export type ReviewerConstructionIdentity = typeof REVIEWER_CONSTRUCTION_RECIPE;
export type ReviewerAxis = "standards" | "spec";

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
] as const);
export type ReviewerStandardsConclusionKey = (typeof REVIEWER_STANDARDS_CONCLUSION_KEYS)[number];

const REVIEWER_STANDARDS_CONCLUSION_LABELS = Object.freeze({
  constitutionality: "constitutionality",
  "minimum-necessary-test-cost": "minimum-necessary test cost",
  complexity: "complexity",
} as const satisfies Record<ReviewerStandardsConclusionKey, string>);

/** Axis-owned required/excluded Standards conclusions — machine contract for prompt rendering and tests. */
export type ReviewerAxisOutputContract = Readonly<{
  axis: ReviewerAxis;
  requiredConclusions: readonly ReviewerStandardsConclusionKey[];
  excludedConclusions: readonly ReviewerStandardsConclusionKey[];
}>;

export function reviewerAxisOutputContract(axis: ReviewerAxis): ReviewerAxisOutputContract {
  const three = REVIEWER_STANDARDS_CONCLUSION_KEYS;
  return axis === "standards"
    ? Object.freeze({ axis, requiredConclusions: three, excludedConclusions: Object.freeze([]) })
    : Object.freeze({ axis, requiredConclusions: Object.freeze([]), excludedConclusions: three });
}

function renderConclusionList(
  keys: readonly ReviewerStandardsConclusionKey[],
  finalJoiner: "and" | "or",
): string {
  const labels = keys.map((key) => REVIEWER_STANDARDS_CONCLUSION_LABELS[key]);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} ${finalJoiner} ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, ${finalJoiner} ${labels[labels.length - 1]}`;
}

function renderAxisPriorityClause(contract: ReviewerAxisOutputContract): string {
  if (contract.requiredConclusions.length > 0) {
    return `Inside that single Standards report, explicitly conclude on ${renderConclusionList(contract.requiredConclusions, "and")}; a finding or clear no-finding on each counts as a conclusion.`;
  }
  return `Do not discuss ${renderConclusionList(contract.excludedConclusions, "or")}; those are Standards judgements.`;
}

/** Package-owned mechanics layered over the unchanged canonical Skill semantics. */
export type ReviewerAxisMaterialReference = Readonly<{ id: string; relativeClonePath: string; utf8Length: number; sha256: string }>;

export function reviewerAxisMethodAdapter(axis: ReviewerAxis, materialReferences: readonly ReviewerAxisMaterialReference[] = []): string {
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
export type MechanicalBundleOrigin = "canonical-skill" | "pinned-target" | "host-input" | "derived-range" | "runtime-recipe";
export type PinnedMechanicalBundleEntryV1 = Readonly<{
  id: string; relativeClonePath: string; origin: MechanicalBundleOrigin;
  sourceIdentity: string; bytes: string; utf8Length: number; sha256: string;
}>;
export type PinnedMechanicalBundleV1 = Readonly<{
  recipeIdentity: ReviewerConstructionIdentity;
  manifestSha256: string;
  entries: readonly PinnedMechanicalBundleEntryV1[];
}>;
export type MechanicalBundleIdentityV1 = Readonly<{
  recipeIdentity: ReviewerConstructionIdentity;
  manifestSha256: string;
  entries: readonly Readonly<Omit<PinnedMechanicalBundleEntryV1, "bytes">>[];
}>;
export type CanonicalSkillIdentity = Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: ReviewerPromptIdentity }>;

function entry(id: string, path: string, origin: MechanicalBundleOrigin, sourceIdentity: string, bytes: string): PinnedMechanicalBundleEntryV1 {
  return Object.freeze({ id, relativeClonePath: path, origin, sourceIdentity, bytes, utf8Length: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) });
}
function manifestBytes(entries: readonly (PinnedMechanicalBundleEntryV1 | Omit<PinnedMechanicalBundleEntryV1, "bytes">)[]): string {
  return JSON.stringify({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, entries: entries.map((entry) => {
    const { bytes: _bytes, ...identity } = entry as PinnedMechanicalBundleEntryV1;
    return identity;
  }) });
}
export function compileMechanicalBundle(input: {
  canonicalSkill: string;
  task: string;
  range: { base: string; target: string; diffCommand: string; diffSha256: string; commits: readonly string[] };
  materials: readonly { id: string; repositoryPath: string; source?: "pinned-git" | "host-input"; sourcePath?: string; text: string; sha256: string }[];
}): { canonicalSkill: CanonicalSkillIdentity; construction: ReviewerConstructionIdentity; bundle: PinnedMechanicalBundleV1 } {
  const skillIdentity = reviewerPromptIdentity(input.canonicalSkill);
  const canonicalSkill = Object.freeze({ sha256: skillIdentity.sha256, utf8Length: skillIdentity.utf8Length, snapshotIdentity: skillIdentity });
  const entries = Object.freeze([
    entry("canonical-skill", ".ak-reviewer/materials/canonical-skill.md", "canonical-skill", skillIdentity.sha256, input.canonicalSkill),
    entry("opaque-task", ".ak-reviewer/materials/task.md", "runtime-recipe", sha256Hex(input.task), input.task),
    entry("review-range", ".ak-reviewer/materials/range.json", "derived-range", input.range.diffSha256, JSON.stringify(input.range, null, 2) + "\n"),
    ...input.materials.map((item) => entry(`material-${item.id}`, `.ak-reviewer/materials/selected/${item.id}.md`, item.source === "host-input" ? "host-input" : "pinned-target", `${item.source === "host-input" ? `host-input:${item.sourcePath}` : `pinned-git:${item.repositoryPath}@${input.range.target}`}@${item.sha256}`, item.text)),
  ]);
  const paths = entries.map((item) => item.relativeClonePath.normalize("NFC"));
  if (new Set(paths).size !== paths.length) throw new Error("Mechanical bundle path collision");
  const bundle = Object.freeze({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, manifestSha256: sha256Hex(manifestBytes(entries)), entries });
  return { canonicalSkill, construction: REVIEWER_CONSTRUCTION_RECIPE, bundle };
}
export type FinalizedReviewerGrant = ReviewerCapabilityRequest & Readonly<{ bashCommands: readonly string[] }>;
export type ConstructedReviewerLeg = Readonly<{ axis:"standards"|"spec"; prompt:ReviewerPromptIdentity; grant:FinalizedReviewerGrant }>;
export type ConstructedReviewerDispatch = Readonly<{ identity:string; recipe:"reviewer-common-bundle-v1"; input:Readonly<{task:ReviewerPromptIdentity;canonicalSkill:CanonicalSkillIdentity;construction:ReviewerConstructionIdentity;capabilityDocument:ReviewerPromptIdentity}>; targetSnapshot:ReviewerPinnedTarget; prerequisiteOperations:readonly ReviewerPrerequisiteOperation[]; range:ReviewerFrozenEvidence["range"]; materials:ReviewerFrozenEvidence["materials"]; relevanceHints?:AdmittedReviewerProposal["relevanceHints"]; bundle:PinnedMechanicalBundleV1; legs:readonly ConstructedReviewerLeg[] }>;
export type ReviewerPromptCompiler = (prompt:string,axis:"standards"|"spec",pass:1|2)=>ReviewerPromptIdentity;

/** Deterministic compiler: admitted immutable policy plus frozen evidence in, dispatch bytes out. */
export function constructReviewerDispatch(input:{identity:string;taskText:string;canonicalSkill:string;capabilityDocument:ReviewerPromptIdentity;target:ReviewerPinnedTarget;admitted:AdmittedReviewerProposal;evidence:ReviewerFrozenEvidence;reviewScopeKeys?:readonly string[];compilePrompt?:ReviewerPromptCompiler}):ConstructedReviewerDispatch {
  const task=reviewerPromptIdentity(input.taskText); const compiled=compileMechanicalBundle({canonicalSkill:input.canonicalSkill,task:input.taskText,range:input.evidence.range,materials:input.evidence.materials});
  const common=[`Task-SHA256: ${task.sha256}`,`Target: ${input.evidence.range.target}`,`Base: ${input.evidence.range.base}`,`Diff: ${input.evidence.range.diffCommand}`,reviewerScopePrompt(input.reviewScopeKeys),`Recipe: ${compiled.construction.recipeId}@${compiled.construction.version}`,`Bundle-Manifest-SHA256: ${compiled.bundle.manifestSha256}`,bundlePromptReferences(compiled.bundle)].join("\n");
  const finalize=(grant:ReviewerCapabilityRequest):FinalizedReviewerGrant=>Object.freeze({...grant,bashCommands:Object.freeze([])});
  const axes:Array<{axis:"standards"|"spec";grant:FinalizedReviewerGrant}>=[{axis:"standards",grant:finalize(input.admitted.standardsGrant)},...(input.admitted.specGrant?[{axis:"spec" as const,grant:finalize(input.admitted.specGrant)}]:[])];
  const compile=input.compilePrompt??((text:string)=>reviewerPromptIdentity(text)); const materialReferences=compiled.bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => ({ id, relativeClonePath, utf8Length, sha256 })); const build=(x:typeof axes[number],pass:1|2)=>compile(`${common}\nGrant: ${JSON.stringify(x.grant)}\n${reviewerAxisMethodAdapter(x.axis, materialReferences)}\n`,x.axis,pass);
  const first=axes.map(x=>build(x,1)),second=axes.map(x=>build(x,2));
  for(let i=0;i<first.length;i++){if(!isReviewerPromptIdentity(first[i]!)||!isReviewerPromptIdentity(second[i]!))throw new ReviewerConstructionError("prompt-identity-invalid");if(!sameReviewerPromptIdentity(first[i]!,second[i]!))throw new ReviewerConstructionError("prompt-identity-mismatch");}
  return Object.freeze({identity:input.identity,recipe:"reviewer-common-bundle-v1",input:Object.freeze({task,canonicalSkill:compiled.canonicalSkill,construction:compiled.construction,capabilityDocument:input.capabilityDocument}),targetSnapshot:input.target,prerequisiteOperations:input.admitted.prerequisiteOperations,range:input.evidence.range,materials:input.evidence.materials,...(input.admitted.relevanceHints===undefined?{}:{relevanceHints:input.admitted.relevanceHints}),bundle:compiled.bundle,legs:Object.freeze(axes.map((x,i)=>Object.freeze({...x,prompt:first[i]!}))) });
}
export class ReviewerConstructionError extends Error {
  constructor(
    readonly code:"prompt-identity-invalid"|"prompt-identity-mismatch",
    readonly diagnostic = code === "prompt-identity-invalid"
      ? "compiled prompt identity must contain canonical text, UTF-8 length, and SHA-256"
      : "repeated prompt compilation must produce the same prompt identity",
  ){super(`${code}: ${diagnostic}`);}
}

export function bundlePromptReferences(bundle: PinnedMechanicalBundleV1): string {
  return bundle.entries.map(({ id, relativeClonePath, origin, sourceIdentity, sha256 }) => `Bundle-Material: ${JSON.stringify({ id, relativeClonePath, origin, sourceIdentity, sha256 })}`).join("\n");
}
export function projectMechanicalBundleIdentity(bundle: PinnedMechanicalBundleV1): MechanicalBundleIdentityV1 {
  return Object.freeze({
    recipeIdentity: bundle.recipeIdentity,
    manifestSha256: bundle.manifestSha256,
    entries: Object.freeze(bundle.entries.map(({ bytes: _bytes, ...identity }) => Object.freeze(identity))),
  });
}
export function verifyBundleIdentity(bundle: PinnedMechanicalBundleV1 | MechanicalBundleIdentityV1): boolean {
  return bundle.entries.every((item) => {
    if ("bytes" in item) {
      const bytes = (item as PinnedMechanicalBundleEntryV1).bytes;
      return exactUtf8(Buffer.from(bytes), item.id) === bytes && Buffer.byteLength(bytes) === item.utf8Length && sha256Hex(bytes) === item.sha256;
    }
    return typeof item.id === "string" && typeof item.relativeClonePath === "string" && typeof item.origin === "string" && typeof item.sourceIdentity === "string" && Number.isInteger(item.utf8Length) && item.utf8Length >= 0 && /^[0-9a-f]{64}$/.test(item.sha256);
  }) && sha256Hex(manifestBytes(bundle.entries)) === bundle.manifestSha256;
}
