import {
  isReviewerPromptIdentity,
  type ReviewerPromptIdentity,
  type ReviewerCapabilityRequest,
  type ReviewerMaterialEvidence,
  type ReviewerPinnedTarget,
  type ReviewerRange,
} from "./reviewer-dispatch.ts";

export type ReviewerUsage = Readonly<{
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number; reasoning?: number; totalTokens: number;
  cost: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; total: number }>;
}>;
export type ReviewerTargetSnapshot = ReviewerPinnedTarget;
export type ReviewerWorkspaceDisposition = "deleted" | Readonly<{ retained: string }>;

export type ReviewerCompiledLegEvidence = Readonly<{
  axis: "standards" | "spec";
  prompt: string;
  utf8Length: number;
  sha256: string;
  grant: ReviewerCapabilityRequest;
}>;
export type ReviewerAcceptedEvidence = Readonly<{
  identity: string;
  recipe: "reviewer-dispatch-v1";
  input: Readonly<{
    task: Readonly<{ bytes: string; utf8Length: number; sha256: string }>;
    canonicalSkillSha256: string;
  }>;
  target: ReviewerPinnedTarget;
  range: ReviewerRange;
  materials: Readonly<{
    standards: readonly ReviewerMaterialEvidence[];
    spec?: readonly ReviewerMaterialEvidence[];
    noSpecEvidence?: readonly ReviewerMaterialEvidence[];
  }>;
  legs: readonly ReviewerCompiledLegEvidence[];
}>;
export type ReviewerLegResultEvidence = Readonly<{
  dispatchIdentity: string;
  axis: "standards" | "spec";
  status: "successful" | "failed";
  prompt: ReviewerPromptIdentity;
  target: ReviewerPinnedTarget;
  report?: string;
  diagnostics?: string;
  usage?: ReviewerUsage;
  workspaceDisposition: ReviewerWorkspaceDisposition;
}>;
export type ReviewerEvidenceEvent =
  | (Readonly<{ source: "reviewer-dispatch"; type: "rejected"; identity: string; violations: readonly string[]; started: false }>)
  | (Readonly<{ source: "reviewer-dispatch"; type: "accepted" }> & ReviewerAcceptedEvidence)
  | Readonly<{ source: "reviewer-agent"; type: "dispatch-started"; dispatchIdentity: string; cardinality: 1 | 2 }>
  | (Readonly<{ source: "reviewer-agent"; type: "leg-settled" }> & ReviewerLegResultEvidence)
  | Readonly<{ source: "reviewer-runtime"; type: "fatal"; diagnostics: string; targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition }>;

export type ReviewerExecutionRecord = Readonly<{
  rejections: readonly Readonly<{ identity: string; violations: readonly string[]; started: false }>[];
  accepted?: ReviewerAcceptedEvidence;
  started?: Readonly<{ dispatchIdentity: string; cardinality: 1 | 2 }>;
  results: Readonly<Partial<Record<"standards" | "spec", ReviewerLegResultEvidence>>>;
}>;
export type ReviewerExecutionLedger = Readonly<{
  append(event: ReviewerEvidenceEvent): void;
  recordInfrastructureFailure<T>(error: T): T;
  recordForAudit(status: "completed" | "refused"): ReviewerExecutionRecord;
}>;

type FatalEvidence = { diagnostics: string; targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition };

function cloneFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFreeze)) as T;
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneFreeze(item);
    return Object.freeze(copy) as T;
  }
  return value;
}
function sameTarget(a: ReviewerPinnedTarget, b: ReviewerPinnedTarget): boolean {
  return a.repositoryRoot === b.repositoryRoot && a.targetHead === b.targetHead &&
    JSON.stringify(Object.entries(a.refs).sort()) === JSON.stringify(Object.entries(b.refs).sort());
}
function fatal(error: unknown): FatalEvidence {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  return cloneFreeze({
    diagnostics: error instanceof Error ? error.message : String(error),
    ...(record?.targetSnapshot === undefined ? {} : { targetSnapshot: record.targetSnapshot as ReviewerTargetSnapshot }),
    ...(record?.workspaceDisposition === undefined ? {} : { workspaceDisposition: record.workspaceDisposition as ReviewerWorkspaceDisposition }),
  });
}

