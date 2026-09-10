/**
 * Shared submit-path envelope for 门下省 gates (ADR 0018 / #675 / #753).
 * Owns officer-pointer book + host abort/non-pass faces + review queue loop.
 * Role modules only project via projectGatekeeperRun / runGatekeeper — no book, no catch.
 *
 * Queue guarantee only (#753 / #756 / #750):
 *   parent submit → summon officer → read conclusion field
 *   pass → accept end
 *   bounce | escalate → raw officer receipt as tool result back to parent
 *   not three-state → resume officer with plain-language re-ask (no round cap)
 *   transport / no_receipt → present honestly
 * Three pairs: countersign↔notary, judge↔auditor, worker↔inspector.
 * Code does not judge content, map next-step for parent, or label unreadable/unusable.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bookDirectOfficerRunPointer } from "./archivist-record-entry.ts";
import type { HostContext } from "./host-contracts.ts";
import {
  GatekeeperDecisionError,
  OFFICER_CONCLUSION_REASK,
  projectGatekeeperRun,
  type GatekeeperPassHostActions,
  type GatekeeperResult,
  type GatekeeperSubject,
  type GateOfficer,
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
  officer: GateOfficer,
  result: GatekeeperResult,
  summoned: PublicSummonResult,
): void {
  if (
    result.status !== "pass"
    && result.status !== "bounce"
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
  });
}

/**
 * Shared envelope: project gate, book officer pointer, map onto host actions.
 * Review loop has no round cap (#753 no-round-cap).
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
  let reask: string | undefined;
  // No round cap — end only on pass, bounce/escalate-to-parent, or real failure.
  for (;;) {
    const projected = await projectGatekeeperRun({
      context: options.context,
      subject: options.subject,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.summonOfficer === undefined ? {} : { summonOfficer: options.summonOfficer }),
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
        );
      } catch (error) {
        options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
      }
    }
    if (gatekeeper.status === "pass") return;
    if (gatekeeper.status === "needs_reask") {
      reask = OFFICER_CONCLUSION_REASK;
      continue;
    }
    if (gatekeeper.status === "transport_failure") {
      const failure = Object.assign(new Error(gatekeeper.reason), {
        name: "GatekeeperTransportFailure",
        ...(gatekeeper.submission === undefined ? {} : { submission: gatekeeper.submission }),
      });
      options.hostActions.failInfrastructure(failure, options.context, options.toolCallId);
    }
    // bounce | escalate | no_receipt: parent stands and may resubmit. Not a run abort.
    options.hostActions.bindSubmissionNonPass(options.toolCallId, gatekeeper);
    throw new GatekeeperDecisionError(gatekeeper);
  }
}
