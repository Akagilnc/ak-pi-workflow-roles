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
 *   unrecognized status → resume officer with plain-language re-ask (no round cap)
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

/** Queue word of the latest this-terminal payload. History does not outrank it. */
export function latestQueueStatus(terminal: TerminalResult | undefined): string | undefined {
  const outcome = terminal?.roleOutcome;
  if (outcome === undefined) return undefined;
  if (outcome.kind === "audit_escalation") return "escalate";
  if (outcome.kind !== "accepted") return undefined;
  const latest = outcome.payloads?.[outcome.payloads.length - 1];
  if (latest !== null && typeof latest === "object" && !Array.isArray(latest)) {
    const status = (latest as { status?: unknown }).status;
    if (typeof status === "string" && status.trim() !== "") return status;
  }
  return typeof outcome.status === "string" && outcome.status.trim() !== ""
    ? outcome.status
    : undefined;
}

export function latestQueuePayload(terminal: TerminalResult | undefined): unknown {
  const outcome = terminal?.roleOutcome;
  if (outcome === undefined) return undefined;
  if (outcome.kind !== "accepted" && outcome.kind !== "audit_escalation") return undefined;
  const payloads = outcome.payloads ?? [];
  return payloads.length === 0 ? undefined : payloads[payloads.length - 1];
}
import { sessionFileFromPublicSummon } from "./session-assistant-usage.ts";

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
 * Book a typed pointer under parent session/auditor-roles (archivist-owned write).
 * Offline mocks without a real session leave no nested volume (lawful zero).
 */
function bookDirectOfficerPointer(
  context: ExtensionContext | HostContext,
  officer: GateOfficer,
  result: GatekeeperResult,
  summoned: PublicSummonResult,
  round: { readonly toolCallId: string; readonly attemptId?: string },
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
    toolCallId: round.toolCallId,
    ...(round.attemptId === undefined ? {} : { attemptId: round.attemptId }),
  });
}

/**
 * Pass snapshot returned to the parent seat (#969).
 * Carries officer receipt + nested runId so seat settlement can project the
 * public terminal without a second authority.
 */
export type SubmissionGateOutcome = {
  readonly status: "converged" | "continue" | "escalate";
  readonly officer: GateOfficer;
  readonly receipt: unknown;
  readonly runId?: string;
  readonly runDirectory?: string;
};

/**
 * Shared envelope: project gate, book officer pointer, map onto host actions.
 * Review loop has no round cap (#753 no-round-cap).
 * On converged, returns the officer snapshot (receipt + nested runId) for seat projection.
 */
export async function requireSubmissionGate(options: {
  readonly context: ExtensionContext | HostContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  readonly hostActions: SubmissionGateHostActions;
  readonly toolCallId: string;
  /** Ledger attempt of the parent submission this gate reviews (#1057). */
  readonly roundAttemptId?: string;
  /**
   * In-flight parent typed payload for this gate turn (#879). Relayed verbatim
   * as officer dialogue content; binding pointer stays the parent run directory.
   */
  readonly submission?: unknown;
  /** Lowest seam: same as runGatekeeper options.summonOfficer — offline tracers only. */
  readonly summonOfficer?: GateOfficerSummon;
}): Promise<SubmissionGateOutcome | void> {
  let reask: string | undefined;
  // No round cap — end only on converged, continue/escalate, or real failure.
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
          {
            toolCallId: options.toolCallId,
            ...(options.roundAttemptId === undefined ? {} : { attemptId: options.roundAttemptId }),
          },
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
      };
    }
    // no_receipt: keep the lifecycle failure channel; continue is an ordinary
    // nonterminal tool result above, not an exception or correctable rejection.
    options.hostActions.bindSubmissionNonPass(options.toolCallId, gatekeeper);
    throw new GatekeeperDecisionError(gatekeeper);
  }
}
