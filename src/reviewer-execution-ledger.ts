import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import { isReviewerPromptText, sameReviewerPromptText, type ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import type { ReviewerDispatchRunResult } from "./reviewer-agent.ts";
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
    range: dispatch.range, authorityRefs: dispatch.authorityRefs, legs: dispatch.legs,
  };
}

type ReviewerLegResultEvidenceCommon = Readonly<{
  dispatchIdentity: string;
  axis: "standards" | "spec";
  prompt: ReviewerPromptText;
  target: ReviewerPinnedTarget;
  workspaceDisposition: ReviewerWorkspaceDisposition;
}>;
export type ReviewerLegResultEvidence = ReviewerLegResultEvidenceCommon & (
  | Readonly<{ status: "successful"; report: string; usage: ReviewerUsage; failure?: never }>
  | Readonly<{ status: "failed"; failure: ReviewerFailureClassification; diagnostic: string; report?: never; usage?: never }>
);
export type ReviewerEvidenceEvent =
  | (Readonly<{ source: "reviewer-dispatch"; type: "rejected"; identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }>)
  | Readonly<{ source: "reviewer-dispatch"; type: "closed-attempt"; identity: string; reason: "acceptance-closed"; started: false }>
  | (Readonly<{ source: "reviewer-dispatch"; type: "accepted" }> & ReviewerAcceptedEvidence)
  | Readonly<{ source: "reviewer-agent"; type: "dispatch-started"; dispatchIdentity: string; cardinality: 1 | 2 }>
  | (Readonly<{ source: "reviewer-agent"; type: "leg-settled" }> & ReviewerLegResultEvidence)
  | Readonly<{ source: "reviewer-runtime"; type: "fatal"; diagnostics: string; cause: unknown; targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition }>;

