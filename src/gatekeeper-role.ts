import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostContext } from "./host-contracts.ts";

import {
  auditorRunDirectory,
  persistGateSubmissionCandidate,
} from "./auditor-dossier-tool.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import { GatekeeperDecisionError } from "./submission-errors.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import {
  GATEKEEPER_OUTPUT_TOOL_NAME,
  gatekeeperDecisionSchema,
  gatekeeperOutputSchema,
} from "./package-contracts/gatekeeper-output.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";
export const INSPECTOR_OUTPUT_TOOL = INSPECTOR_OUTPUT_TOOL_NAME;
export const NOTARY_OUTPUT_TOOL = "ak_notary_output";

/** Officer routing only — content is self-fetched via the shared run-dossier tool (#632). */
export type GatekeeperSubject =
  | { readonly kind: "worker_completion" }
  | { readonly kind: "judge_draft" }
  | { readonly kind: "countersign_verdict" };

export type GatekeeperResult =
  /**
   * Lawful direct-officer release.
   */
  | { readonly status: "pass"; readonly officer: "inspector" | "notary"; readonly findings: readonly string[] }
  | {
      readonly status: "bounce";
      readonly officer: "inspector" | "notary";
      readonly disposition: "rewrite";
      readonly findings: readonly string[];
      readonly submission: unknown;
    }
  | {
      readonly status: "escalate";
      readonly officer: "inspector" | "notary";
      readonly reason?: unknown;
      readonly findings: unknown;
      readonly submission: unknown;
    }
  | { readonly status: "no_receipt"; readonly stage: "inspector" | "notary"; readonly reason: string; readonly facts: NoReceiptLifecycleFacts }
  | {
      /** Shape-unreadable officer output — typed fact, not a forged bounce (ADR 0055 / §0). */
      readonly status: "unreadable";
      readonly officer: "inspector" | "notary";
      readonly reason: string;
      readonly submission: unknown;
    }
  | {
      readonly status: "transport_failure";
      readonly stage: "inspector" | "notary";
      readonly reason: string;
      /** Original unusable submission retained for the failure channel. */
      readonly submission?: unknown;
    };

export type GatekeeperNonPassResult = Extract<
  GatekeeperResult,
  { status: "bounce" | "no_receipt" | "unreadable" }
>;

function gateSeatLabel(stage: "inspector" | "notary"): string {
  return stage === "inspector" ? "察院" : "符宝郎";
}

export { GatekeeperDecisionError } from "./submission-errors.ts";

export class GatekeeperEscalationError extends Error {
  readonly gatekeeper: Extract<GatekeeperResult, { status: "escalate" }>;
  constructor(gatekeeper: Extract<GatekeeperResult, { status: "escalate" }>) {
    super(`门下省${gateSeatLabel(gatekeeper.officer)}上呈`);
    this.name = "GatekeeperEscalationError";
    this.gatekeeper = gatekeeper;
  }
}

export type GateOfficerSummon = (
  officer: "inspector" | "notary",
  sourceRunDirectory: string,
) => Promise<PublicSummonResult>;

export type RunGatekeeperOptions = {
  readonly context: ExtensionContext | HostContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  /** Run directory of the parent role (pointer-only summons, ADR 0079). */
  readonly runDirectory?: string;
  /**
   * Test seam for public-role summons. Production calls the shared public
   * activation path (#675); inject only in offline tracers.
   */
  readonly summonOfficer?: GateOfficerSummon;
};

export type GatekeeperPassHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext | HostContext, toolCallId?: string): never;
  /** Envelope-owned execute→tool_result bridge (role-runtime); role module only throws typed error. */
  bindSubmissionNonPass(toolCallId: string, result: GatekeeperNonPassResult): void;
};

/**
 * Direct-seat decision tool spec (#639). Lifecycle assembly stays on the
 * registration envelope — src/role-runtime.ts (ADR 0018). Schema authority is
 * the shared contract module (with infrastructure-failure declaration).
 */
