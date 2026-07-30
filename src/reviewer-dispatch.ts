import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { exactUtf8 } from "./exact-utf8.ts";
import { immutableReviewerRefs, parseReviewerRefSnapshot, reviewerRefSnapshotArgs, sameReviewerRefs, type ReviewerRefMap } from "./reviewer-git-snapshot.ts";
import { reviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
export { isReviewerPromptIdentity, reviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

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
  refs: ReviewerRefMap;
}>;
export type ReviewerRange = Readonly<{
  base: string;
  target: string;
  diffCommand: string;
  diffSha256: string;
  commits: readonly string[];
}>;
export type ReviewerPinnedGitReader = {
  pin: ReviewerPinnedTarget;
  snapshot(): Promise<ReviewerPinnedTarget>;
  resolve(base: string): Promise<string>;
  range(base: string): Promise<ReviewerRange>;
  material(path: string, revision: string): Promise<Uint8Array>;
};
export type AcceptedReviewerLeg = Omit<ReviewerPromptIdentity, "bytes"> & Readonly<{
  axis: "standards" | "spec";
  prompt: ReviewerPromptIdentity["bytes"];
  grant: ReviewerCapabilityRequest;
}>;
export type AcceptedReviewerDispatch = Readonly<{
  identity: string;
  recipe: "reviewer-dispatch-v1";
  input: Readonly<{
    task: ReviewerPromptIdentity;
    canonicalSkillSha256: string;
  }>;
  targetSnapshot: ReviewerPinnedTarget;
  range: ReviewerRange;
  materials: Readonly<{
    standards: readonly ReviewerMaterialEvidence[];
    spec?: readonly ReviewerMaterialEvidence[];
    noSpecEvidence?: readonly ReviewerMaterialEvidence[];
  }>;
  legs: readonly AcceptedReviewerLeg[];
}>;
export type ReviewerMaterialEvidence = Readonly<MaterialSelection & ReviewerPromptIdentity>;
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
export type ReviewerClosedAttemptEvidence = Readonly<{
  identity: string;
  reason: "acceptance-closed";
  started: false;
}>;
export type ReviewerDispatchResult =
  | Readonly<{ status: "rejected"; identity: string; violations: readonly string[] }>
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

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

function validateCapabilityRequestShape(value: unknown): ReviewerCapabilityRequest {
  if (!isExactObject(value, ["tools", "bashCommands", "prerequisiteOperations"]))
    throw new Error("Invalid capability request");
  const { tools, bashCommands, prerequisiteOperations } = value;
  if (!Array.isArray(tools) || !Array.isArray(bashCommands) || !Array.isArray(prerequisiteOperations) ||
      !tools.every((item): item is ReviewerChildToolName => typeof item === "string" && (REVIEWER_CHILD_TOOLS as readonly string[]).includes(item)) ||
      !bashCommands.every((item): item is string => typeof item === "string") ||
      !prerequisiteOperations.every((item): item is ReviewerPrerequisiteOperation => typeof item === "string" && (REVIEWER_PREREQUISITES as readonly string[]).includes(item)) ||
      !hasUniqueValues(tools) || !hasUniqueValues(bashCommands) || !hasUniqueValues(prerequisiteOperations))
    throw new Error("Invalid capability request values");
  if (bashCommands.length > 0 && !tools.includes("bash"))
    throw new Error("Reviewer bash commands require bash tool");
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
  let request: ReviewerCapabilityRequest;
  try { request = validateCapabilityRequestShape({ tools, bashCommands, prerequisiteOperations }); }
  catch { throw new Error("Reviewer capabilities contain unknown or duplicate values"); }
  return Object.freeze({ version: 1, taskSha256, ...immutableRequest(request) });
}

function validateRequest(
  value: unknown,
  ceiling: ReviewerCapabilitiesV1,
  hostTools: readonly string[],
): ReviewerCapabilityRequest {
  const { tools, bashCommands, prerequisiteOperations } = validateCapabilityRequestShape(value);
  if (
    tools.some((tool) => !ceiling.tools.includes(tool) || !hostTools.includes(tool)) ||
    bashCommands.some((command) => !ceiling.bashCommands.includes(command)) ||
    prerequisiteOperations.some((operation) => !ceiling.prerequisiteOperations.includes(operation))
  ) {
    throw new Error("Capability requirement exceeds ceiling or host availability");
  }
  return immutableRequest({ tools, bashCommands, prerequisiteOperations });
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateMaterialSelection(
  value: unknown,
  axis: "standards" | "spec" | "no-spec evidence",
  index: number,
): asserts value is MaterialSelection {
  const location = `${axis} material selection at index ${index}`;
  if (!isExactObject(value, ["id", "repositoryPath"]) ||
      typeof value.id !== "string" || !SAFE_ID.test(value.id)) {
    throw new Error(`Invalid ${location}: identity`);
  }
  const safeId = ` (id: ${value.id})`;
  if (typeof value.repositoryPath !== "string" || value.repositoryPath.length === 0 ||
      value.repositoryPath.startsWith("/") || value.repositoryPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(value.repositoryPath) ||
      value.repositoryPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid ${location}${safeId}: repository-relative path`);
  }
}

function skillSection(skill: string, heading: string, nextHeading: string): string {
  const start = skill.indexOf(heading);
  if (start < 0) throw new Error(`Canonical Skill lacks ${heading}`);
  const end = skill.indexOf(nextHeading, start + heading.length);
  if (end < 0 || end <= start) throw new Error(`Canonical Skill lacks ${nextHeading}`);
  return skill.slice(start, end).trim();
}

function immutablePin(pin: ReviewerPinnedTarget): ReviewerPinnedTarget {
  return Object.freeze({
    repositoryRoot: pin.repositoryRoot,
    targetHead: pin.targetHead,
    refs: immutableReviewerRefs(pin.refs),
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

const execFileAsync = promisify(execFile);

async function gitText(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

/** Pins HEAD and refs before the parent can submit a proposal. */
export async function createReviewerPinnedGitReader(root = process.cwd()): Promise<ReviewerPinnedGitReader> {
  const repositoryRoot = await realpath(root);
  const targetHead = await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
  const rawRefs = await gitText(repositoryRoot, reviewerRefSnapshotArgs());
  const refs = parseReviewerRefSnapshot(rawRefs);
  const pin = Object.freeze({ repositoryRoot, targetHead, refs: immutableReviewerRefs(refs) });
  const symbolic = (base: string): string | undefined => {
    const selected = Object.hasOwn(refs, base)
      ? base
      : (() => {
        const candidates = [`refs/heads/${base}`, `refs/tags/${base}`, `refs/remotes/${base}`]
          .filter((name) => Object.hasOwn(refs, name));
        if (candidates.length > 1) throw new Error("Base revision alias is ambiguous in the pinned ref map");
        return candidates[0];
      })();
    if (selected === undefined) return undefined;
    const commit = refs[selected]?.peeledCommitId;
    if (commit === null) throw new Error("Base revision does not identify a commit");
    return commit;
  };
  return Object.freeze({
    pin,
    async snapshot() {
      const currentHead = await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
      const currentRefs = parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs()));
      return immutablePin({ repositoryRoot, targetHead: currentHead, refs: currentRefs });
    },
    async resolve(base: string) {
      if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) || base.startsWith("-") || base.includes("..") || base.includes("@{"))
        throw new Error("Unsafe base revision grammar");
      let commit: string | undefined;
      const headExpression = /^HEAD((?:~[0-9]+|\^[0-9]+)*)$/.exec(base);
      if (headExpression) commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${targetHead}${headExpression[1]}^{commit}`]);
      else if (/^[0-9a-f]{4,40}$/.test(base)) {
        const matches = (await gitText(repositoryRoot, ["rev-parse", `--disambiguate=${base}`])).split("\n").filter(Boolean);
        if (matches.length !== 1) throw new Error("Base commit abbreviation is unknown or ambiguous");
        commit = matches[0];
      } else commit = symbolic(base);
      if (commit === undefined) throw new Error("Base revision is not present in the pinned ref map");
      try { commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]); }
      catch { throw new Error("Base revision does not identify a commit"); }
      try { await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]); }
      catch { throw new Error("Base commit is not reachable from the pinned target"); }
      return commit;
    },
    async range(base: string) {
      const mergeBase = await gitText(repositoryRoot, ["merge-base", base, targetHead]);
      if (!mergeBase) throw new Error("Unable to derive merge-base for pinned range");
      const diffCommand = `git diff ${mergeBase}...${targetHead}`;
      const [{ stdout: diff }, commitsText] = await Promise.all([
        execFileAsync("git", ["-C", repositoryRoot, "diff", `${mergeBase}...${targetHead}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }),
        gitText(repositoryRoot, ["rev-list", "--reverse", `${mergeBase}..${targetHead}`]),
      ]);
      if (diff.length === 0) throw new Error("Pinned three-dot diff is empty");
      return Object.freeze({ base: mergeBase, target: targetHead, diffCommand, diffSha256: sha256(Uint8Array.from(diff)), commits: Object.freeze(commitsText ? commitsText.split("\n") : []) });
    },
    async material(path: string, revision: string) {
      if (revision !== targetHead) throw new Error("Material revision is not the pinned target");
      const { stdout } = await execFileAsync("git", ["-C", repositoryRoot, "show", `${revision}:${path}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
      return Uint8Array.from(stdout);
    },
  });
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
  const closedAttempts: ReviewerClosedAttemptEvidence[] = [];

  function close(identity: string): ReviewerDispatchResult {
    const evidence = Object.freeze({ identity, reason: "acceptance-closed" as const, started: false as const });
    closedAttempts.push(evidence);
    return Object.freeze({ status: "closed" as const, ...evidence });
  }

  function reject(identity: string, error: unknown): ReviewerDispatchResult {
    const violations = Object.freeze([
      error instanceof Error ? error.message : String(error),
    ]);
    rejections.push(Object.freeze({ identity, violations, started: false as const }));
    return Object.freeze({ status: "rejected" as const, identity, violations });
  }

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
    proposal.standardsMaterials.forEach((selection, index) =>
      validateMaterialSelection(selection, "standards", index));
    if (!isExactObject(proposal.required, proposal.spec?.state === "established" ? ["standards", "spec"] : ["standards"])) {
      throw new Error("Capability requirements contradict Spec state");
    }

    if (!isExactObject(proposal.spec, ["state", proposal.spec?.state === "established" ? "materials" : "evidence"])) {
      throw new Error("Invalid Spec state");
    }
    const specSelections = proposal.spec.state === "established" ? proposal.spec.materials : proposal.spec.evidence;
    if (!Array.isArray(specSelections) || specSelections.length === 0) throw new Error("Spec state evidence is required");
    specSelections.forEach((selection, index) =>
      validateMaterialSelection(selection, proposal.spec.state === "established" ? "spec" : "no-spec evidence", index));

    const allSelections = [...proposal.standardsMaterials, ...specSelections];
    if (!hasUniqueValues(allSelections.map(({ id }) => id)) ||
        !hasUniqueValues(allSelections.map(({ repositoryPath }) => repositoryPath.normalize("NFC"))))
      throw new Error("Duplicate or cross-axis material identity or repository path");
    for (const operation of DISPATCH_PREREQUISITES) {
      if (!capabilities.prerequisiteOperations.includes(operation)) {
        throw new Error(`Missing preflight prerequisite: ${operation}`);
      }
    }

    const standardsGrant = validateRequest(proposal.required.standards, capabilities, hostTools);
    const specGrant = proposal.spec.state === "established"
      ? validateRequest(proposal.required.spec, capabilities, hostTools)
      : undefined;
    const runnerOperations = REVIEWER_PREREQUISITES.filter((operation) => operation.startsWith("runner."));
    for (const operation of runnerOperations) {
      if (!capabilities.prerequisiteOperations.includes(operation) ||
          !standardsGrant.prerequisiteOperations.includes(operation) ||
          (specGrant !== undefined && !specGrant.prerequisiteOperations.includes(operation))) {
        throw new Error(`Missing accepted runner prerequisite: ${operation}`);
      }
    }

    const base = await dependencies.reader.resolve(proposal.base.revision);
    const readRange = await dependencies.reader.range(base);
    if (readRange.base !== base || readRange.target !== targetSnapshot.targetHead) {
      throw new Error("Range is inconsistent with immutable target pin");
    }
    if (
      readRange.diffCommand !== `git diff ${base}...${targetSnapshot.targetHead}` ||
      typeof readRange.diffSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(readRange.diffSha256) ||
      readRange.diffSha256 === sha256("") ||
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
      diffSha256: readRange.diffSha256,
      commits: freezeStrings(readRange.commits),
    });
    const materialEvidence = new Map<string, ReviewerMaterialEvidence>();
    const renderMaterials = async (items: readonly MaterialSelection[]): Promise<string> => {
      const rendered: string[] = [];
      for (const item of items) {
        const bytes = await dependencies.reader.material(item.repositoryPath, targetSnapshot.targetHead);
        const text = exactUtf8(bytes, `Material ${item.id}`);
        materialEvidence.set(item.id, Object.freeze({
          ...item,
          bytes: text,
          utf8Length: bytes.byteLength,
          sha256: sha256(bytes),
        }));
        rendered.push(`Material-Identity: ${JSON.stringify({ id: item.id, repositoryPath: item.repositoryPath })}\nMaterial-Bytes:\n${text}`);
      }
      return rendered.join("\n\n");
    };

    const taskText = exactUtf8(task, "Reviewer task");
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
    if (proposal.spec.state === "established") {
      const specBurden = skillSection(canonicalSkill, "**Spec sub-agent prompt**", "### 5. Aggregate");
      const specPrompt = `${common}\n\nSpec materials:\n${await renderMaterials(proposal.spec.materials)}\n\n${specBurden}\n`;
      promptInputs.push({ axis: "spec", prompt: specPrompt, grant: specGrant! });
    } else {
      await renderMaterials(proposal.spec.evidence);
    }
    const compilePrompt = dependencies.compilePrompt ?? ((prompt: string) => reviewerPromptIdentity(prompt));
    const firstCompilations = promptInputs.map(({ axis, prompt }) => compilePrompt(prompt, axis, 1));
    const secondCompilations = promptInputs.map(({ axis, prompt }) => compilePrompt(prompt, axis, 2));
    for (let index = 0; index < firstCompilations.length; index++) {
      const first = firstCompilations[index]!;
      const second = secondCompilations[index]!;
      if (first.bytes !== second.bytes) {
        throw new Error(`Reviewer ${promptInputs[index]!.axis} prompt recompilation mismatch (first ${first.utf8Length}/${first.sha256}, second ${second.utf8Length}/${second.sha256})`);
      }
    }
    const legs = Object.freeze(promptInputs.map(({ axis, grant }, index) => {
      const identity = firstCompilations[index]!;
      return Object.freeze({ axis, prompt: identity.bytes, utf8Length: identity.utf8Length, sha256: identity.sha256, grant });
    }));
    const evidenceFor = (items: readonly MaterialSelection[]) => Object.freeze(items.map((item) => materialEvidence.get(item.id)!));
    const materials = Object.freeze({
      standards: evidenceFor(proposal.standardsMaterials),
      ...(proposal.spec.state === "established"
        ? { spec: evidenceFor(proposal.spec.materials) }
        : { noSpecEvidence: evidenceFor(proposal.spec.evidence) }),
    });
    return Object.freeze({
      identity,
      recipe: "reviewer-dispatch-v1",
      input: Object.freeze({ task: taskEvidence, canonicalSkillSha256: sha256(canonicalSkill) }),
      targetSnapshot,
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
        dispatch = await compile(proposal, identity);
      } catch (error) {
        // Compilation awaits repository I/O; another proposal may accept meanwhile.
        if (accepted || accepting) return close(identity);
        return reject(identity, error);
      }

      // Another async proposal may have completed preflight while this one awaited pin reads.
      if (accepted || accepting) return close(identity);
      try {
        const live = await dependencies.reader.snapshot();
        if (live.repositoryRoot !== targetSnapshot.repositoryRoot || live.targetHead !== targetSnapshot.targetHead ||
            !sameReviewerRefs(live.refs, targetSnapshot.refs)) {
          throw new Error("preflight.git.pin-target detected repository HEAD/ref drift");
        }
      } catch (error) {
        if (accepted || accepting) return close(identity);
        return reject(identity, error);
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
