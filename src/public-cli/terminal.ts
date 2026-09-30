/**
 * Terminal result: typed semantic regions for one admitted Role run (ADR 0052 / #106).
 * Presentation may rearrange labels/order; only regions and typed facts are stable.
 *
 * Free-text cells are JSON-string encoded so legitimate newlines/tabs cannot forge
 * extra rows or shift column boundaries (note / fix.summary / decision question / reason).
 */
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
  | "inspector"
  | "gatekeeper"
  | "navigator"
  | "auditor"
  | "diarist"
  | "secretariat";

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
      /** Original role payloads in ledger order — this is the role-result block (#836 / ADR 0052). */
      payloads?: readonly unknown[];
      /** Fixture/compat leaf only — settlement does not write a selected status. */
      status?: string;
      decisiveFacts?: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "audit_escalation";
      role: TerminalRoleName;
      status: "audit_escalation";
      /** Original role payloads in ledger order (#836). */
      payloads?: readonly unknown[];
      decisiveFacts?: Readonly<Record<string, unknown>>;
    }
  | NoReceiptTerminalOutcome
  | {
      kind: "failure";
      role: TerminalRoleName;
      /**
       * Typed cause class when a typed fact confirms it.
       * Omitted when unknown — original diagnostic + error artifact carry the fact (#881).
       * Never a fabricated "unrecognized" label.
       */
      cause?: ControlledFailureCause;
      /** Original diagnostic identity retained for the caller. */
      diagnostic: string;
      decisiveFacts: Readonly<Record<string, unknown>>;
      /**
       * Optional current-failure payloads (rare intentional face, e.g. reviewer
       * child terminals). Run history does not live here — #836 / #953 keep it
       * on TerminalResult.submissions so receivers can tell it from this failure.
       */
      payloads?: readonly unknown[];
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

export type TerminalNavigatorFact =
  | {
      /** #959: navigator speaks prose; code does not parse or rank the advice. */
      disposition: "advice";
      prose: string;
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

/** Honest discriminant: direct summons vs historical province dispatch. */
export type TerminalGateDispatch =
  | { readonly kind: "direct"; readonly officer: "inspector" | "notary" }
  | {
      readonly kind: "historical_dispatch";
      readonly officer: "inspector" | "notary";
      /** Present only when the accepted dispatch wrote a non-empty reason. */
      readonly reason?: string;
    };

/** One accepted officer report: seat, status, full typed findings. */
export type TerminalGateOfficerReport = {
  readonly seat: "inspector" | "notary";
  readonly status: string;
  readonly findings: readonly unknown[];
};

/** One direct or historical paired gate round on the public Terminal. */
export type TerminalGateRound = {
  readonly roundIndex: number;
  readonly dispatch: TerminalGateDispatch;
  readonly officer: TerminalGateOfficerReport;
};

/**
 * Optional gate projection (#478).
 * Absent when no accepted officer rounds exist. Only durable accepted child
 * receipts — never soul-derived expected/missing seats.
 */
export type TerminalGateFact = {
  /** Seats that actually ran, derived from accepted receipts. */
  readonly actualSeats: readonly TerminalGateSeat[];
  readonly rounds: readonly TerminalGateRound[];
};

/**
 * Parent-facing current reply: a court's own accepted/audit payloads only.
 * Run-scoped history stays on TerminalResult.submissions (#879 / #836), and a
 * failure face never answers as this court's reply (#953).
 */
export function currentReplyRows(terminal: TerminalResult | undefined): readonly unknown[] {
  const outcome = terminal?.roleOutcome;
  return outcome?.kind === "accepted" || outcome?.kind === "audit_escalation"
    ? outcome.payloads ?? []
    : [];
}

/**
 * One admitted Role run's typed Terminal aggregate. Resumable failures disclose
 * the run ID only inside resume.command. autoResumeCount is call-local (#416).
 */
export type TerminalResult = {
  roleOutcome: TerminalRoleOutcome;
  /** Default Reviewer parent: original child Terminals, keyed by frozen axis. */
  reviewerChildren?: Readonly<{
    completeness?: TerminalResult;
    correctness?: TerminalResult;
  }>;
  /** Per-axis summons facts retained even when no child Terminal exists. */
  reviewerChildOutcomes?: Readonly<{
    completeness: { exitCode: number; stderr?: string };
    correctness: { exitCode: number; stderr?: string };
  }>;
  navigator: TerminalNavigatorFact;
  artifacts: readonly TerminalArtifactRef[];
  /**
   * Run-scoped recorded submission history (#836). For accepted/audit this often
   * mirrors roleOutcome.payloads; for failure it is the sole historical carrier
   * (#953 — not copied onto failure.payloads).
   */
  submissions?: readonly unknown[];
  /**
   * Optional gate facts (#478). Present when accepted direct or historical
   * paired rounds exist under session/auditor-roles; omitted on no-gate runs.
   */
  gate?: TerminalGateFact;
  /** Call-local auto-resume observation (0..2) for this single LLM call; read-only, not persisted. */
  autoResumeCount?: number;
} & (
  | {
      /** Resumable failure: run ID appears only inside resume.command. */
      resume: TerminalResume;
      runId?: undefined;
      batch?: undefined;
    }
  | {
      runId: string;
      resume?: undefined;
      batch?: undefined;
    }
  | {
      /** Deterministic public batch projection; no parent Role run exists. */
      batch: "reviewer";
      runId?: undefined;
      resume?: undefined;
    }
);

/**
 * Build an advice navigator fact (#959). Prose is presented as submitted;
 * code does not parse route/next or judge usability.
 */
export function adviceNavigatorFact(input: {
  prose: string;
  advisoryDiagnostic?: string;
}): TerminalNavigatorFact {
  return {
    disposition: "advice",
    prose: input.prose,
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
      ? result.roleOutcome.cause ?? ""
      : result.roleOutcome.kind === "accepted"
        ? "accepted"
        : result.roleOutcome.status;
  lines.push(
    `${result.roleOutcome.role}\t${result.roleOutcome.kind}\t${encodeTerminalField(outcomeStatus)}`,
  );
  if (result.roleOutcome.kind === "failure") {
    lines.push(
      `diagnostic\t${encodeTerminalField(result.roleOutcome.diagnostic)}`,
    );
  }
  if (result.roleOutcome.kind === "failure" || result.roleOutcome.kind === "no_receipt" || result.roleOutcome.kind === "audit_escalation" || result.roleOutcome.decisiveFacts?.failedAttempts !== undefined) {
    const facts = result.roleOutcome.kind === "accepted"
      ? { failedAttempts: result.roleOutcome.decisiveFacts?.failedAttempts }
      : result.roleOutcome.decisiveFacts ?? {};
    for (const [key, value] of Object.entries(facts)) {
      if (value === undefined) continue;
      const rendered =
        typeof value === "string" ? value : JSON.stringify(value);
      lines.push(`fact\t${encodeTerminalField(key)}\t${encodeTerminalField(rendered)}`);
    }
  }
  lines.push(`navigator\t${result.navigator.disposition}`);
  if (result.navigator.advisoryDiagnostic !== undefined) {
    lines.push(`navigator-advisory\t${encodeTerminalField(result.navigator.advisoryDiagnostic)}`);
  }
  if (result.navigator.disposition === "advice") {
    // #959: present navigator prose as-is — no next/reason/command parsing.
    lines.push(`prose\t${encodeTerminalField(result.navigator.prose)}`);
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
        round.dispatch.kind === "historical_dispatch"
        && round.dispatch.reason !== undefined
          ? encodeTerminalField(round.dispatch.reason)
          : "";
      lines.push(
        `gate-round\t${round.roundIndex}\t${round.dispatch.kind}\t${round.dispatch.officer}\t${reason}\t${round.officer.seat}\t${encodeTerminalField(round.officer.status)}\t${encodeTerminalField(JSON.stringify(round.officer.findings))}`,
      );
    }
  }
  if (result.reviewerChildOutcomes !== undefined) {
    for (const axis of ["completeness", "correctness"] as const) {
      const child = result.reviewerChildOutcomes[axis];
      lines.push(`reviewer-child\t${axis}\t${child.exitCode}`);
      if (child.stderr !== undefined && child.stderr !== "") {
        lines.push(`reviewer-child-diagnostic\t${axis}\t${encodeTerminalField(child.stderr)}`);
      }
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
  // Role-result block: original payloads, newest first for humans (#961).
  // Typed payloads/submissions stay ledger order; only this presentation reverses.
  // Present the current result and the run history on distinct faces (#879 / #836).
  // Neither a prior court's submission nor a failed turn's history is this reply.
  const current = result.roleOutcome.kind === "failure"
    ? result.roleOutcome.payloads ?? []
    : currentReplyRows(result);
  for (const [label, rows] of [
    ["submission", current],
    ["recorded-submission", result.submissions ?? []],
  ] as const) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const payload = rows[i]!;
      const rendered = typeof payload === "string" ? payload : JSON.stringify(payload);
      lines.push(`${label}\t${encodeTerminalField(rendered)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
