/**
 * Shared submissionGate path for review officers (ADR 0018 / #675 / #753).
 * Owns officer-pointer book + host abort/non-pass faces + review queue loop.
 * Role modules only project via projectGatekeeperRun / runGatekeeper — no book, no catch.
 *
 * Queue guarantee only (#753 / #756 / #750):
 *   parent submit → summon officer → read conclusion field
 *   converged → accept end
 *   continue → raw officer receipt as a nonterminal result; parent may resubmit
 *   escalate → park the officer; parent waits. Do not hang the escalation on the parent.
 *   unrecognized status → resume officer with plain-language re-ask (no round cap)
 *   transport / no_receipt → present honestly
 * Four pairs: countersign↔notary, judge↔auditor, worker↔inspector, secretariat↔countersign (#969).
 * Code does not judge content, map next-step for parent, or label unreadable/unusable.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bookDirectOfficerRunPointer } from "./archivist-record-entry.ts";
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
import { OfficerEscalationParkError } from "./submission-errors.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";

/** Durable parent-session fact: this turn's officer escalate is waiting on that officer. */
export const OFFICER_ESCALATION_PARK_ENTRY_TYPE = "ak-role-officer-escalation-park" as const;

export type OfficerEscalationPark = {
  readonly officerRunId?: string;
  readonly officerRunDirectory?: string;
  readonly submission?: unknown;
  readonly toolCallId?: string;
  readonly receipt?: unknown;
  readonly courtAttemptId?: string;
  readonly attemptHeaderId?: string;
};

function parkFromData(data: Record<string, unknown>): OfficerEscalationPark {
  return {
    ...(typeof data.officerRunId === "string" && data.officerRunId.trim() !== ""
      ? { officerRunId: data.officerRunId }
      : {}),
    ...(typeof data.officerRunDirectory === "string" && data.officerRunDirectory.trim() !== ""
      ? { officerRunDirectory: data.officerRunDirectory }
      : {}),
    ...(data.submission === undefined ? {} : { submission: data.submission }),
    ...(typeof data.toolCallId === "string" && data.toolCallId.trim() !== ""
      ? { toolCallId: data.toolCallId }
      : {}),
    ...(data.receipt === undefined ? {} : { receipt: data.receipt }),
    ...(typeof data.courtAttemptId === "string" && data.courtAttemptId.trim() !== ""
      ? { courtAttemptId: data.courtAttemptId }
      : {}),
    ...(typeof data.attemptHeaderId === "string" && data.attemptHeaderId.trim() !== ""
      ? { attemptHeaderId: data.attemptHeaderId }
      : {}),
  };
}

/** Latest park fact on the parent session. Missing file is absence, not damage. */
export async function readOfficerEscalationPark(
  sessionFile: string,
): Promise<OfficerEscalationPark | undefined> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let latest: OfficerEscalationPark | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const entry = parsed as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== OFFICER_ESCALATION_PARK_ENTRY_TYPE) continue;
    if (entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
    latest = parkFromData(entry.data as Record<string, unknown>);
  }
  return latest;
}

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
  });
}

/**
 * Pass snapshot returned to the parent seat (#969).
 * Carries officer receipt + nested runId so seat settlement can project the
 * public terminal without a second authority.
 */
export type SubmissionGateOutcome = {
  readonly status: "converged" | "continue";
  readonly officer: GateOfficer;
  readonly receipt: unknown;
  readonly runId?: string;
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
      reask = officerConclusionReask(projected.officer);
      continue;
    }
    if (gatekeeper.status === "transport_failure") {
      const failure = Object.assign(new Error(gatekeeper.reason), {
        name: "GatekeeperTransportFailure",
        ...(gatekeeper.submission === undefined ? {} : { submission: gatekeeper.submission }),
      });
      options.hostActions.failInfrastructure(failure, options.context, options.toolCallId);
    }
    // Escalation pauses the officer. The parent waits; the verdict is not delivered to it.
    if (gatekeeper.status === "escalate") {
      const officerRunDirectory = projected.summoned?.runDirectory;
      const session = options.context.sessionManager;
      const courtAttemptId = "courtAttemptId" in options.context
        ? options.context.courtAttemptId
        : undefined;
      const headerId = session.getHeader?.()?.id;
      if ("appendCustomEntry" in session) {
        session.appendCustomEntry(OFFICER_ESCALATION_PARK_ENTRY_TYPE, {
          ...(typeof gatekeeper.runId === "string" && gatekeeper.runId.trim() !== ""
            ? { officerRunId: gatekeeper.runId }
            : {}),
          ...(typeof officerRunDirectory === "string" && officerRunDirectory.trim() !== ""
            ? { officerRunDirectory }
            : {}),
          ...(options.submission === undefined ? {} : { submission: options.submission }),
          toolCallId: options.toolCallId,
          receipt: gatekeeper.receipt,
          ...(typeof courtAttemptId === "string" && courtAttemptId.trim() !== ""
            ? { courtAttemptId }
            : {}),
          ...(typeof headerId === "string" && headerId.trim() !== ""
            ? { attemptHeaderId: headerId }
            : {}),
        });
      }
      throw new OfficerEscalationParkError(gatekeeper, officerRunDirectory);
    }
    // no_receipt: keep the lifecycle failure channel; continue is an ordinary
    // nonterminal tool result above, not an exception or correctable rejection.
    options.hostActions.bindSubmissionNonPass(options.toolCallId, gatekeeper);
    throw new GatekeeperDecisionError(gatekeeper);
  }
}
