/**
 * Terminal result: typed semantic regions for one admitted Role run (ADR 0052 / #106).
 * Presentation may rearrange labels/order; only regions and typed facts are stable.
 *
 * Free-text cells are JSON-string encoded so legitimate newlines/tabs cannot forge
 * extra rows or shift column boundaries (note / fix.summary / decision question / reason).
 */
import { renderPublicAkRoleCommand } from "./command-renderer.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";
import type { NoReceiptLifecycleFacts } from "../receipt-delivery-policy.ts";
import type { ControlledFailureCause } from "../host-contracts.ts";

export type { ControlledFailureCause } from "../host-contracts.ts";

/** Encode one free-text Terminal cell. JSON string form cannot embed raw tab/newline. */
export function encodeTerminalField(value: string): string {
  return JSON.stringify(value);
}

export type TerminalArtifactRef = {
  kind: "report" | "evidence" | "error";
  /** Openable local reference (path). Layout is private; the ref value is the contract. */
  path: string;
};

/** Public callable roles that currently produce Terminal outcomes. */
export type TerminalRoleName =
  | "judge"
  | "coder"
  | "fixer"
  | "collector"
  | "doctor"
  | "reviewer"
  | "merger"
  | "notary"
  | "countersign"
  | "gleaner-left"
  | "inspector";

