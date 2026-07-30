import { createHash } from "node:crypto";

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
  Readonly<{ version: 1; taskSha256: string }>;
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
export type ReviewerPinnedTarget = Readonly<{
  repositoryRoot: string;
  targetHead: string;
  refs: Readonly<Record<string, string>>;
}>;
export type ReviewerRange = Readonly<{
  base: string;
  target: string;
  diffCommand: string;
  commits: readonly string[];
}>;
export type ReviewerPinnedGitReader = {
  pin: ReviewerPinnedTarget;
  resolve(base: string): Promise<string>;
  range(base: string): Promise<ReviewerRange>;
  material(path: string, revision: string): Promise<Uint8Array>;
};
export type AcceptedReviewerLeg = Readonly<{
  axis: "standards" | "spec";
  prompt: string;
  utf8Length: number;
  sha256: string;
  grant: ReviewerCapabilityRequest;
}>;
export type AcceptedReviewerDispatch = Readonly<{
  identity: string;
  recipe: "reviewer-dispatch-v1";
  targetSnapshot: ReviewerPinnedTarget;
  range: ReviewerRange;
  legs: readonly AcceptedReviewerLeg[];
}>;
export type ReviewerRejectionEvidence = Readonly<{
  identity: string;
  violations: readonly string[];
  started: false;
}>;
export type ReviewerAcceptanceEvidence = Readonly<{
  identity: string;
  recipe: "reviewer-dispatch-v1";
  cardinality: 1 | 2;
}>;
export type ReviewerDispatchResult =
  | Readonly<{ status: "rejected"; identity: string; violations: readonly string[] }>
  | Readonly<{ status: "accepted"; dispatch: AcceptedReviewerDispatch; results: unknown }>
  | Readonly<{ status: "closed" }>;

type DispatcherDependencies = Readonly<{
  task: Uint8Array;
  canonicalSkill: string;
  capabilities: ReviewerCapabilitiesV1;
  reader: ReviewerPinnedGitReader;
  hostTools: readonly string[];
  run(dispatch: AcceptedReviewerDispatch): Promise<unknown>;
}>;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

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
  try {
    value = JSON.parse(utf8Decoder.decode(raw));
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
  if (!/^[0-9a-f]{64}$/.test(taskSha256) || taskSha256 !== sha256(task)) {
    throw new Error("Reviewer capabilities task digest mismatch");
  }
  if (
    !tools.every(
      (item): item is ReviewerChildToolName =>
        typeof item === "string" && (REVIEWER_CHILD_TOOLS as readonly string[]).includes(item),
    ) ||
    !bashCommands.every((item): item is string => typeof item === "string") ||
    !prerequisiteOperations.every(
      (item): item is ReviewerPrerequisiteOperation =>
        typeof item === "string" && (REVIEWER_PREREQUISITES as readonly string[]).includes(item),
    ) ||
    !hasUniqueValues(tools) ||
    !hasUniqueValues(bashCommands) ||
    !hasUniqueValues(prerequisiteOperations)
  ) {
    throw new Error("Reviewer capabilities contain unknown or duplicate values");
  }
  if (bashCommands.length > 0 && !tools.includes("bash")) {
    throw new Error("Reviewer bash commands require bash tool");
  }

  return Object.freeze({
    version: 1,
    taskSha256,
    ...immutableRequest({ tools, bashCommands, prerequisiteOperations }),
  });
}

function validateRequest(
  value: unknown,
  ceiling: ReviewerCapabilitiesV1,
  hostTools: readonly string[],
): ReviewerCapabilityRequest {
  if (!isExactObject(value, ["tools", "bashCommands", "prerequisiteOperations"])) {
    throw new Error("Invalid capability request");
  }
  const { tools, bashCommands, prerequisiteOperations } = value;
  if (
    !Array.isArray(tools) ||
    !Array.isArray(bashCommands) ||
    !Array.isArray(prerequisiteOperations) ||
    !tools.every((item): item is ReviewerChildToolName =>
      typeof item === "string" && (REVIEWER_CHILD_TOOLS as readonly string[]).includes(item),
    ) ||
    !bashCommands.every((item): item is string => typeof item === "string") ||
    !prerequisiteOperations.every((item): item is ReviewerPrerequisiteOperation =>
      typeof item === "string" && (REVIEWER_PREREQUISITES as readonly string[]).includes(item),
    ) ||
    !hasUniqueValues(tools) ||
    !hasUniqueValues(bashCommands) ||
    !hasUniqueValues(prerequisiteOperations)
  ) {
    throw new Error("Invalid capability request values");
  }
  if (
    tools.some((tool) => !ceiling.tools.includes(tool) || !hostTools.includes(tool)) ||
    bashCommands.some((command) => !ceiling.bashCommands.includes(command)) ||
    prerequisiteOperations.some((operation) => !ceiling.prerequisiteOperations.includes(operation))
  ) {
    throw new Error("Capability requirement exceeds ceiling or host availability");
  }
  if (bashCommands.length > 0 && !tools.includes("bash")) {
    throw new Error("Reviewer bash commands require bash tool");
  }
  return immutableRequest({ tools, bashCommands, prerequisiteOperations });
}

