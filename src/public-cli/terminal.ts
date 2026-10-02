/**
 * Terminal result: typed semantic regions for one admitted Role run (ADR 0052 / #106).
 * Presentation may rearrange labels/order; only regions and typed facts are stable.
 *
 * Free-text cells are JSON-string encoded so legitimate newlines/tabs cannot forge
 * extra rows or shift column boundaries (note / fix.summary / decision question / reason).
 */
import type { NoReceiptLifecycleFacts } from "../receipt-delivery-policy.ts";
import type { ControlledFailureCause } from "../host-contracts.ts";
import type { PackagedRole } from "../packaged-role-registry.ts";
import { serializeThrownValue } from "../serialize-thrown-value.ts";

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
export type TerminalRoleName = PackagedRole;

export type NoReceiptTerminalOutcome = Partial<NoReceiptLifecycleFacts> & {
  kind: "no_receipt";
  role: TerminalRoleName;
  status: "no-accepted-receipt";
  decisiveFacts: Partial<NoReceiptLifecycleFacts> & Readonly<Record<string, unknown>>;
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
       * Omitted when unknown — the original diagnostic retains the fact (#881).
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
 * One admitted Role run's typed Terminal aggregate.
 * autoResumeCount is call-local (#416).
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
  /** Call-local auto-resume observation (0..2) for this single LLM call; read-only, not persisted. */
  autoResumeCount?: number;
} & (
  | {
      runId: string;
      batch?: undefined;
    }
  | {
      /** Deterministic public batch projection; no parent Role run exists. */
      batch: "reviewer";
      runId?: undefined;
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
  // Accepted volumes do not dump decisiveFacts unless a failed attempt is
  // recorded. The unsettled-direction fact still has to be visible on its own.
  // audit_escalation already dumps every decisiveFact below.
  if (
    result.roleOutcome.kind === "accepted"
    && result.roleOutcome.decisiveFacts?.directionUnsettled === true
  ) {
    lines.push("fact\tdirectionUnsettled\ttrue");
    const subsequent = result.roleOutcome.decisiveFacts.subsequentAudit;
    if (typeof subsequent === "string") {
      lines.push(`fact\tsubsequentAudit\t${encodeTerminalField(subsequent)}`);
    }
  }
  if (result.roleOutcome.kind === "failure" || result.roleOutcome.kind === "no_receipt" || result.roleOutcome.kind === "audit_escalation" || result.roleOutcome.decisiveFacts?.failedAttempts !== undefined) {
    const facts = result.roleOutcome.kind === "accepted"
      ? { failedAttempts: result.roleOutcome.decisiveFacts?.failedAttempts }
      : result.roleOutcome.decisiveFacts ?? {};
    for (const [key, value] of Object.entries(facts)) {
      if (value === undefined) continue;
      const rendered =
        typeof value === "string" ? value : serializeThrownValue(value);
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
  if (result.reviewerChildOutcomes !== undefined) {
    for (const axis of ["completeness", "correctness"] as const) {
      const child = result.reviewerChildOutcomes[axis];
      lines.push(`reviewer-child\t${axis}\t${child.exitCode}`);
      if (child.stderr !== undefined && child.stderr !== "") {
        lines.push(`reviewer-child-diagnostic\t${axis}\t${encodeTerminalField(child.stderr)}`);
      }
    }
  }
  if (result.runId !== undefined) {
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
