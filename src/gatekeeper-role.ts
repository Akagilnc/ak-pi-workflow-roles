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
import { retainedShapeUnreadableCandidate } from "./shape-unreadable-failure.ts";
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
    // Single settlement marker only (ADR 0055 / #675) — no cause=output re-derivation.
    const shapeCandidate = retainedShapeUnreadableCandidate(outcome.decisiveFacts);
    if (shapeCandidate !== undefined) {
      return shapeUnreadable(officer, shapeCandidate, outcome.diagnostic);
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

/** Projection carrier for the shared submit envelope (ADR 0018). No lifecycle book here. */
export type GatekeeperProjection = {
  readonly officer: "inspector" | "notary";
  readonly result: GatekeeperResult;
  /** Present only when a public summon actually returned (not transport pre-summon failure). */
  readonly summoned?: PublicSummonResult;
};

/**
 * Summon + project only. Lifecycle book and host abort face live on the shared
 * submit envelope (`gatekeeper-pass-envelope.ts`, ADR 0018 / #675).
 */
export async function projectGatekeeperRun(
  options: RunGatekeeperOptions,
): Promise<GatekeeperProjection> {
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

/** Submission-gate summons: subject kind → officer; activation is public role path (#675). Projection only. */
export async function runGatekeeper(options: RunGatekeeperOptions): Promise<GatekeeperResult> {
  const { result } = await projectGatekeeperRun(options);
  return result;
}
