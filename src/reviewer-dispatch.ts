import { exactUtf8 } from "./exact-utf8.ts";
import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import { createReviewerPinnedGitReader, immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
export { createReviewerPinnedGitReader, immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
import { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import { reviewerScopePrompt } from "./reviewer-scope-prompt.ts";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.ts";
import { sha256Hex } from "./sha256.ts";
import { bundlePromptReferences, compileMechanicalBundle, reviewerAxisMethodAdapter, type CanonicalSkillIdentity, type PinnedMechanicalBundleV1, type ReviewerConstructionIdentity } from "./reviewer-construction.ts";
export { sha256Hex } from "./sha256.ts";
export { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

export const REVIEWER_CHILD_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
] as const;

export const REVIEWER_PREREQUISITES = [
  "preflight.git.pin-target",
  "preflight.git.resolve-base",
  "preflight.git.derive-range",
  "preflight.git.list-ordered-commits",
  "preflight.git.read-material",
  "runner.git.materialize-mirror",
  "runner.git.materialize-workspace",
  "runner.git.verify-snapshot",
] as const;

const DISPATCH_PREREQUISITES = REVIEWER_PREREQUISITES.filter((operation) =>
  operation.startsWith("preflight."),
);

export type ReviewerChildToolName = (typeof REVIEWER_CHILD_TOOLS)[number];
export type ReviewerPrerequisiteOperation = (typeof REVIEWER_PREREQUISITES)[number];
export type ReviewerCapabilityRequest = Readonly<{
  tools: readonly ReviewerChildToolName[];
  bashCommands: readonly string[];
  prerequisiteOperations: readonly ReviewerPrerequisiteOperation[];
}>;
export type ReviewerCapabilitiesV1 = ReviewerCapabilityRequest &
  Readonly<{ version: 1; taskSha256: string; document: ReviewerPromptIdentity }>;
export type MaterialSelection = Readonly<{ id: string; repositoryPath: string }>;
export type ReviewerProposalV1 = Readonly<{
  version: 1;
  base: Readonly<{ revision: string }>;
  materials: readonly MaterialSelection[];
  relevanceHints?: Readonly<{ standards?: readonly string[]; spec?: readonly string[] }>;
  spec: Readonly<{ state: "established" | "not-established" }>;
  required: Readonly<{ standards: ReviewerCapabilityRequest; spec?: ReviewerCapabilityRequest }>;
}>;
export type AcceptedReviewerLeg = Readonly<{
  axis: "standards" | "spec";
  prompt: ReviewerPromptIdentity;
  grant: ReviewerCapabilityRequest;
}>;
export type AcceptedReviewerExecution = Readonly<{
  identity: string;
  recipe: "reviewer-common-bundle-v1";
  targetSnapshot: ReviewerPinnedTarget;
  bundle: PinnedMechanicalBundleV1;
  prerequisiteOperations: readonly ReviewerPrerequisiteOperation[];
  legs: readonly AcceptedReviewerLeg[];
}>;
export type AcceptedReviewerDispatch = Readonly<{
  identity: string;
  recipe: "reviewer-common-bundle-v1";
  input: Readonly<{
    task: ReviewerPromptIdentity;
    canonicalSkill: CanonicalSkillIdentity;
    construction: ReviewerConstructionIdentity;
    capabilityDocument: ReviewerPromptIdentity;
  }>;
  targetSnapshot: ReviewerPinnedTarget;
  prerequisiteOperations: readonly ReviewerPrerequisiteOperation[];
  range: ReviewerRange;
  materials: readonly ReviewerMaterialEvidence[];
  relevanceHints?: Readonly<{ standards?: readonly string[]; spec?: readonly string[] }>;
  bundle: PinnedMechanicalBundleV1;
  legs: readonly AcceptedReviewerLeg[];
}>;
export type ReviewerMaterialEvidence = Readonly<MaterialSelection & ReviewerPromptIdentity>;
export const REVIEWER_PREFLIGHT_VIOLATIONS = [
  "proposal-invalid", "base-invalid", "material-invalid", "spec-invalid",
  "capability-invalid", "prerequisite-missing", "range-invalid",
  "prompt-identity-invalid", "prompt-identity-mismatch", "target-drift",
] as const;
export type ReviewerPreflightViolation = (typeof REVIEWER_PREFLIGHT_VIOLATIONS)[number];
export type ReviewerRejectionEvidence = Readonly<{
  identity: string;
  violations: readonly ReviewerPreflightViolation[];
  started: false;
}>;
export type ReviewerAcceptanceEvidence = Readonly<{
  identity: string;
  recipe: "reviewer-dispatch-v1";
  cardinality: 1 | 2;
}>;
export type ReviewerClosedAttemptEvidence = Readonly<{
  identity: string;
  reason: "acceptance-closed";
  started: false;
}>;
export type ReviewerDispatchResult =
  | Readonly<{ status: "rejected"; identity: string; violations: readonly ReviewerPreflightViolation[] }>
  | Readonly<{ status: "accepted"; dispatch: AcceptedReviewerDispatch; results: unknown }>
  | Readonly<{ status: "closed"; identity: string; reason: "acceptance-closed"; started: false }>;
export type ReviewerDecisionEvidence =
  | Readonly<{ disposition: "rejected"; identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }>
  | Readonly<{ disposition: "accepted"; identity: string; dispatch: AcceptedReviewerDispatch }>
  | Readonly<{ disposition: "closed"; identity: string; reason: "acceptance-closed"; started: false }>;

type DispatcherDependencies = Readonly<{
  task: Uint8Array;
  canonicalSkill: string;
  capabilities: ReviewerCapabilitiesV1;
  reader: ReviewerPinnedGitReader;
  hostTools: readonly string[];
  reviewScopeKeys?: readonly string[];
  run(execution: AcceptedReviewerExecution, invocation: unknown): Promise<unknown>;
  /** Synchronous append-only projection at the lifecycle decision boundary. */
  decisionEvidence?: (decision: ReviewerDecisionEvidence) => void;
  /** Testable identity boundary; production uses reviewerPromptIdentity. */
  compilePrompt?: (prompt: string, axis: "standards" | "spec", pass: 1 | 2) => ReviewerPromptIdentity;
  /** Testable recipe render seam; production renders exact frozen material evidence. */
  renderMaterial?: (evidence: ReviewerMaterialEvidence, axis: "standards" | "spec", pass: 1 | 2) => string;
}>;

export class ReviewerPreflightError extends Error {
  constructor(readonly code: ReviewerPreflightViolation) { super(code); }
}
const violation = (code: ReviewerPreflightViolation): never => { throw new ReviewerPreflightError(code); };
const classifyReadFailure = (error: unknown): never => {
  if (error instanceof ReviewerCorrectablePreflightError) violation(error.code);
  throw error;
};

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasUniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function freezeStrings<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function validateCapabilityRequestShape(value: unknown): ReviewerCapabilityRequest {
  if (!isExactObject(value, ["tools", "bashCommands", "prerequisiteOperations"]))
    throw new ReviewerPreflightError("capability-invalid");
  const { tools, bashCommands, prerequisiteOperations } = value;
  if (!Array.isArray(tools) || !Array.isArray(bashCommands) || !Array.isArray(prerequisiteOperations) ||
      !tools.every((item): item is ReviewerChildToolName => typeof item === "string" && (REVIEWER_CHILD_TOOLS as readonly string[]).includes(item)) ||
      !bashCommands.every((item): item is string => typeof item === "string") ||
      !prerequisiteOperations.every((item): item is ReviewerPrerequisiteOperation => typeof item === "string" && (REVIEWER_PREREQUISITES as readonly string[]).includes(item)) ||
      !hasUniqueValues(tools) || !hasUniqueValues(bashCommands) || !hasUniqueValues(prerequisiteOperations))
    throw new ReviewerPreflightError("capability-invalid");
  if (bashCommands.length > 0 && !tools.includes("bash"))
    violation("capability-invalid");
  return { tools, bashCommands, prerequisiteOperations };
}

function immutableRequest(request: ReviewerCapabilityRequest): ReviewerCapabilityRequest {
  return Object.freeze({
    tools: freezeStrings(request.tools),
    bashCommands: freezeStrings(request.bashCommands),
    prerequisiteOperations: freezeStrings(request.prerequisiteOperations),
  });
}

/** The sole dispatch-owned projection across the opaque runner boundary. */
export function toReviewerExecution(dispatch: AcceptedReviewerDispatch): AcceptedReviewerExecution {
  return Object.freeze({
    identity: dispatch.identity,
    recipe: dispatch.recipe,
    targetSnapshot: immutableReviewerPin(dispatch.targetSnapshot),
    bundle: dispatch.bundle,
    prerequisiteOperations: freezeStrings(dispatch.prerequisiteOperations),
    legs: Object.freeze(dispatch.legs.map((leg) => Object.freeze({
      axis: leg.axis,
      prompt: Object.freeze({ text: leg.prompt.text, utf8Length: leg.prompt.utf8Length, sha256: leg.prompt.sha256 }),
      grant: immutableRequest(leg.grant),
    }))),
  });
}

export function parseReviewerCapabilities(
  raw: Uint8Array,
  task: Uint8Array,
): ReviewerCapabilitiesV1 {
  let value: unknown;
  let documentText: string;
  try {
    documentText = exactUtf8(raw, "Reviewer capabilities");
    value = JSON.parse(documentText);
  } catch {
    throw new Error("Invalid Reviewer capabilities UTF-8 JSON");
  }

  if (
    !isExactObject(value, [
      "version",
      "taskSha256",
      "tools",
      "bashCommands",
      "prerequisiteOperations",
    ])
  ) {
    throw new Error("Invalid Reviewer capabilities keys");
  }
  const { version, taskSha256, tools, bashCommands, prerequisiteOperations } = value;
  if (
    version !== 1 ||
    typeof taskSha256 !== "string" ||
    !Array.isArray(tools) ||
    !Array.isArray(bashCommands) ||
    !Array.isArray(prerequisiteOperations)
  ) {
    throw new Error("Invalid Reviewer capabilities schema");
  }
  if (!/^[0-9a-f]{64}$/.test(taskSha256) || taskSha256 !== sha256Hex(task)) {
    throw new Error("Reviewer capabilities task digest mismatch");
  }
  let request: ReviewerCapabilityRequest;
  try { request = validateCapabilityRequestShape({ tools, bashCommands, prerequisiteOperations }); }
  catch { throw new Error("Reviewer capabilities contain unknown or duplicate values"); }
  return Object.freeze({
    version: 1,
    taskSha256,
    document: reviewerPromptIdentity(documentText),
    ...immutableRequest(request),
  });
}

function validateRequest(
  value: unknown,
  ceiling: ReviewerCapabilitiesV1,
  hostTools: readonly string[],
): ReviewerCapabilityRequest {
  const { tools, bashCommands, prerequisiteOperations } = validateCapabilityRequestShape(value);
  if (
    tools.some((tool) => !ceiling.tools.includes(tool) || !hostTools.includes(tool)) ||
    prerequisiteOperations.some((operation) => !ceiling.prerequisiteOperations.includes(operation))
  ) {
    violation("capability-invalid");
  }
  return immutableRequest({ tools, bashCommands, prerequisiteOperations });
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateMaterialSelection(value: unknown): asserts value is MaterialSelection {
  if (!isExactObject(value, ["id", "repositoryPath"]) ||
      typeof value.id !== "string" || !SAFE_ID.test(value.id)) {
    throw new ReviewerPreflightError("material-invalid");
  }
  if (typeof value.repositoryPath !== "string" || value.repositoryPath.length === 0 ||
      value.repositoryPath.startsWith("/") || value.repositoryPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(value.repositoryPath) ||
      value.repositoryPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    violation("material-invalid");
  }
}

function skillSection(skill: string, heading: string, nextHeading: string): string {
  const start = skill.indexOf(heading);
  if (start < 0) throw new Error("Canonical Skill section extraction failed");
  const end = skill.indexOf(nextHeading, start + heading.length);
  if (end < 0 || end <= start) throw new Error("Canonical Skill section extraction failed");
  return skill.slice(start, end).trim();
}

function proposalIdentity(proposal: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(proposal);
  } catch {
    encoded = "[unserializable proposal]";
  }
  return sha256Hex(encoded);
}

export function createReviewerDispatcher(dependencies: DispatcherDependencies) {
  const task = Uint8Array.from(dependencies.task);
  const canonicalSkill = dependencies.canonicalSkill;
  const capabilities = dependencies.capabilities;
  const hostTools = freezeStrings(dependencies.hostTools);
  const targetSnapshot = immutableReviewerPin(dependencies.reader.pin);
  let accepted: ReviewerAcceptanceEvidence | undefined;
  let fatalInfrastructure: unknown;
  let accepting = false;
  const rejections: ReviewerRejectionEvidence[] = [];
  const closedAttempts: ReviewerClosedAttemptEvidence[] = [];

  function close(identity: string): ReviewerDispatchResult {
    const evidence = Object.freeze({ identity, reason: "acceptance-closed" as const, started: false as const });
    dependencies.decisionEvidence?.(Object.freeze({ disposition: "closed", ...evidence }));
    closedAttempts.push(evidence);
    return Object.freeze({ status: "closed" as const, ...evidence });
  }

  function reject(identity: string, error: ReviewerPreflightError): ReviewerDispatchResult {
    const violations = Object.freeze<ReviewerPreflightViolation[]>([error.code]);
    const evidence = Object.freeze({ identity, violations, started: false as const });
    dependencies.decisionEvidence?.(Object.freeze({ disposition: "rejected", ...evidence }));
    rejections.push(evidence);
    return Object.freeze({ status: "rejected" as const, identity, violations });
  }

  async function preflightAndCompileDispatch(proposal: ReviewerProposalV1, identity: string): Promise<AcceptedReviewerDispatch> {
    const allowedKeys = proposal.relevanceHints === undefined
      ? ["version", "base", "materials", "spec", "required"]
      : ["version", "base", "materials", "relevanceHints", "spec", "required"];
    if (!isExactObject(proposal, allowedKeys) || proposal.version !== 1) violation("proposal-invalid");
    if (!isExactObject(proposal.base, ["revision"]) || typeof proposal.base.revision !== "string" || proposal.base.revision.length === 0) violation("base-invalid");
    if (!Array.isArray(proposal.materials)) violation("material-invalid");
    proposal.materials.forEach(validateMaterialSelection);
    if (!hasUniqueValues(proposal.materials.map(x => x.id)) || !hasUniqueValues(proposal.materials.map(x => x.repositoryPath.normalize("NFC")))) violation("material-invalid");
    if (!isExactObject(proposal.spec, ["state"]) || (proposal.spec.state !== "established" && proposal.spec.state !== "not-established")) violation("spec-invalid");
    const requiredKeys = proposal.spec.state === "established" ? ["standards", "spec"] : ["standards"];
    if (!isExactObject(proposal.required, requiredKeys)) violation("capability-invalid");
    if (proposal.relevanceHints !== undefined) {
      if (typeof proposal.relevanceHints !== "object" || proposal.relevanceHints === null || Array.isArray(proposal.relevanceHints) || Object.keys(proposal.relevanceHints).some(k => k !== "standards" && k !== "spec")) violation("material-invalid");
      const ids = new Set(proposal.materials.map(x => x.id));
      for (const hints of [proposal.relevanceHints.standards, proposal.relevanceHints.spec]) {
        if (hints !== undefined && (!Array.isArray(hints) || !hints.every(x => typeof x === "string" && ids.has(x)) || !hasUniqueValues(hints))) violation("material-invalid");
      }
    }
    for (const operation of DISPATCH_PREREQUISITES) if (!capabilities.prerequisiteOperations.includes(operation)) violation("prerequisite-missing");
    const standardsGrant = validateRequest(proposal.required.standards, capabilities, hostTools);
    const specGrant = proposal.spec.state === "established" ? validateRequest(proposal.required.spec, capabilities, hostTools) : undefined;
    const runnerOperations = REVIEWER_PREREQUISITES.filter(x => x.startsWith("runner."));
    for (const operation of runnerOperations) if (!capabilities.prerequisiteOperations.includes(operation)) violation("prerequisite-missing");
    const acceptedPrerequisites = freezeStrings([...new Set([...standardsGrant.prerequisiteOperations, ...(specGrant?.prerequisiteOperations ?? []), ...runnerOperations])]);
    let base!: string; let readRange!: ReviewerRange;
    try { base = await dependencies.reader.resolve(proposal.base.revision); readRange = await dependencies.reader.range(base); } catch (error) { classifyReadFailure(error); }
    if (readRange.base !== base || readRange.target !== targetSnapshot.targetHead || readRange.diffCommand !== `git diff ${base}...${targetSnapshot.targetHead}` || !/^[0-9a-f]{64}$/.test(readRange.diffSha256) || readRange.diffSha256 === sha256Hex("") || !Array.isArray(readRange.commits) || !readRange.commits.every(x => typeof x === "string") || !hasUniqueValues(readRange.commits)) violation("range-invalid");
    const range: ReviewerRange = Object.freeze({ ...readRange, commits: freezeStrings(readRange.commits) });
    if (!capabilities.tools.includes("bash") || !capabilities.bashCommands.includes(range.diffCommand)) violation("capability-invalid");
    for (const grant of [standardsGrant, ...(specGrant ? [specGrant] : [])]) if (!grant.tools.includes("bash") || !grant.bashCommands.includes(range.diffCommand) || grant.bashCommands.some(c => !capabilities.bashCommands.includes(c))) violation("capability-invalid");
    const materialEvidence: ReviewerMaterialEvidence[] = [];
    for (const item of proposal.materials) {
      let bytes!: Uint8Array; try { bytes = await dependencies.reader.material(item.repositoryPath, targetSnapshot.targetHead); } catch (error) { classifyReadFailure(error); }
      let text!: string; try { text = exactUtf8(bytes, "Reviewer material"); } catch { violation("material-invalid"); }
      materialEvidence.push(Object.freeze({ ...item, text, utf8Length: bytes.byteLength, sha256: sha256Hex(bytes) }));
    }
    let taskText!: string; try { taskText = exactUtf8(task, "Reviewer task"); } catch { violation("prompt-identity-invalid"); }
    const taskEvidence = reviewerPromptIdentity(taskText);
    const compiled = compileMechanicalBundle({ canonicalSkill, task: taskText, range, materials: materialEvidence });
    const common = [
      `Task-SHA256: ${taskEvidence.sha256}`, `Target: ${range.target}`, `Base: ${range.base}`, `Diff: ${range.diffCommand}`,
      reviewerScopePrompt(dependencies.reviewScopeKeys), `Recipe: ${compiled.construction.recipeId}@${compiled.construction.version}`,
      `Bundle-Manifest-SHA256: ${compiled.bundle.manifestSha256}`, bundlePromptReferences(compiled.bundle),
    ].join("\n");
    const axes: Array<{axis:"standards"|"spec"; grant:ReviewerCapabilityRequest}> = [{ axis:"standards", grant:standardsGrant }, ...(specGrant ? [{axis:"spec" as const, grant:specGrant}] : [])];
    const compilePrompt = dependencies.compilePrompt ?? ((prompt: string) => reviewerPromptIdentity(prompt));
    const build = (axis:"standards"|"spec", grant:ReviewerCapabilityRequest, pass:1|2) => compilePrompt(`${common}\nGrant: ${JSON.stringify(grant)}\n${reviewerAxisMethodAdapter(axis)}\n`, axis, pass);
    const first = axes.map(x => build(x.axis,x.grant,1)); const second = axes.map(x => build(x.axis,x.grant,2));
    for (let i=0;i<first.length;i++) if (!isReviewerPromptIdentity(first[i]!) || !isReviewerPromptIdentity(second[i]!) || !sameReviewerPromptIdentity(first[i]!,second[i]!)) violation(!isReviewerPromptIdentity(first[i]!) || !isReviewerPromptIdentity(second[i]!) ? "prompt-identity-invalid" : "prompt-identity-mismatch");
    const legs = Object.freeze(axes.map((x,i) => Object.freeze({ axis:x.axis, prompt:first[i]!, grant:x.grant })));
    return Object.freeze({ identity, recipe:"reviewer-common-bundle-v1", input:Object.freeze({ task:taskEvidence, canonicalSkill:compiled.canonicalSkill, construction:compiled.construction, capabilityDocument:capabilities.document }), targetSnapshot, prerequisiteOperations:acceptedPrerequisites, range, materials:Object.freeze(materialEvidence), ...(proposal.relevanceHints === undefined ? {} : { relevanceHints:Object.freeze(proposal.relevanceHints) }), bundle:compiled.bundle, legs });
  }

  return Object.freeze({
    get rejections(): readonly ReviewerRejectionEvidence[] {
      return Object.freeze([...rejections]);
    },
    get acceptance(): ReviewerAcceptanceEvidence | undefined {
      return accepted;
    },
    get closedAttempts(): readonly ReviewerClosedAttemptEvidence[] {
      return Object.freeze([...closedAttempts]);
    },
    async propose(proposal: ReviewerProposalV1, invocation?: unknown): Promise<ReviewerDispatchResult> {
      const identity = proposalIdentity(proposal);
      if (fatalInfrastructure !== undefined) throw fatalInfrastructure;
      if (accepted || accepting) return close(identity);
      let dispatch: AcceptedReviewerDispatch;
      try {
        dispatch = await preflightAndCompileDispatch(proposal, identity);
      } catch (error) {
        // Compilation awaits repository I/O; another proposal may accept meanwhile.
        if (accepted || accepting) return close(identity);
        if (error instanceof ReviewerPreflightError) return reject(identity, error);
        fatalInfrastructure = error;
        throw error;
      }

      // Another async proposal may have completed preflight while this one awaited pin reads.
      if (accepted || accepting) return close(identity);
      try {
        const live = await dependencies.reader.snapshot();
        if (!sameReviewerPinnedTarget(live, targetSnapshot)) {
          violation("target-drift");
        }
      } catch (error) {
        if (accepted || accepting) return close(identity);
        if (error instanceof ReviewerPreflightError) return reject(identity, error);
        fatalInfrastructure = error;
        throw error;
      }
      if (accepted || accepting) return close(identity);
      dependencies.decisionEvidence?.(Object.freeze({ disposition: "accepted", identity, dispatch }));
      accepting = true;
      accepted = Object.freeze({
        identity,
        recipe: "reviewer-dispatch-v1",
        cardinality: dispatch.legs.length as 1 | 2,
      });
      const results = await dependencies.run(toReviewerExecution(dispatch), invocation);
      return Object.freeze({ status: "accepted", dispatch, results });
    },
  });
}
