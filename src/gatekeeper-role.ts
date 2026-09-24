import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostContext } from "./host-contracts.ts";

import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import { packagedGateStageLabel } from "./packaged-role-registry.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import { GatekeeperDecisionError, receivedDiscriminator, unreadableDiscriminatorNotice } from "./submission-errors.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import { REVIEW_QUEUE_STATUSES, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, reviewInfrastructureRoute } from "./review-submission.ts";
import {
  GATEKEEPER_OUTPUT_TOOL_NAME,
  gatekeeperDecisionSchema,
  gatekeeperOutputSchema,
} from "./package-contracts/gatekeeper-output.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
export const INSPECTOR_OUTPUT_TOOL = INSPECTOR_OUTPUT_TOOL_NAME;
export const NOTARY_OUTPUT_TOOL = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;

/** Gate review officers — 台院 / 符宝郎 / 审刑院 / 给事中 (#753 / #756 / #969). */
export type GateOfficer = "inspector" | "notary" | "auditor" | "countersign";

/** Officer routing only — content is self-fetched via the shared run-dossier tool (#632). */
export type GatekeeperSubject =
  | { readonly kind: "worker_completion" }
  | { readonly kind: "judge_draft" }
  | { readonly kind: "judge_compliance" }
  | { readonly kind: "countersign_verdict" }
  | { readonly kind: "secretariat_verdict" };

/**
 * Gate projection for the review queue (#753 / #750).
 * Code only reads the conclusion field for queueing. Officer words ride as
 * `receipt` unchanged — no findings rewrite, no unreadable/unusable label,
 * no next-step selection for the parent.
 * `runId` is the nested officer run id when known (summoned.runDirectory /
 * terminal.runId) — public terminal projection consumes it (#969).
 */
export type GatekeeperResult =
  | {
      readonly status: "converged";
      readonly officer: GateOfficer;
      readonly receipt: unknown;
      readonly runId?: string;
    }
  /** continue | escalate: both return the officer receipt to the parent (#753 / #756). */
  | {
      readonly status: "continue";
      readonly officer: GateOfficer;
      readonly receipt: unknown;
      readonly runId?: string;
    }
  | {
      readonly status: "escalate";
      readonly officer: GateOfficer;
      readonly receipt: unknown;
      readonly runId?: string;
    }
  | {
      /**
       * Accepted reply whose conclusion is not converged|continue|escalate.
       * Envelope resumes the officer with plain-language re-ask — never parent-stands,
       * never forges continue (#753 / unreadable-conclusion-resume-speaker).
       */
      readonly status: "needs_reask";
      readonly officer: GateOfficer;
      readonly receipt: unknown;
      /** Discriminator the queue already read. Not written back onto the receipt. */
      readonly receivedStatus?: unknown;
      readonly runId?: string;
    }
  | { readonly status: "no_receipt"; readonly stage: GateOfficer; readonly reason: string; readonly facts: NoReceiptLifecycleFacts }
  | {
      readonly status: "transport_failure";
      readonly stage: GateOfficer;
      readonly reason: string;
      /** Original transport/process failure payload retained for the failure channel. */
      readonly submission?: unknown;
    };

/** Non-pass faces returned to the parent session (correctable; #836 never kill leg). */
export type SubmissionGateNonPassResult = Extract<
  GatekeeperResult,
  { status: "continue" | "escalate" | "no_receipt" | "transport_failure" }
>;

function gateSeatLabel(stage: GateOfficer): string {
  return packagedGateStageLabel(stage) ?? stage;
}

/** Subject kind → review officer. One table; default is notary. */
const GATE_OFFICER_BY_SUBJECT = {
  worker_completion: "inspector",
  judge_compliance: "auditor",
  judge_draft: "notary",
  countersign_verdict: "notary",
  secretariat_verdict: "countersign",
} as const satisfies Record<GatekeeperSubject["kind"], GateOfficer>;

/** Subject kind → review officer (#753 countersign/notary, #756 judge/auditor + worker/inspector, #969 secretariat/countersign). */
export function gateOfficerForSubject(subject: GatekeeperSubject): GateOfficer {
  return GATE_OFFICER_BY_SUBJECT[subject.kind];
}

export { GatekeeperDecisionError } from "./submission-errors.ts";

export type GateOfficerSummon = (
  officer: GateOfficer,
  sourceRunDirectory: string,
  /** Parent cancellation forwarded to the nested activation (#675). */
  signal?: AbortSignal,
  /**
   * Plain-language re-ask when the prior officer reply was not a three-state
   * conclusion (#753 / #756). Hosted as same-ticket resume instruction.
   */
  reask?: string,
  /**
   * In-flight parent 交卷 body (tool-call arguments). Production default relays
   * it verbatim on the officer dialogue content channel (#786 / #879).
   * Identity-bound at the submit site — never recovered as latest toolCall.
   */
  submission?: unknown,
) => Promise<PublicSummonResult>;

