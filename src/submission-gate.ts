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
import { persistAdmittedAuditedSubmissionToolCallId } from "./public-cli/invocation.ts";
import { readRunParentPath, readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import {
  officerConclusionReask,
  projectGatekeeperRun,
  type GatekeeperSubject,
  type GateOfficer,
  type GateOfficerSummon,
} from "./gatekeeper-role.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";
import { receivedDiscriminator } from "./submission-errors.ts";
import type { ReviewQueueWord } from "./review-submission.ts";
import { deliveryLimitFromConfig } from "./receipt-delivery-policy.ts";

/**
 * Directory of the seat this gate actually summoned — not a nested escalate
 * terminal that public-role-summons may surface on runDirectory (#1195).
 * Walk sourceRunPath upward until role matches the summoned officer.
 */
async function directoryForSummonedOfficer(
  officer: GateOfficer,
  summoned: PublicSummonResult,
): Promise<string | undefined> {
  if (summoned.admitted?.role === officer) {
    return summoned.admitted.runDirectory;
  }
  let dir =
    typeof summoned.runDirectory === "string" && summoned.runDirectory.trim() !== ""
      ? summoned.runDirectory
      : summoned.admitted?.runDirectory;
  for (let hop = 0; hop < 8 && dir !== undefined; hop += 1) {
    const identity = await readRoleRunIdentity(dir);
    if (identity?.role === officer) return dir;
    const parent = await readRunParentPath(dir);
    if (parent === undefined || parent === dir) break;
    dir = parent;
  }
  return undefined;
}

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
  readonly status: ReviewQueueWord | "needs_reask" | "transport_failure" | "no_receipt";
  readonly officer: GateOfficer;
  readonly receipt: unknown;
  readonly runId?: string;
  readonly runDirectory?: string;
  /** Officer terminal already returned by the summon. Present when the reply was not a queue word. */
  readonly terminal?: TerminalResult;
  /** transport_failure / no_receipt reason from the officer summon/process. */
  readonly reason?: string;
};

/** One place for non-pass / pass gate outcome field expansion (#1214 C1). */
function presentGateOutcome(fields: {
  readonly status: SubmissionGateOutcome["status"];
  readonly officer: GateOfficer;
  readonly receipt: unknown;
  readonly runId?: string | undefined;
  readonly runDirectory?: string | undefined;
  readonly terminal?: TerminalResult | undefined;
  readonly reason?: string | undefined;
}): SubmissionGateOutcome {
  return {
    status: fields.status,
    officer: fields.officer,
    receipt: fields.receipt,
    ...(typeof fields.runId === "string" && fields.runId.trim() !== ""
      ? { runId: fields.runId }
      : {}),
    ...(typeof fields.runDirectory === "string" && fields.runDirectory.trim() !== ""
      ? { runDirectory: fields.runDirectory }
      : {}),
    ...(fields.terminal === undefined ? {} : { terminal: fields.terminal }),
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
  };
}

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
    // #1195 option 1: record parent seal on the summoned seat's admitted-request
    // (not a nested lower terminal that may ride summoned.runDirectory).
    if (
      projected.summoned !== undefined
      && options.toolCallId.trim() !== ""
      && (
        gatekeeper.status === "converged"
        || gatekeeper.status === "continue"
        || gatekeeper.status === "escalate"
        || gatekeeper.status === "needs_reask"
        || gatekeeper.status === "transport_failure"
        || gatekeeper.status === "no_receipt"
      )
    ) {
      const officerRunDirectory = await directoryForSummonedOfficer(
        projected.officer,
        projected.summoned,
      );
      if (officerRunDirectory !== undefined) {
        persistAdmittedAuditedSubmissionToolCallId(officerRunDirectory, options.toolCallId);
      }
    }
    if (gatekeeper.status === "converged") {
      // Keep the officer terminal for escalate / unsettled surfaces; parent
      // finals do not project other-seat tables (#1195).
      return presentGateOutcome({
        status: "converged",
        officer: projected.officer,
        receipt: gatekeeper.receipt,
        runId: gatekeeper.runId,
        runDirectory: projected.summoned?.runDirectory,
        terminal: projected.summoned?.terminal,
      });
    }
    if (gatekeeper.status === "continue") {
      return presentGateOutcome({
        status: "continue",
        officer: projected.officer,
        receipt: gatekeeper.receipt,
        runId: gatekeeper.runId,
      });
    }
    if (gatekeeper.status === "needs_reask") {
      // Nested incomplete already exhausted the inner seat's own reask. Surface it;
      // do not convert into a reask of this outer officer (ADR 0055 / #1195).
      const nestedIncomplete =
        projected.summoned?.terminal?.roleOutcome.kind === "accepted"
        && projected.summoned.terminal.roleOutcome.decisiveFacts?.directionUnsettled === true;
      if (nestedIncomplete || reasksSpent >= reaskLimit) {
        return presentGateOutcome({
          status: "needs_reask",
          officer: projected.officer,
          receipt: gatekeeper.receipt,
          runId: gatekeeper.runId,
          runDirectory: projected.summoned?.runDirectory,
          terminal: projected.summoned?.terminal,
        });
      }
      reasksSpent += 1;
      reask = officerConclusionReask(gatekeeper.receivedStatus);
      continue;
    }
    if (gatekeeper.status === "transport_failure") {
      // #1214 A5: officer process/transport failure stays on the officer run.
      // Present honestly; do not failInfrastructure the parent / audited seat.
      return presentGateOutcome({
        status: "transport_failure",
        officer: projected.officer,
        receipt: gatekeeper.submission ?? { reason: gatekeeper.reason },
        reason: gatekeeper.reason,
        runId: projected.summoned?.terminal?.runId,
        runDirectory: projected.summoned?.runDirectory,
        terminal: projected.summoned?.terminal,
      });
    }
    if (gatekeeper.status === "escalate") {
      // Keep the actual officer terminal so callers resume that seat.
      return presentGateOutcome({
        status: "escalate",
        officer: projected.officer,
        receipt: gatekeeper.receipt,
        runId: gatekeeper.runId,
        runDirectory: projected.summoned?.runDirectory,
        terminal: projected.summoned?.terminal,
      });
    }
    // #1214 F2: lawful officer no_receipt is a typed incomplete outcome, not a
    // call-killing exception. Present honestly; do not bind/throw as non-pass.
    return presentGateOutcome({
      status: "no_receipt",
      officer: projected.officer,
      receipt: gatekeeper.facts ?? { reason: gatekeeper.reason },
      reason: gatekeeper.reason,
      runId: projected.summoned?.terminal?.runId,
      runDirectory: projected.summoned?.runDirectory,
      terminal: projected.summoned?.terminal,
    });
  }
}