export function createReviewerExecutionLedger(): ReviewerExecutionLedger {
  const rejections: Array<{ identity: string; violations: readonly string[]; started: false }> = [];
  let accepted: ReviewerAcceptedEvidence | undefined;
  let started: { dispatchIdentity: string; cardinality: 1 | 2 } | undefined;
  const results: Partial<Record<"standards" | "spec", ReviewerLegResultEvidence>> = {};
  let infrastructureFailure: FatalEvidence | undefined;

  function append(raw: ReviewerEvidenceEvent): void {
    const event = cloneFreeze(raw);
    if (event.source === "reviewer-dispatch" && event.type === "rejected") {
      const allowed = ["source", "type", "identity", "violations", "started"];
      if (Object.keys(event).some((key) => !allowed.includes(key)) || event.started !== false)
        throw new Error("Rejected proposal cannot contain runner, child, usage, workspace, provider, or start evidence");
      if (accepted !== undefined || started !== undefined) throw new Error("Rejection cannot follow an accepted dispatch");
      rejections.push(cloneFreeze({ identity: event.identity, violations: event.violations, started: false }));
      return;
    }
    if (event.source === "reviewer-dispatch" && event.type === "accepted") {
      if (accepted !== undefined) throw new Error("Projection permits exactly one accepted dispatch");
      const axes = event.legs.map((leg) => leg.axis);
      const established = event.materials.spec !== undefined;
      if (event.materials.noSpecEvidence !== undefined === established || axes[0] !== "standards" ||
          (established ? axes.length !== 2 || axes[1] !== "spec" : axes.length !== 1))
        throw new Error("Accepted dispatch Spec state, materials, and sibling axes disagree");
      if (!isReviewerPromptIdentity(event.input.task))
        throw new Error("Accepted task bytes, length, or SHA disagree");
      for (const material of [
        ...event.materials.standards,
        ...(event.materials.spec ?? []),
        ...(event.materials.noSpecEvidence ?? []),
      ]) {
        if (!isReviewerPromptIdentity(material))
          throw new Error("Accepted material bytes, length, or SHA disagree");
      }
      for (const leg of event.legs) {
        if (!isReviewerPromptIdentity({ bytes: leg.prompt, utf8Length: leg.utf8Length, sha256: leg.sha256 }))
          throw new Error("Accepted compiled prompt bytes, length, or SHA disagree");
      }
      accepted = event;
      return;
    }
    if (event.source === "reviewer-runtime" && event.type === "fatal") {
      if (infrastructureFailure === undefined) infrastructureFailure = cloneFreeze({
        diagnostics: event.diagnostics,
        ...(event.targetSnapshot === undefined ? {} : { targetSnapshot: event.targetSnapshot }),
        ...(event.workspaceDisposition === undefined ? {} : { workspaceDisposition: event.workspaceDisposition }),
      });
      return;
    }
    if (event.type === "dispatch-started") {
      if (accepted === undefined || event.dispatchIdentity !== accepted.identity) throw new Error("Start requires its accepted dispatch");
      if (started !== undefined) throw new Error("Accepted dispatch can start exactly once");
      if (event.cardinality !== accepted.legs.length) throw new Error("Dispatch start cardinality disagrees with acceptance");
      started = cloneFreeze({ dispatchIdentity: event.dispatchIdentity, cardinality: event.cardinality });
      return;
    }
    if (accepted === undefined || started === undefined || event.dispatchIdentity !== accepted.identity)
      throw new Error("Runner result requires its irreversible accepted dispatch start");
    if (results[event.axis] !== undefined) throw new Error(`Reviewer ${event.axis} result can settle exactly once`);
    const compiled = accepted.legs.find((leg) => leg.axis === event.axis);
    if (compiled === undefined) throw new Error(`Reviewer ${event.axis} was not an accepted leg`);
    if (event.prompt.bytes !== compiled.prompt || event.prompt.utf8Length !== compiled.utf8Length ||
        event.prompt.sha256 !== compiled.sha256 || !isReviewerPromptIdentity(event.prompt))
      throw new Error("Actual runner prompt does not exactly match compiled prompt bytes, length, and SHA");
    if (!sameTarget(event.target, accepted.target)) throw new Error("Runner target does not match shared pinned target");
    results[event.axis] = event;
  }

  function recordInfrastructureFailure<T>(error: T): T {
    if (infrastructureFailure === undefined) {
      const evidence = fatal(error);
      append({ source: "reviewer-runtime", type: "fatal", ...evidence });
    }
    return error;
  }
  function recordForAudit(status: "completed" | "refused"): ReviewerExecutionRecord {
    if (infrastructureFailure !== undefined) throw Object.assign(new Error(`Reviewer infrastructure previously failed: ${infrastructureFailure.diagnostics}`), { fatalReviewerInfrastructure: true as const });
    if (status === "completed") {
      if (accepted === undefined || started === undefined) throw new Error("Reviewer completed requires exactly one accepted and started dispatch");
      const expected = accepted.legs.map((leg) => leg.axis);
      if (expected.some((axis) => results[axis]?.status !== "successful") || Object.keys(results).length !== expected.length)
        throw new Error(expected.length === 2 ? "Reviewer completed requires both axes settled successfully" : "Reviewer completed requires Standards settled successfully and no Spec evidence");
    }
    return cloneFreeze({ rejections, ...(accepted === undefined ? {} : { accepted }), ...(started === undefined ? {} : { started }), results });
  }
  return Object.freeze({ append, recordInfrastructureFailure, recordForAudit });
}
