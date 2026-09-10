import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostContext } from "./host-contracts.ts";

import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
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

/** Gate review officers — 察院 / 符宝郎 / 审刑院 (#753 / #756). */
export type GateOfficer = "inspector" | "notary" | "auditor";

/** Officer routing only — content is self-fetched via the shared run-dossier tool (#632). */
export type GatekeeperSubject =
  | { readonly kind: "worker_completion" }
  | { readonly kind: "judge_draft" }
  | { readonly kind: "judge_compliance" }
  | { readonly kind: "countersign_verdict" };

/**
 * Gate projection for the review queue (#753 / #750).
 * Code only reads the conclusion field for queueing. Officer words ride as
 * `receipt` unchanged — no findings rewrite, no unreadable/unusable label,
 * no next-step selection for the parent.
 */
export type GatekeeperResult =
  | { readonly status: "pass"; readonly officer: GateOfficer; readonly receipt: unknown }
  /** bounce | escalate: both return the officer receipt to the parent (#753 / #756). */
  | { readonly status: "bounce"; readonly officer: GateOfficer; readonly receipt: unknown }
  | { readonly status: "escalate"; readonly officer: GateOfficer; readonly receipt: unknown }
  | {
      /**
       * Accepted reply whose conclusion is not pass|bounce|escalate.
       * Envelope resumes the officer with plain-language re-ask — never parent-stands,
       * never forges bounce (#753 / unreadable-conclusion-resume-speaker).
       */
      readonly status: "needs_reask";
      readonly officer: GateOfficer;
      readonly receipt: unknown;
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
export type GatekeeperNonPassResult = Extract<
  GatekeeperResult,
  { status: "bounce" | "escalate" | "no_receipt" | "transport_failure" }
>;

function gateSeatLabel(stage: GateOfficer): string {
  if (stage === "inspector") return "察院";
  if (stage === "auditor") return "审刑院";
  return "符宝郎";
}

/** Subject kind → review officer (#753 countersign/notary, #756 judge/auditor + worker/inspector). */
export function gateOfficerForSubject(subject: GatekeeperSubject): GateOfficer {
  if (subject.kind === "worker_completion") return "inspector";
  if (subject.kind === "judge_compliance") return "auditor";
  return "notary";
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
) => Promise<PublicSummonResult>;

export type RunGatekeeperOptions = {
  readonly context: ExtensionContext | HostContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  /** Run directory of the parent role (pointer-only summons, ADR 0079). */
  readonly runDirectory?: string;
  /**
   * Plain-language re-ask for this summon (resume speaker after non-three-state).
   */
  readonly reask?: string;
  /**
   * Test seam for public-role summons. Production calls the shared public
   * activation path (#675); inject only in offline tracers.
   */
  readonly summonOfficer?: GateOfficerSummon;
  /**
   * Offline test injects forwarded through the production default summonGateOfficer
   * path (same faces as public CLI). Production leaves these unset.
   */
  readonly home?: string;
  readonly packageRoot?: string;
  readonly roleTurnHost?: import("./host-contracts.ts").RoleTurnHost;
  readonly createRunId?: () => string;
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
 * pass | bounce | escalate → queue signal + raw receipt.
 * Anything else accepted → needs_reask (resume speaker), never unreadable/parent-stand.
 * `fallbackStatus` is the terminal outcome.status when the receipt body has no status key
 * (keeps missing-args sentinel intact as the receipt).
 */
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
  if (status === "pass") {
    return { status: "pass", officer, receipt };
  }
  if (status === "bounce" || status === "escalate") {
    return { status, officer, receipt };
  }
  return { status: "needs_reask", officer, receipt };
}

/**
 * Project a public-role terminal onto the gate queue surface.
 * Host failure stays failure; recorded officer payloads ride beside it (#836 A.3).
 * Multiple recorded payloads are all kept — code does not pick last-wins.
 */
function officerPayloads(terminal: TerminalResult | undefined): readonly unknown[] {
  const outcome = terminal?.roleOutcome;
  if (outcome !== undefined && (outcome.kind === "accepted" || outcome.kind === "audit_escalation")) {
    return outcome.payloads ?? terminal?.submissions ?? [];
  }
  if (outcome?.kind === "failure") return outcome.payloads ?? terminal?.submissions ?? [];
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
  // Present every recorded payload; queue only the latest conclusion so a reask
  // can converge (#836 呈现 ≠ 排队).
  const queued = projectOfficerDecision(officer, payloads[payloads.length - 1], fallbackStatus);
  if (payloads.length === 1) return queued;
  if (
    queued.status === "pass"
    || queued.status === "bounce"
    || queued.status === "escalate"
    || queued.status === "needs_reask"
  ) {
    return { ...queued, receipt: payloads };
  }
  return queued;
}

function projectOfficerTerminal(
  officer: GateOfficer,
  summoned: PublicSummonResult,
): GatekeeperResult {
  const terminal: TerminalResult | undefined = summoned.terminal;
  const outcome = terminal?.roleOutcome;
  const recorded = officerPayloads(terminal);
  if (outcome === undefined) {
    const detail = summoned.stderr ?? "";
    return {
      status: "transport_failure",
      stage: officer,
      reason: detail.length > 0
        ? `${gateSeatLabel(officer)} public summon exit ${summoned.exitCode}: ${detail}`
        : `${gateSeatLabel(officer)} public summon produced no terminal (exit ${summoned.exitCode})`,
      submission: recorded.length > 0 ? recorded : summoned,
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
    return {
      status: "transport_failure",
      stage: officer,
      reason: outcome.diagnostic,
      submission: recorded.length > 0 ? recorded : outcome.decisiveFacts,
    };
  }
  if (outcome.kind === "audit_escalation") {
    return {
      status: "escalate",
      officer,
      receipt: recorded.length === 1 ? recorded[0] : recorded,
    };
  }
  if (outcome.kind === "accepted") {
    return projectOfficerPayloads(officer, recorded);
  }
  return {
    status: "needs_reask",
    officer,
    receipt: recorded.length > 0 ? recorded : retainedReceipt(outcome),
  };
}

/** Projection carrier for the shared submit envelope (ADR 0018). No lifecycle book here. */
export type GatekeeperProjection = {
  readonly officer: GateOfficer;
  readonly result: GatekeeperResult;
  /** Present only when a public summon actually returned (not transport pre-summon failure). */
  readonly summoned?: PublicSummonResult;
};

/**
 * Plain-language re-ask when the officer conclusion is not pass|bounce|escalate.
 * Not a packaged engine handbook line (#755 exception for 读不出三态).
 */
export const OFFICER_CONCLUSION_REASK =
  "上次交卷的结论不是 pass、bounce、escalate 三态之一。请重新输出，结论字段写明其一；打回或上呈的话就是给对方看的原文。" as const;

/**
 * Summon + project only. Lifecycle book and host abort face live on the shared
 * submit envelope (`gatekeeper-pass-envelope.ts`, ADR 0018 / #675).
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
  // #836: officers receive the whole parent run directory pointer and find the
  // submission themselves — code no longer picks latest toolCall leaf (A7.1–A7.3).
  let summoned: PublicSummonResult;
  try {
    const summon =
      options.summonOfficer
      ?? (async (nextOfficer, sourceRunDirectory, officerSignal, reask) => {
        const { summonGateOfficer } = await import("./public-role-summons.ts");
        return summonGateOfficer({
          officer: nextOfficer,
          sourceRunDirectory,
          cwd: options.context.cwd ?? process.cwd(),
          ...(officerSignal === undefined ? {} : { signal: officerSignal }),
          ...(reask === undefined ? {} : { reask }),
          ...(options.home === undefined ? {} : { home: options.home }),
          ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
          ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
          ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
        });
      });
    summoned = await summon(
      officer,
      runDirectory,
      options.signal,
      options.reask,
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
