/**
 * Shared submissionGate path for review officers (ADR 0018 / #675 / #753).
 * Owns host abort/non-pass faces + review queue loop. Does not book parent-side
 * officer pointers or project other-seat finals (#1195).
 * Role modules only project via projectGatekeeperRun / runGatekeeper — no catch.
 *
 * Public continuation after submission settlement (#753 / #756 / #750):
 *   accepted submission → summon officer → read conclusion field
 *   converged → continue remaining review and settle
 *   continue → raw officer receipt; caller resumes the submitted seat for revision
 *   escalate → return the officer run so the caller can resume that officer directly
 *   unrecognized status → resume officer with plain-language re-ask, counted
 *     against the configured ceiling; exhaustion keeps that receipt
 *   transport / no_receipt → present honestly
 * Four pairs: countersign↔notary, judge↔auditor, worker↔inspector, secretariat↔countersign (#969).
 * Code does not judge content, map next-step for parent, or label unreadable/unusable.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostContext, RoleTurnHost } from "./host-contracts.ts";
import {
  GatekeeperDecisionError,
  officerConclusionReask,
  projectGatekeeperRun,
  type SubmissionGateHostActions,
  type GatekeeperSubject,
  type GateOfficer,
  type GateOfficerSummon,
} from "./gatekeeper-role.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";
import { receivedDiscriminator } from "./submission-errors.ts";
import type { ReviewQueueWord } from "./review-submission.ts";
import { deliveryLimitFromConfig } from "./receipt-delivery-policy.ts";

/** Received discriminator of the latest payload, retained verbatim for re-ask. */
export function latestQueueStatus(terminal: TerminalResult | undefined): unknown {
  const outcome = terminal?.roleOutcome;
  if (outcome === undefined) return undefined;
  if (outcome.kind === "audit_escalation") return "escalate";
  if (outcome.kind !== "accepted") return undefined;
  const latest = outcome.payloads?.[outcome.payloads.length - 1];
  if (isRecord(latest) && Object.hasOwn(latest, "status")) {
    return receivedDiscriminator(latest, "status");
  }
  return outcome.status;
}

export function latestQueuePayload(terminal: TerminalResult | undefined): unknown {
  const outcome = terminal?.roleOutcome;
  if (outcome === undefined) return undefined;
  if (outcome.kind !== "accepted" && outcome.kind !== "audit_escalation") return undefined;
  const payloads = outcome.payloads ?? [];
  return payloads.length === 0 ? undefined : payloads[payloads.length - 1];
}
import { isRecord } from "./unknown-value.ts";

/**
 * Shared-envelope default officer summon (ADR 0018).
 * Role modules must not own this drive seam — only project results.
 */