function validateMaterialSelection(value: unknown): asserts value is MaterialSelection {
  if (
    !isExactObject(value, ["id", "repositoryPath"]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.repositoryPath !== "string" ||
    value.repositoryPath.length === 0
  ) {
    throw new Error("Invalid material selection");
  }
}

function skillSection(skill: string, heading: string, nextHeading: string): string {
  const start = skill.indexOf(heading);
  if (start < 0) throw new Error(`Canonical Skill lacks ${heading}`);
  const end = skill.indexOf(nextHeading, start + heading.length);
  if (end < 0 || end <= start) throw new Error(`Canonical Skill lacks ${nextHeading}`);
  return skill.slice(start, end).trim();
}

function terminalSkillSection(skill: string, heading: string): string {
  const start = skill.indexOf(heading);
  if (start < 0) throw new Error(`Canonical Skill lacks ${heading}`);
  const next = skill.indexOf("\n## ", start + heading.length);
  return skill.slice(start, next < 0 ? skill.length : next).trim();
}

function immutablePin(pin: ReviewerPinnedTarget): ReviewerPinnedTarget {
  return Object.freeze({
    repositoryRoot: pin.repositoryRoot,
    targetHead: pin.targetHead,
    refs: Object.freeze({ ...pin.refs }),
  });
}

function proposalIdentity(proposal: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(proposal);
  } catch {
    encoded = "[unserializable proposal]";
  }
  return sha256(encoded);
}

