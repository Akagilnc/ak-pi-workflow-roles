/**
 * Shared submit-path envelope for 门下省 gates (ADR 0018 / #675).
 * Owns officer-pointer book + host abort/non-pass faces.
 * Role modules only project via projectGatekeeperRun / runGatekeeper — no book, no catch.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bookDirectOfficerRunPointer } from "./archivist-record-entry.ts";
import type { HostContext } from "./host-contracts.ts";
import {
  GatekeeperDecisionError,
  GatekeeperEscalationError,
  projectGatekeeperRun,
  type GatekeeperPassHostActions,
  type GatekeeperResult,
  type GatekeeperSubject,
  type GateOfficerSummon,
} from "./gatekeeper-role.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import { sessionFileFromPublicSummon } from "./session-assistant-usage.ts";

/**
 * Book a typed pointer under parent session/auditor-roles (archivist-owned write).
 * Offline mocks without a real session leave no nested volume (lawful zero).
 */
function bookDirectOfficerPointer(
  context: ExtensionContext | HostContext,
  officer: "inspector" | "notary",
  result: GatekeeperResult,
  summoned: PublicSummonResult,
): void {
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
  });
}

/**
 * Shared envelope: project gate, book officer pointer, map onto host actions.
 * unreadable = parent stands (ADR 0055); never mechanical NonPass reject.
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
  const projected = await projectGatekeeperRun({
    context: options.context,
    subject: options.subject,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.summonOfficer === undefined ? {} : { summonOfficer: options.summonOfficer }),
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
      );
    } catch (error) {
      options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
    }
  }
  if (gatekeeper.status === "pass") return;
  // ADR 0055 / #675: shape-unreadable officer output must not mechanically reject parent.
  if (gatekeeper.status === "unreadable") return;
  if (gatekeeper.status === "transport_failure") {
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
