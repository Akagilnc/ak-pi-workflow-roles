import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import { isReviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import {
  REVIEWER_PREFLIGHT_VIOLATIONS,
  type ReviewerPreflightViolation,
  type ReviewerPinnedTarget,
  type AcceptedReviewerDispatch,
} from "./reviewer-dispatch.ts";

export type ReviewerUsage = Readonly<{
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number; reasoning?: number; totalTokens: number;
  cost: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; total: number }>;
}>;
export type ReviewerTargetSnapshot = ReviewerPinnedTarget;
export type ReviewerWorkspaceDisposition = "deleted" | "not-created" | Readonly<{ retained: string }>;
export type ReviewerFailureClassification = "cancelled" | "provider" | "snapshot" | "workspace" | "child" | "unknown";

export type ReviewerCompiledLegEvidence = AcceptedReviewerDispatch["legs"][number];
export type ReviewerAcceptedEvidence = Readonly<
  Omit<AcceptedReviewerDispatch, "targetSnapshot"> & {
    target: AcceptedReviewerDispatch["targetSnapshot"];
  }
>;
export function projectAcceptedDispatch(dispatch: AcceptedReviewerDispatch): ReviewerEvidenceEvent {
  return {
    source: "reviewer-dispatch", type: "accepted", identity: dispatch.identity,
    recipe: dispatch.recipe, input: dispatch.input, target: dispatch.targetSnapshot,
    prerequisiteOperations: dispatch.prerequisiteOperations,
    range: dispatch.range, materials: dispatch.materials, legs: dispatch.legs,
  };
}

export type ReviewerLegResultEvidence = Readonly<{
  dispatchIdentity: string;
  axis: "standards" | "spec";
  status: "successful" | "failed";
  prompt: ReviewerPromptIdentity;
  target: ReviewerPinnedTarget;
  report?: string;
  failure?: ReviewerFailureClassification;
  usage?: ReviewerUsage;
  workspaceDisposition: ReviewerWorkspaceDisposition;
}>;
export type ReviewerEvidenceEvent =
  | Readonly<{ source: "reviewer-transport"; type: "transport-rejected"; identity: string; violation: "schema"; started: false }>
  | (Readonly<{ source: "reviewer-dispatch"; type: "rejected"; identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }>)
  | Readonly<{ source: "reviewer-dispatch"; type: "closed-attempt"; identity: string; reason: "acceptance-closed"; started: false }>
  | (Readonly<{ source: "reviewer-dispatch"; type: "accepted" }> & ReviewerAcceptedEvidence)
  | Readonly<{ source: "reviewer-agent"; type: "dispatch-started"; dispatchIdentity: string; cardinality: 1 | 2 }>
  | (Readonly<{ source: "reviewer-agent"; type: "leg-settled" }> & ReviewerLegResultEvidence)
  | Readonly<{ source: "reviewer-runtime"; type: "fatal"; diagnostics: string; targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition }>;

export type ReviewerExecutionRecord = Readonly<{
  transportRejections: readonly Readonly<{ identity: string; violation: "schema"; started: false }>[];
  rejections: readonly Readonly<{ identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }>[];
  closedAttempts?: readonly Readonly<{ identity: string; reason: "acceptance-closed"; started: false }>[];
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
function fatal(error: unknown): FatalEvidence {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  return cloneFreeze({
    diagnostics: error instanceof Error ? error.message : String(error),
    ...(record?.targetSnapshot === undefined ? {} : { targetSnapshot: record.targetSnapshot as ReviewerTargetSnapshot }),
    ...(record?.workspaceDisposition === undefined ? {} : { workspaceDisposition: record.workspaceDisposition as ReviewerWorkspaceDisposition }),
  });
}

export function createReviewerExecutionLedger(): ReviewerExecutionLedger {
  const transportRejections: Array<{ identity: string; violation: "schema"; started: false }> = [];
  const rejections: Array<{ identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }> = [];
  const closedAttempts: Array<{ identity: string; reason: "acceptance-closed"; started: false }> = [];
  let accepted: ReviewerAcceptedEvidence | undefined;
  let started: { dispatchIdentity: string; cardinality: 1 | 2 } | undefined;
  const results: Partial<Record<"standards" | "spec", ReviewerLegResultEvidence>> = {};
  let infrastructureFailure: FatalEvidence | undefined;

  function append(raw: ReviewerEvidenceEvent): void {
    const event = cloneFreeze(raw);
    if (event.source === "reviewer-transport" && event.type === "transport-rejected") {
      const allowed = ["source", "type", "identity", "violation", "started"];
      if (Object.keys(event).some((key) => !allowed.includes(key)) || event.violation !== "schema" || event.started !== false)
        throw new Error("Transport rejection must contain only immutable bounded non-start evidence");
      if (accepted !== undefined || started !== undefined) throw new Error("Transport rejection cannot follow an accepted dispatch");
      transportRejections.push(cloneFreeze({ identity: event.identity, violation: event.violation, started: false }));
      return;
    }
    if (event.source === "reviewer-dispatch" && event.type === "rejected") {
      const allowed = ["source", "type", "identity", "violations", "started"];
      if (Object.keys(event).some((key) => !allowed.includes(key)) || event.started !== false ||
          event.violations.length === 0 || event.violations.some((code) => !REVIEWER_PREFLIGHT_VIOLATIONS.includes(code)))
        throw new Error("Rejected proposal must contain only closed bounded non-start evidence");
      if (accepted !== undefined || started !== undefined) throw new Error("Rejection cannot follow an accepted dispatch");
      rejections.push(cloneFreeze({ identity: event.identity, violations: event.violations, started: false }));
      return;
    }
    if (event.source === "reviewer-dispatch" && event.type === "closed-attempt") {
      const allowed = ["source", "type", "identity", "reason", "started"];
      if (Object.keys(event).some((key) => !allowed.includes(key)) || event.reason !== "acceptance-closed" || event.started !== false)
        throw new Error("Closed attempt must contain only immutable non-start outcome evidence");
      if (accepted === undefined) throw new Error("Closed attempt requires a closed acceptance lifecycle");
      closedAttempts.push(cloneFreeze({ identity: event.identity, reason: event.reason, started: false }));
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
        if (!isReviewerPromptIdentity(leg.prompt))
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
    if (event.prompt.text !== compiled.prompt.text || event.prompt.utf8Length !== compiled.prompt.utf8Length ||
        event.prompt.sha256 !== compiled.prompt.sha256 || !isReviewerPromptIdentity(event.prompt))
      throw new Error("Actual runner prompt does not exactly match compiled prompt bytes, length, and SHA");
    if (!sameReviewerPinnedTarget(event.target, accepted.target)) throw new Error("Runner target does not match shared pinned target");
    if (event.status === "successful") {
      if (typeof event.report !== "string" || event.report.length === 0 || event.failure !== undefined) throw new Error("Successful settlement requires only a report");
    } else if (event.failure === undefined || event.report !== undefined) {
      throw new Error("Failed settlement requires a bounded failure classification and no report");
    }
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
    return cloneFreeze({ transportRejections, rejections, closedAttempts, ...(accepted === undefined ? {} : { accepted }), ...(started === undefined ? {} : { started }), results });
  }
  return Object.freeze({ append, recordInfrastructureFailure, recordForAudit });
}