export function createReviewerDispatcher(dependencies: DispatcherDependencies) {
  const task = Uint8Array.from(dependencies.task);
  const canonicalSkill = dependencies.canonicalSkill;
  const capabilities = dependencies.capabilities;
  const targetSnapshot = immutablePin(dependencies.reader.pin);
  const hostTools = freezeStrings(dependencies.hostTools);
  let accepted: ReviewerAcceptanceEvidence | undefined;
  let accepting = false;
  const rejections: ReviewerRejectionEvidence[] = [];

  async function compile(proposal: ReviewerProposalV1, identity: string): Promise<AcceptedReviewerDispatch> {
    if (!isExactObject(proposal, ["version", "base", "standardsMaterials", "spec", "required"]) || proposal.version !== 1) {
      throw new Error("Invalid Reviewer proposal");
    }
    if (!isExactObject(proposal.base, ["revision"]) || typeof proposal.base.revision !== "string" || proposal.base.revision.length === 0) {
      throw new Error("Invalid base revision");
    }
    if (!Array.isArray(proposal.standardsMaterials) || proposal.standardsMaterials.length === 0) {
      throw new Error("Standards materials are required");
    }
    proposal.standardsMaterials.forEach(validateMaterialSelection);
    if (!isExactObject(proposal.required, proposal.spec?.state === "established" ? ["standards", "spec"] : ["standards"])) {
      throw new Error("Capability requirements contradict Spec state");
    }

    if (!isExactObject(proposal.spec, ["state", proposal.spec?.state === "established" ? "materials" : "evidence"])) {
      throw new Error("Invalid Spec state");
    }
    const specSelections = proposal.spec.state === "established" ? proposal.spec.materials : proposal.spec.evidence;
    if (!Array.isArray(specSelections) || specSelections.length === 0) throw new Error("Spec state evidence is required");
    specSelections.forEach(validateMaterialSelection);

    const identities = [...proposal.standardsMaterials, ...specSelections].map(({ id }) => id);
    if (!hasUniqueValues(identities)) throw new Error("Duplicate or cross-axis material identity");
    for (const operation of DISPATCH_PREREQUISITES) {
      if (!capabilities.prerequisiteOperations.includes(operation)) {
        throw new Error(`Missing preflight prerequisite: ${operation}`);
      }
    }

    const standardsGrant = validateRequest(proposal.required.standards, capabilities, hostTools);
    const specGrant = proposal.spec.state === "established"
      ? validateRequest(proposal.required.spec, capabilities, hostTools)
      : undefined;

    const base = await dependencies.reader.resolve(proposal.base.revision);
    const readRange = await dependencies.reader.range(base);
    if (readRange.base !== base || readRange.target !== targetSnapshot.targetHead) {
      throw new Error("Range is inconsistent with immutable target pin");
    }
    if (
      typeof readRange.diffCommand !== "string" ||
      !Array.isArray(readRange.commits) ||
      !readRange.commits.every((commit) => typeof commit === "string") ||
      !hasUniqueValues(readRange.commits)
    ) {
      throw new Error("Invalid canonical range evidence");
    }
    const range: ReviewerRange = Object.freeze({
      base,
      target: readRange.target,
      diffCommand: readRange.diffCommand,
      commits: freezeStrings(readRange.commits),
    });

    const renderMaterials = async (items: readonly MaterialSelection[]): Promise<string> => {
      const rendered: string[] = [];
      for (const item of items) {
        const bytes = await dependencies.reader.material(item.repositoryPath, targetSnapshot.targetHead);
        let text: string;
        try {
          text = utf8Decoder.decode(bytes);
        } catch {
          throw new Error(`Material is not valid UTF-8: ${item.id}`);
        }
        rendered.push(`${item.id} (${item.repositoryPath}):\n${text}`);
      }
      return rendered.join("\n\n");
    };

    const common = [
      `Task-SHA256: ${sha256(task)}`,
      "Task bytes:",
      utf8Decoder.decode(task),
      `Target: ${range.target}`,
      `Base: ${range.base}`,
      `Diff: ${range.diffCommand}`,
      "Commits:",
      range.commits.join("\n"),
    ].join("\n");
    const baseline = skillSection(canonicalSkill, "## Standards baseline", "## Standards review burden");
    const standardsBurden = skillSection(canonicalSkill, "## Standards review burden", "## Spec review burden");
    const standardsPrompt = `${common}\n\nStandards materials:\n${await renderMaterials(proposal.standardsMaterials)}\n\n${baseline}\n\n${standardsBurden}\n`;
    const promptInputs: Array<Readonly<{ axis: "standards" | "spec"; prompt: string; grant: ReviewerCapabilityRequest }>> = [
      { axis: "standards", prompt: standardsPrompt, grant: standardsGrant },
    ];
    if (proposal.spec.state === "established") {
      const specPrompt = `${common}\n\nSpec materials:\n${await renderMaterials(proposal.spec.materials)}\n\n${terminalSkillSection(canonicalSkill, "## Spec review burden")}\n`;
      promptInputs.push({ axis: "spec", prompt: specPrompt, grant: specGrant! });
    }
    const legs = Object.freeze(promptInputs.map(({ axis, prompt, grant }) => Object.freeze({
      axis,
      prompt,
      utf8Length: Buffer.byteLength(prompt, "utf8"),
      sha256: sha256(prompt),
      grant,
    })));
    return Object.freeze({ identity, recipe: "reviewer-dispatch-v1", targetSnapshot, range, legs });
  }

  return Object.freeze({
    get rejections(): readonly ReviewerRejectionEvidence[] {
      return Object.freeze([...rejections]);
    },
    get acceptance(): ReviewerAcceptanceEvidence | undefined {
      return accepted;
    },
    async propose(proposal: ReviewerProposalV1): Promise<ReviewerDispatchResult> {
      if (accepted || accepting) return Object.freeze({ status: "closed" });
      const identity = proposalIdentity(proposal);
      let dispatch: AcceptedReviewerDispatch;
      try {
        dispatch = await compile(proposal, identity);
      } catch (error) {
        const violations = Object.freeze([error instanceof Error ? error.message : String(error)]);
        const evidence = Object.freeze({ identity, violations, started: false as const });
        rejections.push(evidence);
        return Object.freeze({ status: "rejected", identity, violations });
      }

      // Another async proposal may have completed preflight while this one awaited pin reads.
      if (accepted || accepting) return Object.freeze({ status: "closed" });
      accepting = true;
      accepted = Object.freeze({
        identity,
        recipe: "reviewer-dispatch-v1",
        cardinality: dispatch.legs.length as 1 | 2,
      });
      const results = await dependencies.run(dispatch);
      return Object.freeze({ status: "accepted", dispatch, results });
    },
  });
}
