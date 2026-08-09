/**
 * Terminal result: typed semantic regions for one admitted Role run (ADR 0052 / #106).
 * Presentation may rearrange labels/order; only regions and typed facts are stable.
 *
 * Free-text cells are JSON-string encoded so legitimate newlines/tabs cannot forge
 * extra rows or shift column boundaries (note / fix.summary / decision question / reason).
 */
import { renderPublicAkRoleCommand } from "./command-renderer.ts";
import type { ComplianceAuditIncomplete } from "../compliance-transport.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";

/** Encode one free-text Terminal cell. JSON string form cannot embed raw tab/newline. */
export function encodeTerminalField(value: string): string {
  return JSON.stringify(value);
}

export type TerminalArtifactRef = {
  kind: "report" | "evidence" | "error";
  /** Openable local reference (path). Layout is private; the ref value is the contract. */
  path: string;
};

/** Controlled post-admission failure classes (ADR 0052 / #107). */
export type ControlledFailureCause =
  | "activation"
  | "provider"
  | "session"
  | "output"
  | "timeout"
  | "unrecognized";

/** Public callable roles that currently produce Terminal outcomes. */
export type TerminalRoleName =
  | "judge"
  | "coder"
  | "fixer"
  | "collector"
  | "doctor"
  | "reviewer"
  | "merger";

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

export type AuditIncompleteTerminalOutcome = {
  kind: "audit_incomplete";
  role: TerminalRoleName;
  status: "audit-incomplete";
  decision: "no-usable-decision";
  /** The original role submission arguments, retained independently. */
  roleCandidate: unknown;
  /** The malformed auditor candidate and observation retained by compliance transport. */
  audit: ComplianceAuditIncomplete;
  acceptedReceipt: false;
  decisiveFacts: Readonly<Record<string, unknown>>;
};

/** JSON-safe public stand-in for an omitted tool-call `arguments` member. */
export const JSON_SAFE_UNDEFINED_ARGUMENT = Object.freeze({
  kind: "json-safe-sentinel",
  type: "undefined",
} as const);

export type AuditIncompleteResidual = {
  readonly roleCandidate: unknown;
  readonly audit: ComplianceAuditIncomplete;
  readonly acceptedReceipt: false;
};

export function jsonSafeComplianceCandidate(value: unknown): unknown {
  return value === undefined ? JSON_SAFE_UNDEFINED_ARGUMENT : value;
}

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
  | AuditIncompleteTerminalOutcome
  | ResidualIncompleteTerminalOutcome
  | {
      kind: "failure";
      role: TerminalRoleName;
      /** Typed cause class — never a fabricated role Receipt status. */
      cause: ControlledFailureCause;
      /** Original diagnostic identity retained for the caller. */
      diagnostic: string;
      decisiveFacts: Readonly<Record<string, unknown>>;
      /** Retained audit residual when publication itself failed. */
      auditResidual?: AuditIncompleteResidual;
    };

/** Lawful typed terminal results exit zero (including audit_escalation). */
export function isLawfulTypedTerminalOutcome(
  outcome: TerminalRoleOutcome,
): boolean {
  return outcome.kind === "accepted" || outcome.kind === "audit_escalation";
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

export function buildAuditIncompleteTerminalOutcome(input: {
  role: TerminalRoleName;
  roleCandidate: unknown;
  audit: ComplianceAuditIncomplete;
}): AuditIncompleteTerminalOutcome {
  const roleCandidate = jsonSafeComplianceCandidate(input.roleCandidate);
  const audit = {
    ...input.audit,
    candidate: jsonSafeComplianceCandidate(input.audit.candidate),
  };
  return {
    kind: "audit_incomplete",
    role: input.role,
    status: "audit-incomplete",
    decision: "no-usable-decision",
    roleCandidate,
    audit,
    acceptedReceipt: false,
    decisiveFacts: {
      decision: "no-usable-decision",
      roleCandidate,
      auditCandidate: audit.candidate,
      auditObservation: audit.observation,
      observationKind: audit.observation.kind,
      observationType: audit.observation.kind === "non-object-arguments"
        ? audit.observation.type
        : audit.observation.status,
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
    }
  | {
      disposition: "no-advice";
    }
  | {
      disposition: "unavailable";
      source: string;
      reason: string;
    };

/** Present only when a controlled failure is v1-resumable (typed HTTP 429). */
export type TerminalResume = {
  /** Complete public command; run ID is revealed only here. */
  readonly command: string;
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
 */
export type TerminalResult = {
  roleOutcome: TerminalRoleOutcome;
  navigator: TerminalNavigatorFact;
  artifacts: readonly TerminalArtifactRef[];
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
  if (result.resume !== undefined) {
    // Resumable failure: run ID is revealed only inside the complete resume command.
    lines.push(`resume\t${encodeTerminalField(result.resume.command)}`);
  } else if (result.runId !== undefined) {
    lines.push(`run\t${encodeTerminalField(result.runId)}`);
  }
  return `${lines.join("\n")}\n`;
}
