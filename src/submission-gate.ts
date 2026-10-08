/**
 * Shared submissionGate path for review officers (ADR 0018 / #675 / #753).
 * Owns officer-pointer book + host abort/non-pass faces + review queue loop.
 * Role modules only project via projectGatekeeperRun / runGatekeeper — no book, no catch.
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
import { bookDirectOfficerRunPointer } from "./archivist-record-pointer.ts";
import type { HostContext, RoleTurnHost } from "./host-contracts.ts";
import {
  GatekeeperDecisionError,
  officerConclusionReask,
  projectGatekeeperRun,
  type SubmissionGateHostActions,
  type GatekeeperResult,
  type GatekeeperSubject,
  type GateOfficer,
  type GateOfficerSummon,
} from "./gatekeeper-role.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
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
import { sessionFileFromPublicSummon } from "./session-assistant-usage.ts";

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
 * Book a typed pointer in the parent run's current.json officers section.
 * Offline mocks without a real session leave no nested volume (lawful zero).
 */
function bookDirectOfficerPointer(
  context: ExtensionContext | HostContext,
  officer: GateOfficer,
  result: GatekeeperResult,
  summoned: PublicSummonResult,
  toolCallId: string,
): void {
  if (
    result.status !== "converged"
    && result.status !== "continue"
    && result.status !== "escalate"
    && result.status !== "needs_reask"
    && result.status !== "transport_failure"
  ) {
    return;
  }
  const parentFile = context.sessionManager?.getSessionFile?.();
  if (typeof parentFile !== "string" || parentFile.trim() === "") return;
  const sessionFile = sessionFileFromPublicSummon(summoned);
  if (sessionFile === undefined) {
    // No independent 正本 to point at — do not synthesize a parallel session.
    return;
  }
  bookDirectOfficerRunPointer({
    parentSessionFile: parentFile,
    officer,
    sessionFile,
    ...(typeof summoned.runDirectory === "string" && summoned.runDirectory.trim() !== ""
      ? { runDirectory: summoned.runDirectory }
      : {}),
    ...(toolCallId.trim() === "" ? {} : { submissionToolCallId: toolCallId }),
  });
}

/**
 * Pass snapshot returned to the parent seat (#969).
 * Carries officer receipt + nested runId so seat settlement can project the
 * public terminal without a second authority.
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
 * Shared envelope: project gate, book officer pointer, map onto host actions.
 * A real converged / continue / escalate returns immediately. An unreadable
 * conclusion reasks that officer against the configured ceiling; exhaustion
 * returns the receipt actually received.
 * On converged, returns the officer snapshot (receipt + nested runId) for seat projection.
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
    // Envelope-owned pointer book. Failure is host infrastructure — single face.
    if (projected.summoned !== undefined) {
      try {
        bookDirectOfficerPointer(
          options.context,
          projected.officer,
          gatekeeper,
          projected.summoned,
          options.toolCallId,
        );
      } catch (error) {
        options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
      }
    }
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
        // #1195: carry nested officer terminal so the parent public face can
        // re-present the original volume (nested summon uses capturing IO).
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
      if (reasksSpent >= reaskLimit) {
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
        // #1195: keep the nested terminal (incl. parent court facts attached on
        // the escalate path) so outer parents do not re-settle and drop them.
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
