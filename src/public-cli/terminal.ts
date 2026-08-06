/**
 * Terminal result: typed semantic regions for one admitted Role run (ADR 0052 / #106).
 * Presentation may rearrange labels/order; only regions and typed facts are stable.
 *
 * Free-text cells are JSON-string encoded so legitimate newlines/tabs cannot forge
 * extra rows or shift column boundaries (note / fix.summary / decision question / reason).
 */
import { renderPublicAkRoleCommand } from "./command-renderer.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";

/** Encode one free-text Terminal cell. JSON string form cannot embed raw tab/newline. */
export function encodeTerminalField(value: string): string {
  return JSON.stringify(value);
}

/** Decode one free-text Terminal cell produced by encodeTerminalField. */
export function decodeTerminalField(encoded: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new TypeError("terminal free-text field is not valid JSON", { cause: error });
  }
  if (typeof parsed !== "string") {
    throw new TypeError("terminal free-text field must decode to a string");
  }
  return parsed;
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

export type TerminalRoleOutcome =
  | {
      kind: "accepted";
      role: "judge";
      status: string;
      /** Few decisive facts drawn from the typed receipt. */
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "audit_escalation";
      role: "judge";
      status: "audit_escalation";
      decisiveFacts: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "failure";
      role: "judge";
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
  return outcome.kind === "accepted" || outcome.kind === "audit_escalation";
}

export function exitCodeForTerminalOutcome(
  outcome: TerminalRoleOutcome,
): number {
  return isLawfulTypedTerminalOutcome(outcome) ? 0 : 1;
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

export type TerminalResult = {
  roleOutcome: TerminalRoleOutcome;
  navigator: TerminalNavigatorFact;
  artifacts: readonly TerminalArtifactRef[];
  runId: string;
};

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
  lines.push(`run\t${encodeTerminalField(result.runId)}`);
  return `${lines.join("\n")}\n`;
}