export function createDefaultGateOfficerSummon(options: {
  readonly cwd: string;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: import("./public-cli/cli-io.ts").CliIo;
  readonly roleTurnHost?: RoleTurnHost;
  /** Composition-root adapters for nested court stations (tests / #969). */
  readonly hostAdapters?: readonly import("./public-cli/role-turn-host-resolution.ts").NamedRoleTurnHostAdapter[];
  readonly createRunId?: () => string;
}): GateOfficerSummon {
  return async (officer, sourceRunDirectory, signal, reask, submission) => {
    const { summonGateOfficer } = await import("./public-role-summons.ts");
    return summonGateOfficer({
      officer,
      sourceRunDirectory,
      cwd: options.cwd,
      ...(signal === undefined ? {} : { signal }),
      ...(reask === undefined ? {} : { reask }),
      ...(submission === undefined ? {} : { submission }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
      ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
      ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    });
  };
}

/**
 * Pass snapshot returned to the parent seat.
 * Carries officer receipt + nested runId from the actual officer volume.
 * Parent does not book officer pointers or project other-seat finals (#1195).
 */
export type SubmissionGateOutcome = {
  readonly status: ReviewQueueWord | "needs_reask";
  readonly officer: GateOfficer;
  readonly receipt: unknown;
  readonly runId?: string;
  readonly runDirectory?: string;
  /** Officer terminal already returned by the summon. Present when the reply was not a queue word. */
  readonly terminal?: TerminalResult;
};

/**
 * Shared envelope: project gate, map onto host actions.
 * A real converged / continue / escalate returns immediately. An unreadable
 * conclusion reasks that officer against the configured ceiling; exhaustion
 * returns the receipt actually received.
 * Nested incomplete (directionUnsettled) surfaces immediately — resume the
 * actual audit seat, never convert into a reask of the outer officer (ADR 0055).
 */
export async function requireSubmissionGate(options: {
  readonly context: ExtensionContext | HostContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  readonly hostActions: SubmissionGateHostActions;
  readonly toolCallId: string;
  /**
   * In-flight parent typed payload for this gate turn (#879). Relayed verbatim
   * as officer dialogue content; binding pointer stays the parent run directory.
   */
  readonly submission?: unknown;
  /** Lowest seam: same as runGatekeeper options.summonOfficer — offline tracers only. */
  readonly summonOfficer?: GateOfficerSummon;
  /** This loop's ceiling. Absent uses the package default. */
  readonly autoResumeLimit?: number;
}): Promise<SubmissionGateOutcome | void> {
  let reask: string | undefined;
  let reasksSpent = 0;
  const reaskLimit = deliveryLimitFromConfig(options.autoResumeLimit);
  const summonOfficer =
    options.summonOfficer ??
    createDefaultGateOfficerSummon({
      cwd: options.context.cwd ?? process.cwd(),
    });
  for (;;) {
    const projected = await projectGatekeeperRun({
      context: options.context,
      subject: options.subject,
      summonOfficer,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.submission === undefined ? {} : { submission: options.submission }),
      ...(reask === undefined ? {} : { reask }),
    });
    const gatekeeper = projected.result;
    if (gatekeeper.status === "converged") {
      return {
        status: "converged",
        officer: projected.officer,
        receipt: gatekeeper.receipt,
        ...(typeof gatekeeper.runId === "string" && gatekeeper.runId.trim() !== ""
          ? { runId: gatekeeper.runId }
          : {}),
        ...(typeof projected.summoned?.runDirectory === "string"
          && projected.summoned.runDirectory.trim() !== ""
          ? { runDirectory: projected.summoned.runDirectory }
          : {}),
        // Keep the officer terminal for escalate / unsettled surfaces; parent
        // finals do not project other-seat tables (#1195).
        ...(projected.summoned?.terminal === undefined
          ? {}
          : { terminal: projected.summoned.terminal }),
      };
    }
    if (gatekeeper.status === "continue") {
      return {
        status: "continue",
        officer: projected.officer,
        receipt: gatekeeper.receipt,
        ...(typeof gatekeeper.runId === "string" && gatekeeper.runId.trim() !== ""
          ? { runId: gatekeeper.runId }
          : {}),
      };
    }
    if (gatekeeper.status === "needs_reask") {
      // Nested incomplete already exhausted the inner seat's own reask. Surface it;
      // do not convert into a reask of this outer officer (ADR 0055 / #1195).
      const nestedIncomplete =
        projected.summoned?.terminal?.roleOutcome.kind === "accepted"
        && projected.summoned.terminal.roleOutcome.decisiveFacts?.directionUnsettled === true;
      if (nestedIncomplete || reasksSpent >= reaskLimit) {
        return {
          status: "needs_reask",
          officer: projected.officer,
          receipt: gatekeeper.receipt,
          ...(typeof gatekeeper.runId === "string" && gatekeeper.runId.trim() !== ""
            ? { runId: gatekeeper.runId }
            : {}),
          ...(typeof projected.summoned?.runDirectory === "string"
            && projected.summoned.runDirectory.trim() !== ""
            ? { runDirectory: projected.summoned.runDirectory }
            : {}),
          ...(projected.summoned?.terminal === undefined
            ? {}
            : { terminal: projected.summoned.terminal }),
        };
      }
      reasksSpent += 1;
      reask = officerConclusionReask(gatekeeper.receivedStatus);
      continue;
    }
    if (gatekeeper.status === "transport_failure") {
      const failure = Object.assign(new Error(gatekeeper.reason), {
        name: "GatekeeperTransportFailure",
        ...(gatekeeper.submission === undefined ? {} : { submission: gatekeeper.submission }),
      });
      options.hostActions.failInfrastructure(failure, options.context, options.toolCallId);
    }
    if (gatekeeper.status === "escalate") {
      return {
        status: "escalate",
        officer: projected.officer,
        receipt: gatekeeper.receipt,
        ...(typeof gatekeeper.runId === "string" && gatekeeper.runId.trim() !== ""
          ? { runId: gatekeeper.runId }
          : {}),
        ...(typeof projected.summoned?.runDirectory === "string"
          && projected.summoned.runDirectory.trim() !== ""
          ? { runDirectory: projected.summoned.runDirectory }
          : {}),
        // Keep the actual officer terminal so callers resume that seat.
        ...(projected.summoned?.terminal === undefined
          ? {}
          : { terminal: projected.summoned.terminal }),
      };
    }
    // no_receipt: keep the lifecycle failure channel; continue is an ordinary
    // nonterminal tool result above, not an exception or correctable rejection.
    options.hostActions.bindSubmissionNonPass(options.toolCallId, gatekeeper);
    throw new GatekeeperDecisionError(gatekeeper);
  }
}
