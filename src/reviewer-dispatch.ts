import { exactUtf8 } from "./exact-utf8.ts";
import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import { createReviewerPinnedGitReader, immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
export { createReviewerPinnedGitReader, immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
import { isReviewerPromptIdentity, reviewerPromptIdentity, sameReviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.ts";
import { sha256Hex } from "./sha256.ts";
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
  standardsMaterials: readonly MaterialSelection[];
  spec:
    | Readonly<{ state: "established"; materials: readonly MaterialSelection[] }>
    | Readonly<{ state: "not-established"; evidence: readonly MaterialSelection[] }>;
  required: Readonly<{
    standards: ReviewerCapabilityRequest;
    spec?: ReviewerCapabilityRequest;
  }>;
}>;
export type AcceptedReviewerLeg = Readonly<{
  axis: "standards" | "spec";
  prompt: ReviewerPromptIdentity;
  grant: ReviewerCapabilityRequest;
}>;
export type AcceptedReviewerDispatch = Readonly<{
  identity: string;
  recipe: "reviewer-dispatch-v1";
  input: Readonly<{
    task: ReviewerPromptIdentity;
    canonicalSkillSha256: string;
    capabilityDocument: ReviewerPromptIdentity;
  }>;
  targetSnapshot: ReviewerPinnedTarget;
  prerequisiteOperations: readonly ReviewerPrerequisiteOperation[];
  range: ReviewerRange;
  materials: Readonly<{
    standards: readonly ReviewerMaterialEvidence[];
    spec?: readonly ReviewerMaterialEvidence[];
    noSpecEvidence?: readonly ReviewerMaterialEvidence[];
  }>;
  legs: readonly AcceptedReviewerLeg[];
}>;
export type ReviewerMaterialEvidence = Readonly<MaterialSelection & ReviewerPromptIdentity>;
export const REVIEWER_PREFLIGHT_VIOLATIONS = [
  "proposal-invalid", "base-invalid", "material-invalid", "spec-invalid",
  "capability-invalid", "prerequisite-missing", "range-invalid",
  "prompt-identity-invalid", "prompt-identity-mismatch", "target-drift",
  "preflight-infrastructure",
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

type DispatcherDependencies = Readonly<{
  task: Uint8Array;
  canonicalSkill: string;
  capabilities: ReviewerCapabilitiesV1;
  reader: ReviewerPinnedGitReader;
  hostTools: readonly string[];
  run(dispatch: AcceptedReviewerDispatch, invocation: unknown): Promise<unknown>;
  /** Testable compiler boundary; production uses reviewerPromptIdentity. */
  compilePrompt?: (prompt: string, axis: "standards" | "spec", pass: 1 | 2) => ReviewerPromptIdentity;
}>;

export class ReviewerPreflightError extends Error {
  constructor(readonly code: ReviewerPreflightViolation) { super(code); }
}
const violation = (code: ReviewerPreflightViolation): never => { throw new ReviewerPreflightError(code); };
const classifyReadFailure = (error: unknown): never => {
  if (error instanceof ReviewerCorrectablePreflightError) violation(error.code);
  throw new ReviewerPreflightError("preflight-infrastructure");
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
  if (start < 0) violation("preflight-infrastructure");
  const end = skill.indexOf(nextHeading, start + heading.length);
  if (end < 0 || end <= start) violation("preflight-infrastructure");
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
  let accepting = false;
  const rejections: ReviewerRejectionEvidence[] = [];
  const closedAttempts: ReviewerClosedAttemptEvidence[] = [];

  function close(identity: string): ReviewerDispatchResult {
    const evidence = Object.freeze({ identity, reason: "acceptance-closed" as const, started: false as const });
    closedAttempts.push(evidence);
    return Object.freeze({ status: "closed" as const, ...evidence });
  }

  function reject(identity: string, error: unknown): ReviewerDispatchResult {
    const code: ReviewerPreflightViolation = error instanceof ReviewerPreflightError
      ? error.code
      : "preflight-infrastructure";
    const violations = Object.freeze<ReviewerPreflightViolation[]>([code]);
    rejections.push(Object.freeze({ identity, violations, started: false as const }));
    return Object.freeze({ status: "rejected" as const, identity, violations });
  }

  async function preflightAndCompileDispatch(proposal: ReviewerProposalV1, identity: string): Promise<AcceptedReviewerDispatch> {
    if (!isExactObject(proposal, ["version", "base", "standardsMaterials", "spec", "required"]) || proposal.version !== 1) {
      violation("proposal-invalid");
    }
    if (!isExactObject(proposal.base, ["revision"]) || typeof proposal.base.revision !== "string" || proposal.base.revision.length === 0) {
      violation("base-invalid");
    }
    if (!Array.isArray(proposal.standardsMaterials)) {
      violation("material-invalid");
    }
    proposal.standardsMaterials.forEach(validateMaterialSelection);
    const axisPlan = proposal.spec?.state === "established"
      ? Object.freeze({ kind: "two-leg" as const, selections: proposal.spec.materials, requiredKeys: ["standards", "spec"] as const })
      : proposal.spec?.state === "not-established"
        ? Object.freeze({ kind: "standards-only" as const, selections: proposal.spec.evidence, requiredKeys: ["standards"] as const })
        : undefined;
    if (axisPlan === undefined || !isExactObject(proposal.spec, ["state", axisPlan.kind === "two-leg" ? "materials" : "evidence"])) {
      throw new ReviewerPreflightError("spec-invalid");
    }
    if (!isExactObject(proposal.required, axisPlan.requiredKeys)) {
      violation("capability-invalid");
    }
    const specSelections = axisPlan.selections;
    if (!Array.isArray(specSelections) || specSelections.length === 0) violation("spec-invalid");
    specSelections.forEach(validateMaterialSelection);

    const allSelections = [...proposal.standardsMaterials, ...specSelections];
    if (!hasUniqueValues(allSelections.map(({ id }) => id)) ||
        !hasUniqueValues(allSelections.map(({ repositoryPath }) => repositoryPath.normalize("NFC"))))
      violation("material-invalid");
    for (const operation of DISPATCH_PREREQUISITES) {
      if (!capabilities.prerequisiteOperations.includes(operation)) {
        violation("prerequisite-missing");
      }
    }

    const standardsGrant = validateRequest(proposal.required.standards, capabilities, hostTools);
    const specGrant = axisPlan.kind === "two-leg"
      ? validateRequest(proposal.required.spec, capabilities, hostTools)
      : undefined;
    const runnerOperations = REVIEWER_PREREQUISITES.filter((operation) => operation.startsWith("runner."));
    const acceptedPrerequisites = freezeStrings([...new Set([
      ...standardsGrant.prerequisiteOperations,
      ...(specGrant?.prerequisiteOperations ?? []),
    ])]);
    for (const operation of runnerOperations) {
      if (!capabilities.prerequisiteOperations.includes(operation) || !acceptedPrerequisites.includes(operation)) {
        violation("prerequisite-missing");
      }
    }

    let base!: string;
    let readRange!: ReviewerRange;
    try {
      base = await dependencies.reader.resolve(proposal.base.revision);
      readRange = await dependencies.reader.range(base);
    } catch (error) { classifyReadFailure(error); }
    if (readRange.base !== base || readRange.target !== targetSnapshot.targetHead) {
      violation("range-invalid");
    }
    if (
      readRange.diffCommand !== `git diff ${base}...${targetSnapshot.targetHead}` ||
      typeof readRange.diffSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(readRange.diffSha256) ||
      readRange.diffSha256 === sha256Hex("") ||
      !Array.isArray(readRange.commits) ||
      !readRange.commits.every((commit) => typeof commit === "string") ||
      !hasUniqueValues(readRange.commits)
    ) {
      violation("range-invalid");
    }
    const range: ReviewerRange = Object.freeze({
      base,
      target: readRange.target,
      diffCommand: readRange.diffCommand,
      diffSha256: readRange.diffSha256,
      commits: freezeStrings(readRange.commits),
    });
    if (!capabilities.tools.includes("bash") || !capabilities.bashCommands.includes(range.diffCommand)) {
      violation("capability-invalid");
    }
    for (const grant of [standardsGrant, ...(specGrant === undefined ? [] : [specGrant])]) {
      if (
        !grant.tools.includes("bash") ||
        !grant.bashCommands.includes(range.diffCommand) ||
        grant.bashCommands.some((command) => !capabilities.bashCommands.includes(command))
      ) {
        violation("capability-invalid");
      }
    }
    const materialEvidence = new Map<string, ReviewerMaterialEvidence>();
    const renderMaterials = async (items: readonly MaterialSelection[]): Promise<string> => {
      const rendered: string[] = [];
      for (const item of items) {
        let bytes!: Uint8Array;
        try { bytes = await dependencies.reader.material(item.repositoryPath, targetSnapshot.targetHead); }
        catch (error) { classifyReadFailure(error); }
        let text!: string;
        try { text = exactUtf8(bytes, "Reviewer material"); }
        catch { violation("material-invalid"); }
        materialEvidence.set(item.id, Object.freeze({
          ...item,
          text: text,
          utf8Length: bytes.byteLength,
          sha256: sha256Hex(bytes),
        }));
        rendered.push(`Material-Identity: ${JSON.stringify({ id: item.id, repositoryPath: item.repositoryPath })}\nMaterial-Bytes:\n${text}`);
      }
      return rendered.join("\n\n");
    };

    let taskText!: string;
    try { taskText = exactUtf8(task, "Reviewer task"); }
    catch { violation("prompt-identity-invalid"); }
    const taskEvidence: ReviewerPromptIdentity = reviewerPromptIdentity(taskText);
    const common = [
      `Task-SHA256: ${taskEvidence.sha256}`,
      `Task-UTF8-Length: ${taskEvidence.utf8Length}`,
      `Target: ${range.target}`,
      `Base: ${range.base}`,
      `Diff: ${range.diffCommand}`,
      `Diff-SHA256: ${range.diffSha256}`,
      "Commits:",
      range.commits.join("\n"),
    ].join("\n");
    const baseline = skillSection(canonicalSkill, "### 3. Identify the standards sources", "### 4. Spawn both sub-agents in parallel");
    const standardsBurden = skillSection(canonicalSkill, "**Standards sub-agent prompt**", "**Spec sub-agent prompt**");
    const standardsPrompt = `${common}\n\nStandards materials:\n${await renderMaterials(proposal.standardsMaterials)}\n\n${baseline}\n\n${standardsBurden}\n`;
    const promptInputs: Array<Readonly<{ axis: "standards" | "spec"; prompt: string; grant: ReviewerCapabilityRequest }>> = [
      { axis: "standards", prompt: standardsPrompt, grant: standardsGrant },
    ];
    if (axisPlan.kind === "two-leg") {
      const specBurden = skillSection(canonicalSkill, "**Spec sub-agent prompt**", "### 5. Aggregate");
      const specPrompt = `${common}\n\nSpec materials:\n${await renderMaterials(axisPlan.selections)}\n\n${specBurden}\n`;
      promptInputs.push({ axis: "spec", prompt: specPrompt, grant: specGrant! });
    } else {
      await renderMaterials(axisPlan.selections);
    }
    const compilePrompt = dependencies.compilePrompt ?? ((prompt: string) => reviewerPromptIdentity(prompt));
    const firstCompilations = promptInputs.map(({ axis, prompt }) => compilePrompt(prompt, axis, 1));
    const secondCompilations = promptInputs.map(({ axis, prompt }) => compilePrompt(prompt, axis, 2));
    for (let index = 0; index < firstCompilations.length; index++) {
      const first = firstCompilations[index]!;
      const second = secondCompilations[index]!;
      if (!isReviewerPromptIdentity(first) || !isReviewerPromptIdentity(second)) {
        violation("prompt-identity-invalid");
      }
      if (!sameReviewerPromptIdentity(first, second)) {
        violation("prompt-identity-mismatch");
      }
    }
    const legs = Object.freeze(promptInputs.map(({ axis, grant }, index) => {
      const identity = firstCompilations[index]!;
      return Object.freeze({ axis, prompt: identity, grant });
    }));
    const evidenceFor = (items: readonly MaterialSelection[]) => Object.freeze(items.map((item) => materialEvidence.get(item.id)!));
    const materials = Object.freeze({
      standards: evidenceFor(proposal.standardsMaterials),
      ...(axisPlan.kind === "two-leg"
        ? { spec: evidenceFor(axisPlan.selections) }
        : { noSpecEvidence: evidenceFor(axisPlan.selections) }),
    });
    return Object.freeze({
      identity,
      recipe: "reviewer-dispatch-v1",
      input: Object.freeze({
        task: taskEvidence,
        canonicalSkillSha256: sha256Hex(canonicalSkill),
        capabilityDocument: capabilities.document,
      }),
      targetSnapshot,
      prerequisiteOperations: acceptedPrerequisites,
      range,
      materials,
      legs,
    });
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
      if (accepted || accepting) return close(identity);
      let dispatch: AcceptedReviewerDispatch;
      try {
        dispatch = await preflightAndCompileDispatch(proposal, identity);
      } catch (error) {
        // Compilation awaits repository I/O; another proposal may accept meanwhile.
        if (accepted || accepting) return close(identity);
        return reject(identity, error);
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
        return reject(identity, error instanceof ReviewerPreflightError ? error : new ReviewerPreflightError("preflight-infrastructure"));
      }
      if (accepted || accepting) return close(identity);
      accepting = true;
      accepted = Object.freeze({
        identity,
        recipe: "reviewer-dispatch-v1",
        cardinality: dispatch.legs.length as 1 | 2,
      });
      const results = await dependencies.run(dispatch, invocation);
      return Object.freeze({ status: "accepted", dispatch, results });
    },
  });
}