export type ReviewerExecutionRecord = Readonly<{
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

export function projectReviewerDispatchOutcome(
  ledger: ReviewerExecutionLedger,
  dispatch: AcceptedReviewerDispatch,
  result: ReviewerDispatchRunResult,
): void {
  if (result.identity !== dispatch.identity) throw new Error("Reviewer runner identity does not match accepted dispatch");
  if (!sameReviewerPinnedTarget(result.target, dispatch.targetSnapshot)) throw new Error("Reviewer runner target does not match accepted pinned target");
  const expectedAxes = dispatch.legs.map(({ axis }) => axis).sort();
  const actualAxes = Object.keys(result.legs).sort();
  if (actualAxes.length !== expectedAxes.length || actualAxes.some((axis, index) => axis !== expectedAxes[index])) {
    throw new Error(`Reviewer runner result axes do not match accepted dispatch: expected ${expectedAxes.join(",")}; received ${actualAxes.join(",")}`);
  }
  for (const leg of dispatch.legs) {
    const actual = result.legs[leg.axis];
    if (actual === undefined) throw new Error(`Reviewer runner omitted ${leg.axis} result`);
    ledger.append(actual.status === "failed"
      ? { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: dispatch.identity, axis: leg.axis, status: "failed", prompt: actual.prompt, target: actual.target, failure: actual.failure, diagnostic: actual.diagnostic, workspaceDisposition: actual.workspaceDisposition }
      : { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: dispatch.identity, axis: leg.axis, status: "successful", prompt: actual.prompt, target: actual.target, report: actual.report, usage: actual.usage, workspaceDisposition: actual.workspaceDisposition });
  }
}

type FatalEvidence = { diagnostics: string; cause: unknown; targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition };

function cloneFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFreeze)) as T;
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneFreeze(item);
    return Object.freeze(copy) as T;
  }
  return value;
}
function hasExactEventShape(event: object, keys: readonly string[]): boolean {
  const actual = Object.keys(event);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function fatal(error: unknown): FatalEvidence {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  return cloneFreeze({
    diagnostics: "infrastructure-failure",
    cause: error,
    ...(record?.targetSnapshot === undefined ? {} : { targetSnapshot: record.targetSnapshot as ReviewerTargetSnapshot }),
    ...(record?.workspaceDisposition === undefined ? {} : { workspaceDisposition: record.workspaceDisposition as ReviewerWorkspaceDisposition }),
  });
}

export function createReviewerExecutionLedger(): ReviewerExecutionLedger {
  const rejections: Array<{ identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }> = [];
  const closedAttempts: Array<{ identity: string; reason: "acceptance-closed"; started: false }> = [];
  let accepted: ReviewerAcceptedEvidence | undefined;
  let started: { dispatchIdentity: string; cardinality: 1 | 2 } | undefined;
  const results: Partial<Record<"standards" | "spec", ReviewerLegResultEvidence>> = {};
  let infrastructureFailure: FatalEvidence | undefined;

  function append(raw: ReviewerEvidenceEvent): void {
    const event = cloneFreeze(raw);
    if (event.source === "reviewer-dispatch" && event.type === "rejected") {
      if (!hasExactEventShape(event, ["source", "type", "identity", "violations", "started"]) || event.started !== false ||
          event.violations.length === 0 || event.violations.some((code) => !REVIEWER_PREFLIGHT_VIOLATIONS.includes(code)))
        throw new Error("Rejected dispatch must contain only closed bounded non-start evidence");
      if (accepted !== undefined || started !== undefined) throw new Error("Rejection cannot follow an accepted dispatch");
      rejections.push(cloneFreeze({ identity: event.identity, violations: event.violations, started: false }));
      return;
    }
    if (event.source === "reviewer-dispatch" && event.type === "closed-attempt") {
      if (!hasExactEventShape(event, ["source", "type", "identity", "reason", "started"]) || event.reason !== "acceptance-closed" || event.started !== false)
        throw new Error("Closed attempt must contain only immutable non-start outcome evidence");
      if (accepted === undefined) throw new Error("Closed attempt requires a closed acceptance lifecycle");
      closedAttempts.push(cloneFreeze({ identity: event.identity, reason: event.reason, started: false }));
      return;
    }
    if (event.source === "reviewer-dispatch" && event.type === "accepted") {
      if (accepted !== undefined) throw new Error("Projection permits exactly one accepted dispatch");
      const axes = event.legs.map((leg) => leg.axis);
      if (axes[0] !== "standards" || (axes.length !== 1 && (axes.length !== 2 || axes[1] !== "spec")))
        throw new Error("Accepted dispatch sibling axes disagree");
      if (!isReviewerPromptText(event.input.canonicalSkill))
        throw new Error("Accepted canonical Skill must be plain text");
      for (const leg of event.legs) {
        if (!isReviewerPromptText(leg.prompt))
          throw new Error("Accepted compiled prompt must be plain text");
      }
      accepted = event;
      return;
    }
    if (event.source === "reviewer-runtime" && event.type === "fatal") {
      if (infrastructureFailure === undefined) infrastructureFailure = cloneFreeze({
        diagnostics: event.diagnostics,
        cause: event.cause,
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
    if (!sameReviewerPromptText(event.prompt, compiled.prompt) || !isReviewerPromptText(event.prompt))
      throw new Error("Actual runner prompt does not exactly match compiled prompt text");
    if (!sameReviewerPinnedTarget(event.target, accepted.target)) throw new Error("Runner target does not match shared pinned target");
    if (event.status === "successful") {
      if (typeof event.report !== "string" || event.report.length === 0 || event.failure !== undefined) throw new Error("Successful settlement requires a report");
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
    } else if (accepted !== undefined) {
      const expected = accepted.legs.map((leg) => leg.axis);
      if (started === undefined || expected.some((axis) => results[axis] === undefined) || Object.keys(results).length !== expected.length)
        throw new Error("Reviewer refused after acceptance requires every expected leg terminal outcome");
    }
    return cloneFreeze({ rejections, closedAttempts, ...(accepted === undefined ? {} : { accepted }), ...(started === undefined ? {} : { started }), results });
  }
  return Object.freeze({ append, recordInfrastructureFailure, recordForAudit });
}
