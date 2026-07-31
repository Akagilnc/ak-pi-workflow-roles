import { exactUtf8 } from "./exact-utf8.ts";
import { reviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import { sha256Hex } from "./sha256.ts";

export const REVIEWER_CONSTRUCTION_RECIPE = Object.freeze({
  recipeId: "reviewer-common-bundle",
  version: 1,
  runtimeVersion: "1",
  implementationSha256: sha256Hex("reviewer-common-bundle:v1:path-digest-prompts"),
});
export type ReviewerConstructionIdentity = typeof REVIEWER_CONSTRUCTION_RECIPE;
export type MechanicalBundleOrigin = "canonical-skill" | "pinned-target" | "derived-range" | "runtime-recipe";
export type PinnedMechanicalBundleEntryV1 = Readonly<{
  id: string; relativeClonePath: string; origin: MechanicalBundleOrigin;
  sourceIdentity: string; bytes: string; utf8Length: number; sha256: string;
}>;
export type PinnedMechanicalBundleV1 = Readonly<{
  recipeIdentity: ReviewerConstructionIdentity;
  manifestSha256: string;
  entries: readonly PinnedMechanicalBundleEntryV1[];
}>;
export type CanonicalSkillIdentity = Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: ReviewerPromptIdentity }>;

function entry(id: string, path: string, origin: MechanicalBundleOrigin, sourceIdentity: string, bytes: string): PinnedMechanicalBundleEntryV1 {
  return Object.freeze({ id, relativeClonePath: path, origin, sourceIdentity, bytes, utf8Length: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) });
}
function manifestBytes(entries: readonly PinnedMechanicalBundleEntryV1[]): string {
  return JSON.stringify({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, entries: entries.map(({ bytes: _bytes, ...identity }) => identity) });
}
export function compileMechanicalBundle(input: {
  canonicalSkill: string;
  task: string;
  range: { base: string; target: string; diffCommand: string; diffSha256: string; commits: readonly string[] };
  materials: readonly { id: string; repositoryPath: string; text: string; sha256: string }[];
}): { canonicalSkill: CanonicalSkillIdentity; construction: ReviewerConstructionIdentity; bundle: PinnedMechanicalBundleV1 } {
  const skillIdentity = reviewerPromptIdentity(input.canonicalSkill);
  const canonicalSkill = Object.freeze({ sha256: skillIdentity.sha256, utf8Length: skillIdentity.utf8Length, snapshotIdentity: skillIdentity });
  const entries = Object.freeze([
    entry("canonical-skill", ".ak-reviewer/materials/canonical-skill.md", "canonical-skill", skillIdentity.sha256, input.canonicalSkill),
    entry("opaque-task", ".ak-reviewer/materials/task.md", "runtime-recipe", sha256Hex(input.task), input.task),
    entry("review-range", ".ak-reviewer/materials/range.json", "derived-range", input.range.diffSha256, JSON.stringify(input.range, null, 2) + "\n"),
    ...input.materials.map((item) => entry(`material-${item.id}`, `.ak-reviewer/materials/selected/${item.id}.md`, "pinned-target", `${item.repositoryPath}@${input.range.target}:${item.sha256}`, item.text)),
  ]);
  const paths = entries.map((item) => item.relativeClonePath.normalize("NFC"));
  if (new Set(paths).size !== paths.length) throw new Error("Mechanical bundle path collision");
  const bundle = Object.freeze({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, manifestSha256: sha256Hex(manifestBytes(entries)), entries });
  return { canonicalSkill, construction: REVIEWER_CONSTRUCTION_RECIPE, bundle };
}
export function bundlePromptReferences(bundle: PinnedMechanicalBundleV1): string {
  return bundle.entries.map(({ id, relativeClonePath, sha256 }) => `Bundle-Material: ${JSON.stringify({ id, relativeClonePath, sha256 })}`).join("\n");
}
export function verifyBundleIdentity(bundle: PinnedMechanicalBundleV1): boolean {
  return bundle.entries.every((item) => exactUtf8(Buffer.from(item.bytes), item.id) === item.bytes && Buffer.byteLength(item.bytes) === item.utf8Length && sha256Hex(item.bytes) === item.sha256) && sha256Hex(manifestBytes(bundle.entries)) === bundle.manifestSha256;
}