export const GATEKEEPER_TOOL_SPEC = {
  name: GATEKEEPER_OUTPUT_TOOL_NAME,
  label: "门下省决议",
  description: "门下省终局决议，状态为 dispatch 或 pass。",
  promptSnippet: "门下省决议",
  parameters: gatekeeperOutputSchema,
} as const;

export type GatekeeperRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

function result(content: string, details: unknown) {
  return { content: [{ type: "text" as const, text: content }], details };
}

/** Gatekeeper province decision tool — open transport; package-contract projection owns legality. */
export function createGatekeeperOutputTool() {
  return {
    name: GATEKEEPER_OUTPUT_TOOL_NAME,
    description: "提交门下省派官决定。",
    parameters: gatekeeperDecisionSchema,
    async execute(_id: string, args: unknown) {
      return result(`已收 ${String((args as { status?: unknown })?.status)}`, args);
    },
  };
}

function failureReason(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureReason).join("; ");
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Serializable stand-in when the child tool call had no arguments object. */
export const MISSING_ARGUMENTS_SUBMISSION = Object.freeze({ missing: "arguments" as const });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep original decision bytes for the next reader; undefined becomes a serializable missing-args fact. */
function retainedSubmission(decision: unknown): unknown {
  // undefined must not be stored: JSON drops it and the missing-args fact vanishes.
  // Through the real provider adapter an undefined root argument arrives as an
  // empty object after serialization; that must also project a missing-args fact.
  return decision === undefined || (isRecord(decision) && Object.keys(decision).length === 0)
    ? MISSING_ARGUMENTS_SUBMISSION
    : decision;
}

/**
 * Shape-unreadable officer decision — retain original candidate + typed reason.
 * Not a forged bounce, not transport abort (CLAUDE.md §0 / ADR 0055).
 * Real provider/engine/disk failures stay transport_failure elsewhere.
 */