export type RunGatekeeperOptions = {
  readonly context: ExtensionContext | HostContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  /** Run directory of the parent role (binding pointer, ADR 0079 / #879). */
  readonly runDirectory?: string;
  /**
   * Plain-language re-ask for this summon (resume speaker after non-three-state).
   */
  readonly reask?: string;
  /**
   * In-flight parent typed payload for this gate turn. Relayed verbatim as
   * officer dialogue content (#879). Call site passes the current tool args —
   * code must not scan session latest/mtime to recover it.
   */
  readonly submission?: unknown;
  /**
   * Officer summon seam. Production default lives on the shared envelope
   * (`createDefaultGateOfficerSummon` / requireSubmissionGate — ADR 0018).
   * Role module only projects; callers must supply the summon.
   */
  readonly summonOfficer: GateOfficerSummon;
};

export type SubmissionGateHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext | HostContext, toolCallId?: string): never;
  /** Envelope-owned execute→tool_result bridge (role-runtime); role module only throws typed error. */
  bindSubmissionNonPass(toolCallId: string, result: SubmissionGateNonPassResult): void;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Original decision bytes — no sentinel replacement (#836). */
function retainedReceipt(decision: unknown): unknown {
  return decision;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Read only the conclusion field for queueing (#753).
 * converged | continue | escalate → queue signal + raw receipt.
 * Anything else accepted → needs_reask (resume speaker), never unreadable/parent-stand.
 * `fallbackStatus` is the terminal outcome.status when the receipt body has no status key
 * (keeps missing-args sentinel intact as the receipt).
 */
/** Map the shared review verdict onto the gate queue words (#1028 / #1055). */
function reviewQueueStatus(status: string): string | undefined {
  return REVIEW_QUEUE_STATUSES.has(status) ? status : undefined;
}

function projectOfficerDecision(
  officer: GateOfficer,
  decision: unknown,
  fallbackStatus?: string,
): GatekeeperResult {
  const receipt = retainedReceipt(decision);
  const record = readRecord(decision);
  const status =
    (record !== undefined && typeof record.status === "string" ? record.status : undefined)
    ?? fallbackStatus;
  const failureRoute = reviewInfrastructureRoute(decision);
  if (failureRoute.kind === "reask") {
    return { status: "needs_reask", officer, receipt, receivedStatus: failureRoute.receivedStatus };
  }
  if (failureRoute.kind === "escalate") {
    return { status: "escalate", officer, receipt };
  }
  const queueStatus = typeof status === "string" ? reviewQueueStatus(status) : undefined;
  if (queueStatus === "converged") {
    return { status: "converged", officer, receipt };
  }
  if (queueStatus === "continue" || queueStatus === "escalate") {
    return { status: queueStatus, officer, receipt };
  }
  return { status: "needs_reask", officer, receipt, receivedStatus: status };
}

/**
 * This-court officer payloads for the parent return path (#879).
 * Only settlement-scoped roleOutcome.payloads (courtAttempt seal) carry this-court
 * identity. Never guess from undivided submissions — sole row included — history
 * stays on terminal.submissions (#836 presentation).
 */
function thisCourtOfficerPayloads(terminal: TerminalResult | undefined): readonly unknown[] {
  const outcome = terminal?.roleOutcome;
  // This-court identity only from accepted/audit_escalation settlement payloads
  // (#879). Failure history is not this-court (#953) — it rides submissions.
  if (outcome !== undefined && (outcome.kind === "accepted" || outcome.kind === "audit_escalation")) {
    if (outcome.payloads !== undefined && outcome.payloads.length > 0) return outcome.payloads;
  }
  // No sole-row identity guess: undivided submissions are not this-court (#879).
  return [];
}

/**
 * Failure/transport channel surfaces recorded history beside the failure
 * (#836 A.3) via the historical carrier only (#953 — not failure.payloads).
 */
function officerFailurePayloads(terminal: TerminalResult | undefined): readonly unknown[] {
  return terminal?.submissions ?? [];
}

function projectOfficerPayloads(
  officer: GateOfficer,
  payloads: readonly unknown[],
  fallbackStatus?: string,
): GatekeeperResult {
  if (payloads.length === 0) {
    return projectOfficerDecision(officer, undefined, fallbackStatus);
  }
  // This-court multi-submit: queue the latest seal of THIS court only (#836 呈现≠排队).
  // Single this-court seal is the common path. Never fold history into an array receipt.
  return projectOfficerDecision(officer, payloads[payloads.length - 1], fallbackStatus);
}

/** Nested officer runId from summoned.runDirectory, else terminal.runId (#969). */
export function officerRunIdFromSummoned(summoned: PublicSummonResult): string | undefined {
  if (typeof summoned.runDirectory === "string" && summoned.runDirectory.trim() !== "") {
    const fromDir = runIdFromRunDirectory(summoned.runDirectory);
    if (fromDir !== undefined) return fromDir;
  }
  const terminal = summoned.terminal;
  if (
    terminal !== undefined
    && typeof terminal.runId === "string"
    && terminal.runId.trim() !== ""
  ) {
    return terminal.runId;
  }
  return undefined;
}

function withOfficerRunId(
  result: GatekeeperResult,
  summoned: PublicSummonResult,
): GatekeeperResult {
  if (
    result.status !== "converged"
    && result.status !== "continue"
    && result.status !== "escalate"
    && result.status !== "needs_reask"
  ) {
    return result;
  }
  if (typeof result.runId === "string" && result.runId.trim() !== "") return result;
  const runId = officerRunIdFromSummoned(summoned);
  if (runId === undefined) return result;
  return { ...result, runId };
}

function projectOfficerTerminal(
  officer: GateOfficer,
  summoned: PublicSummonResult,
): GatekeeperResult {
  const terminal: TerminalResult | undefined = summoned.terminal;
  const outcome = terminal?.roleOutcome;
  const thisCourt = thisCourtOfficerPayloads(terminal);
  if (outcome === undefined) {
    const detail = summoned.stderr ?? "";
    const failurePayloads = officerFailurePayloads(terminal);
    return {
      status: "transport_failure",
      stage: officer,
      reason: detail.length > 0
        ? `${gateSeatLabel(officer)} public summon exit ${summoned.exitCode}: ${detail}`
        : `${gateSeatLabel(officer)} public summon produced no terminal (exit ${summoned.exitCode})`,
      submission: failurePayloads.length > 0 ? failurePayloads : summoned,
    };
  }
  if (outcome.kind === "no_receipt") {
    return {
      status: "no_receipt",
      stage: officer,
      reason: typeof outcome.status === "string" && outcome.status.length > 0
        ? outcome.status
        : "no_receipt",
      facts: outcome,
    };
  }
  if (outcome.kind === "failure") {
    const failurePayloads = officerFailurePayloads(terminal);
    return {
      status: "transport_failure",
      stage: officer,
      reason: outcome.diagnostic,
      submission: failurePayloads.length > 0 ? failurePayloads : outcome.decisiveFacts,
    };
  }
  if (outcome.kind === "audit_escalation") {
    return withOfficerRunId(
      {
        status: "escalate",
        officer,
        // This-court receipt only (#879) — historical rows remain on terminal.submissions.
        receipt: outcome.decisiveFacts !== undefined && Object.hasOwn(outcome.decisiveFacts, "auditEscalationReceipt")
          ? outcome.decisiveFacts.auditEscalationReceipt
          : thisCourt.length > 0 ? thisCourt[thisCourt.length - 1] : retainedReceipt(outcome),
      },
      summoned,
    );
  }
  if (outcome.kind === "accepted") {
    // outcome.status is the fixture/compat leaf: production settlement leaves
    // it undefined once payloads are recorded. It may interpret a receipt
    // lacking its own status, never substitute for a missing receipt.
    return withOfficerRunId(
      projectOfficerPayloads(officer, thisCourt, outcome.status),
      summoned,
    );
  }
  const receipt = thisCourt.length > 0 ? thisCourt[thisCourt.length - 1] : retainedReceipt(outcome);
  return withOfficerRunId(
    {
      status: "needs_reask",
      officer,
      // This-court receipt only (#879).
      receipt,
      receivedStatus: receivedDiscriminator(receipt, "status"),
    },
    summoned,
  );
}

/** Projection carrier for the shared submit envelope (ADR 0018). No lifecycle book here. */
export type GatekeeperProjection = {
  readonly officer: GateOfficer;
  readonly result: GatekeeperResult;
  /** Present only when a public summon actually returned (not transport pre-summon failure). */
  readonly summoned?: PublicSummonResult;
};

/**
 * Officer conclusion was missing or not a queue word (#1055).
 * `received` is the status value only, not the rest of the receipt.
 */
export function officerConclusionReask(received: unknown): string {
  return unreadableDiscriminatorNotice("status", received);
}

/**
 * Summon (via injected seam) + project. Default summonGateOfficer drive lives
 * on the shared envelope (`submission-gate.ts`, ADR 0018 / #675) —
 * role module keeps projection only.
 */
export async function projectGatekeeperRun(
  options: RunGatekeeperOptions,
): Promise<GatekeeperProjection> {
  const officer = gateOfficerForSubject(options.subject);
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
  // #879: binding pointer = parent run directory; dialogue content = this-turn
  // typed payload passed explicitly (never latest-toolCall recovery, A7.1–A7.3).
  let summoned: PublicSummonResult;
  try {
    summoned = await options.summonOfficer(
      officer,
      runDirectory,
      options.signal,
      options.reask,
      options.submission,
    );
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