/** Merger/Collector residual only — Notary/audit residual abolished (#475). */
export type ResidualIncompleteTerminalOutcome = {
  kind: "incomplete";
  role: "merger" | "collector";
  status: "incomplete";
  decision: "no-usable-result";
  candidate: unknown;
  diagnostic: string;
  acceptedReceipt: false;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

export type NoReceiptTerminalOutcome = NoReceiptLifecycleFacts & {
  kind: "no_receipt";
  role: TerminalRoleName;
  status: "no-accepted-receipt";
  decisiveFacts: NoReceiptLifecycleFacts & Readonly<Record<string, unknown>>;
};

export type TerminalRoleOutcome =
  | {
      kind: "accepted";
      role: TerminalRoleName;
      status: string;
      /** Few decisive facts drawn from the typed receipt. */
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "audit_escalation";
      role: TerminalRoleName;
      status: "audit_escalation";
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | ResidualIncompleteTerminalOutcome
  | NoReceiptTerminalOutcome
  | {
      kind: "failure";
      role: TerminalRoleName;
      /** Typed cause class — never a fabricated role Receipt status. */
      cause: ControlledFailureCause;
      /** Original diagnostic identity retained for the caller. */
      diagnostic: string;
      decisiveFacts: Readonly<Record<string, unknown>>;
    };

/** Lawful typed terminal results exit zero (including audit_escalation). */
export function isLawfulTypedTerminalOutcome(
  outcome: TerminalRoleOutcome,
): boolean {
  return outcome.kind === "accepted" || outcome.kind === "audit_escalation" || outcome.kind === "no_receipt";
}

export function exitCodeForTerminalOutcome(
  outcome: TerminalRoleOutcome,
): number {
  return isLawfulTypedTerminalOutcome(outcome) ? 0 : 1;
}

export function buildResidualIncompleteTerminalOutcome(input: {
  role: "merger" | "collector";
  candidate: unknown;
  diagnostic: string;
}): ResidualIncompleteTerminalOutcome {
  return {
    kind: "incomplete",
    role: input.role,
    status: "incomplete",
    decision: "no-usable-result",
    candidate: input.candidate,
    diagnostic: input.diagnostic,
    acceptedReceipt: false,
    decisiveFacts: {
      decision: "no-usable-result",
      candidate: input.candidate,
      diagnostic: input.diagnostic,
      acceptedReceipt: false,
    },
  };
}

export type TerminalNavigatorFact =
  | {
      disposition: "recommendation";
      next: { role: string; phase: NavigatorPhase };
      reason: string;
      /** Registry-rendered public command — never model prose. */
      command: string;
      route?: ReadonlyArray<{ role: string; phase: NavigatorPhase }>;
      advisoryDiagnostic?: string;
    }
  | {
      disposition: "no-advice";
      advisoryDiagnostic?: string;
    }
  | {
      disposition: "unavailable";
      source: string;
      reason: string;
      advisoryDiagnostic?: string;
    };

/** Present only when a controlled failure is v1-resumable (typed HTTP 429). */
export type TerminalResume = {
  /** Complete public command; run ID is revealed only here. */
  readonly command: string;
};

/** Current English gate seat faces projected on Terminal (#478). */
export type TerminalGateSeat = "gatekeeper" | "inspector" | "notary";

/** One accepted province dispatch receipt (status/officer + optional reduce-seat reason). */
export type TerminalGateDispatch = {
  readonly status: string;
  readonly officer: "inspector" | "notary";
  /** Present only when the accepted dispatch wrote a non-empty reason. */
  readonly reason?: string;
};

/** One accepted officer report: seat, status, full typed findings. */
export type TerminalGateOfficerReport = {
  readonly seat: "inspector" | "notary";
  readonly status: string;
  readonly findings: readonly string[];
};

/** One paired dispatch↔officer gate round on the public Terminal. */
export type TerminalGateRound = {
  readonly roundIndex: number;
  readonly dispatch: TerminalGateDispatch;
  readonly officer: TerminalGateOfficerReport;
};

/**
 * Optional gate province projection (#478).
 * Absent when no accepted paired gate rounds exist (no-gate zero change).
 * Only durable accepted child receipts — never soul-derived expected/missing seats.
 */
export type TerminalGateFact = {
  /** Seats that actually ran, derived from accepted paired receipts. */
  readonly actualSeats: readonly TerminalGateSeat[];
  readonly rounds: readonly TerminalGateRound[];
};

/** Public free-text stand-in when an exact Role run ID is stripped outside resume.command. */
export const REDACTED_RUN_ID_TOKEN = "[run-id]" as const;

/**
 * Remove an exact Role run ID from untrusted free text at the public Terminal boundary.
 * Private durable artifacts keep the original bytes; only resume.command may disclose it.
 */
export function redactExactRunId(text: string, runId: string): string {
  if (runId.length === 0) return text;
  if (!text.includes(runId)) return text;
  return text.split(runId).join(REDACTED_RUN_ID_TOKEN);
}

/**
 * One admitted Role run's typed Terminal aggregate.
 * Resumable failures carry `resume` and must not re-disclose the run ID via
 * top-level `runId` or public artifact path components — only `resume.command`.
 * #416: autoResumeCount (0..2) is a call-local observation of how many in-place
 * auto-resumes occurred during this single LLM call; it is not persisted to
 * run-state.json and does not participate in limit decisions.
 */
export type TerminalResult = {
  roleOutcome: TerminalRoleOutcome;
  navigator: TerminalNavigatorFact;
  artifacts: readonly TerminalArtifactRef[];
  /**
   * Optional gate province facts (#478). Present only when accepted paired
   * gate rounds exist under session/auditor-roles; omitted on no-gate runs.
   */
  gate?: TerminalGateFact;
  /** Call-local auto-resume observation (0..2) for this single LLM call; read-only, not persisted. */
  autoResumeCount?: number;
} & (
  | {
      /** Resumable failure: run ID appears only inside resume.command. */
      resume: TerminalResume;
      runId?: undefined;
    }
  | {
      runId: string;
      resume?: undefined;
    }
);

/**
 * Build a recommendation navigator fact. Command is always registry-rendered;
 * any model-authored command string is ignored.
 */
export function recommendationNavigatorFact(input: {
  next: { role: string; phase: NavigatorPhase };
  reason: string;
  route?: ReadonlyArray<{ role: string; phase: NavigatorPhase }>;
  advisoryDiagnostic?: string;
  /** Ignored — retained only so callers can pass through raw attendance without using it. */
  modelCommand?: string;
}): TerminalNavigatorFact {
  void input.modelCommand;
  const command = renderPublicAkRoleCommand(input.next);
  if (command === undefined) {
    return {
      disposition: "unavailable",
      source: "unknown",
      reason: `recommended role is not a public callable seat: ${input.next.role}`,
    };
  }
  return {
    disposition: "recommendation",
    next: input.next,
    reason: input.reason,
    command,
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.advisoryDiagnostic === undefined ? {} : { advisoryDiagnostic: input.advisoryDiagnostic }),
  };
}

/**
 * Present one Terminal result for humans. Labels, row order, wording, and layout
 * are unfrozen (ADR 0052). Machine consumers and tests must read typed
 * TerminalResult / settlement owners — never bite this presentation.
 */
export function formatTerminalResult(result: TerminalResult): string {
  const lines: string[] = [];
  lines.push("role\toutcome\tstatus");
  const outcomeStatus =
    result.roleOutcome.kind === "failure"
      ? result.roleOutcome.cause
      : result.roleOutcome.status;
  lines.push(
    `${result.roleOutcome.role}\t${result.roleOutcome.kind}\t${encodeTerminalField(outcomeStatus)}`,
  );
  if (result.roleOutcome.kind === "failure") {
    lines.push(
      `diagnostic\t${encodeTerminalField(result.roleOutcome.diagnostic)}`,
    );
  }
  const facts = result.roleOutcome.decisiveFacts;
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    const rendered =
      typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`fact\t${encodeTerminalField(key)}\t${encodeTerminalField(rendered)}`);
  }
  lines.push(`navigator\t${result.navigator.disposition}`);
  if (result.navigator.advisoryDiagnostic !== undefined) {
    lines.push(`navigator-advisory\t${encodeTerminalField(result.navigator.advisoryDiagnostic)}`);
  }
  if (result.navigator.disposition === "recommendation") {
    lines.push(
      `next\t${result.navigator.next.role}\t${result.navigator.next.phase ?? "none"}`,
    );
    lines.push(`reason\t${encodeTerminalField(result.navigator.reason)}`);
    lines.push(`command\t${encodeTerminalField(result.navigator.command)}`);
  } else if (result.navigator.disposition === "unavailable") {
    lines.push(
      `unavailable\t${result.navigator.source}\t${encodeTerminalField(result.navigator.reason)}`,
    );
  }
  for (const artifact of result.artifacts) {
    lines.push(`artifact\t${artifact.kind}\t${encodeTerminalField(artifact.path)}`);
  }
  // Gate region is unfrozen presentation of typed facts (ADR 0052) — machines
  // read result.gate, never these row labels.
  if (result.gate !== undefined) {
    lines.push(
      `gate\t${encodeTerminalField(result.gate.actualSeats.join(","))}\t${result.gate.rounds.length}`,
    );
    for (const round of result.gate.rounds) {
      const reason =
        round.dispatch.reason === undefined
          ? ""
          : encodeTerminalField(round.dispatch.reason);
      lines.push(
        `gate-round\t${round.roundIndex}\t${round.dispatch.status}\t${round.dispatch.officer}\t${reason}\t${round.officer.seat}\t${encodeTerminalField(round.officer.status)}\t${encodeTerminalField(JSON.stringify(round.officer.findings))}`,
      );
    }
  }
  if (result.resume !== undefined) {
    // Resumable failure: run ID is revealed only inside the complete resume command.
    lines.push(`resume\t${encodeTerminalField(result.resume.command)}`);
  } else if (result.runId !== undefined) {
    lines.push(`run\t${encodeTerminalField(result.runId)}`);
  }
  if (result.autoResumeCount !== undefined) {
    lines.push(`autoResumeCount\t${encodeTerminalField(String(result.autoResumeCount))}`);
  }
  return `${lines.join("\n")}\n`;
}