function shapeUnreadable(
  officer: "inspector" | "notary",
  decision: unknown,
  reason = "decision 无显式 pass/bounce/escalate",
): Extract<GatekeeperResult, { status: "unreadable" }> {
  return {
    status: "unreadable",
    officer,
    reason,
    submission: retainedSubmission(decision),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function projectOfficerDecision(
  officer: "inspector" | "notary",
  decision: unknown,
): GatekeeperResult {
  const record = readRecord(decision);
  if (record === undefined) return shapeUnreadable(officer, decision);
  if (record.status === "bounce") {
    return {
      status: "bounce",
      officer,
      disposition: "rewrite",
      findings: asStringArray(record.findings),
      submission: retainedSubmission(decision),
    };
  }
  if (record.status === "pass") {
    return {
      status: "pass",
      officer,
      findings: asStringArray(record.findings),
    };
  }
  if (record.status === "escalate") {
    return {
      status: "escalate",
      officer,
      ...(Object.hasOwn(record, "reason") ? { reason: record.reason } : {}),
      findings: record.findings,
      submission: retainedSubmission(decision),
    };
  }
  return shapeUnreadable(officer, decision);
}

function failureFactsRecord(facts: unknown): Record<string, unknown> | undefined {
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return undefined;
  return facts as Record<string, unknown>;
}

/**
 * Shape-unreadable only when settlement retained a shape candidate under cause=output.
 * Typed host infrastructure (role_infrastructure_failure) stays transport_failure even if a
 * residual path still stamps cause=output (#675 producer→settlement→consumer diversion).
 */
function isShapeUnreadableOfficerFailure(outcome: {
  readonly cause: string;
  readonly decisiveFacts: unknown;
}): boolean {
  if (outcome.cause !== "output") return false;
  const facts = failureFactsRecord(outcome.decisiveFacts);
  if (facts === undefined) return false;
  const secondary = failureFactsRecord(facts.secondaryEvidence);
  if (
    facts.kind === "role_infrastructure_failure"
    || (secondary !== undefined && secondary.kind === "role_infrastructure_failure")
  ) {
    return false;
  }
  return true;
}

function shapeSubmissionFromFailure(facts: unknown): unknown {
  const record = failureFactsRecord(facts);
  if (record === undefined) return facts;
  if (Object.hasOwn(record, "candidate")) return record.candidate;
  const secondary = failureFactsRecord(record.secondaryEvidence);
  if (secondary !== undefined && Object.hasOwn(secondary, "candidate")) {
    return secondary.candidate;
  }
  return facts;
}

/** Map a public-role terminal onto the gate officer result surface. */
function projectOfficerTerminal(
  officer: "inspector" | "notary",
  summoned: PublicSummonResult,
): GatekeeperResult {
  const terminal: TerminalResult | undefined = summoned.terminal;
  const outcome = terminal?.roleOutcome;
  if (outcome === undefined) {
    const detail = summoned.stderr?.trim();
    return {
      status: "transport_failure",
      stage: officer,
      reason: detail && detail.length > 0
        ? `${gateSeatLabel(officer)} public summon exit ${summoned.exitCode}: ${detail}`
        : `${gateSeatLabel(officer)} public summon produced no terminal (exit ${summoned.exitCode})`,
      submission: summoned,
    };
  }
  if (outcome.kind === "no_receipt") {
    return {
      status: "no_receipt",
      stage: officer,
      reason: `${gateSeatLabel(officer)}未产生已接受回执即散局`,
      facts: outcome,
    };
  }
  if (outcome.kind === "failure") {
    // Typed diversion: shape-unreadable vs loud transport (ADR 0055 / #675).
    // Do not infer bounce from non-empty decisiveFacts (冒签角色决定).
    if (isShapeUnreadableOfficerFailure(outcome)) {
      return shapeUnreadable(
        officer,
        shapeSubmissionFromFailure(outcome.decisiveFacts),
        outcome.diagnostic,
      );
    }
    return {
      status: "transport_failure",
      stage: officer,
      reason: outcome.diagnostic,
      submission: outcome.decisiveFacts,
    };
  }
  if (outcome.kind === "accepted") {
    return projectOfficerDecision(officer, {
      status: outcome.status,
      ...outcome.decisiveFacts,
    });
  }
  return {
    status: "transport_failure",
    stage: officer,
    reason: `${gateSeatLabel(officer)} public summon returned unusable terminal kind`,
    submission: outcome,
  };
}

/** Re-export shared pointer contract (persistence owned by direct-officer-run-pointer). */
export {
  DIRECT_OFFICER_RUN_POINTER_KIND,
  type DirectOfficerRunPointer,
} from "./archivist-record-entry.ts";

type GatekeeperSummonProjection = {
  readonly officer: "inspector" | "notary";
  readonly result: GatekeeperResult;
  /** Present only when a public summon actually returned (not transport pre-summon failure). */
  readonly summoned?: PublicSummonResult;
};

/**
 * Shared-envelope pointer book under parent session/auditor-roles (ADR 0018 / #675).
 * Role projection never owns mkdir/writeFile or book exception handling.
 * Offline mocks without a real session leave no nested volume (lawful zero).
 */
async function bookDirectOfficerPointer(
  context: ExtensionContext | HostContext,
  officer: "inspector" | "notary",
  result: GatekeeperResult,
  summoned: PublicSummonResult,
): Promise<void> {
  if (
    result.status !== "pass"
    && result.status !== "bounce"
    && result.status !== "escalate"
    && result.status !== "unreadable"
  ) {
    return;
  }
  const parentFile = context.sessionManager?.getSessionFile?.();
  if (typeof parentFile !== "string" || parentFile.trim() === "") return;
  const { sessionFileFromPublicSummon } = await import("./session-assistant-usage.ts");
  const sessionFile = sessionFileFromPublicSummon(summoned);
  if (sessionFile === undefined) {
    // No independent 正本 to point at — do not synthesize a parallel session.
    return;
  }
  const { bookDirectOfficerRunPointer } = await import("./archivist-record-entry.ts");
  bookDirectOfficerRunPointer({
    parentSessionFile: parentFile,
    officer,
    sessionFile,
    ...(typeof summoned.runDirectory === "string" && summoned.runDirectory.trim() !== ""
      ? { runDirectory: summoned.runDirectory }
      : {}),
  });
}

/** Summon + project only. No lifecycle book (ADR 0018 — envelope owns that). */
async function summonAndProjectGatekeeper(
  options: RunGatekeeperOptions,
): Promise<GatekeeperSummonProjection> {
  const officer = options.subject.kind === "worker_completion" ? "inspector" : "notary";
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    return {
      officer,
      result: {
        status: "transport_failure",
        stage: officer,
        reason: `${gateSeatLabel(officer)} requires a parent run directory pointer`,
      },
    };
  }
  // Pointer-only summons need a resolvable leaf: Grok session.jsonl is header-only
  // (#617 DK-4); write the in-memory tool-call candidate as a run artifact first (#632).
  persistGateSubmissionCandidate(runDirectory, options.context);
  let summoned: PublicSummonResult;
  try {
    const summon =
      options.summonOfficer
      ?? (async (nextOfficer, sourceRunDirectory) => {
        const { summonGateOfficer } = await import("./public-role-summons.ts");
        return summonGateOfficer({
          officer: nextOfficer,
          sourceRunDirectory,
          cwd: options.context.cwd ?? process.cwd(),
        });
      });
    summoned = await summon(officer, runDirectory);
  } catch (error) {
    return {
      officer,
      result: { status: "transport_failure", stage: officer, reason: failureReason(error) },
    };
  }
  return {
    officer,
    result: projectOfficerTerminal(officer, summoned),
    summoned,
  };
}

/** Submission-gate summons: subject kind → officer; activation is public role path (#675). Projection only — no book. */
export async function runGatekeeper(options: RunGatekeeperOptions): Promise<GatekeeperResult> {
  const { result } = await summonAndProjectGatekeeper(options);
  return result;
}

/**
 * Shared submit-path envelope: project gate result, book officer pointer, map onto host actions.
 * Book lifecycle + its failure face live here once (ADR 0018) — not in role projection.
 * unreadable = parent stands with typed fact (ADR 0055); never mechanical NonPass reject.
 */
export async function requireGatekeeperPass(options: {
  readonly context: ExtensionContext | HostContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  readonly hostActions: GatekeeperPassHostActions;
  readonly toolCallId: string;
  /** Lowest seam: same as runGatekeeper options.summonOfficer — offline tracers only. */
  readonly summonOfficer?: GateOfficerSummon;
}): Promise<void> {
  const projected = await summonAndProjectGatekeeper({
    context: options.context,
    subject: options.subject,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.summonOfficer === undefined ? {} : { summonOfficer: options.summonOfficer }),
  });
  const gatekeeper = projected.result;
  // Envelope-owned pointer book. Failure is host infrastructure — single face, no role catch layer.
  if (projected.summoned !== undefined) {
    try {
      await bookDirectOfficerPointer(
        options.context,
        projected.officer,
        gatekeeper,
        projected.summoned,
      );
    } catch (error) {
      options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
    }
  }
  if (gatekeeper.status === "pass") return;
  // ADR 0055 / #675: shape-unreadable officer output must not mechanically reject parent submission.
  // Pointer already booked above when a 正本 existed; parent work stands.
  if (gatekeeper.status === "unreadable") return;
  if (gatekeeper.status === "transport_failure") {
    // Typed stage/reason/submission ride failInfrastructure → durable tool_result (#475).
    const error = new Error(`交卷闸 transport_failure（${gatekeeper.stage}）：${gatekeeper.reason}`) as Error & {
      stage: typeof gatekeeper.stage;
      reason: string;
      submission?: unknown;
    };
    error.stage = gatekeeper.stage;
    error.reason = gatekeeper.reason;
    if (gatekeeper.submission !== undefined) error.submission = gatekeeper.submission;
    options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
  }
  if (gatekeeper.status === "escalate") {
    throw new GatekeeperEscalationError(gatekeeper);
  }
  // bounce / no_receipt: typed non-pass — envelope owns execute→tool_result bridge.
  options.hostActions.bindSubmissionNonPass(options.toolCallId, gatekeeper);
  throw new GatekeeperDecisionError(gatekeeper);
}
