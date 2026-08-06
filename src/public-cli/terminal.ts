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
    };

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
 * Present one Terminal result. Layout/wording are free to evolve; tests must
 * consume typed facts via parseTerminalResultRegions / the structured value,
 * not match table prose.
 */
export function formatTerminalResult(result: TerminalResult): string {
  const lines: string[] = [];
  lines.push("role\toutcome\tstatus");
  lines.push(
    `${result.roleOutcome.role}\t${result.roleOutcome.kind}\t${encodeTerminalField(result.roleOutcome.status)}`,
  );
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

/**
 * Typed region extraction from a formatted Terminal result.
 * Contract for tests and machine callers: tab-separated semantic rows, not layout.
 */
export function parseTerminalResultRegions(text: string): {
  role?: string;
  outcomeKind?: string;
  status?: string;
  facts: Record<string, string>;
  navigatorDisposition?: string;
  nextRole?: string;
  nextPhase?: string;
  reason?: string;
  command?: string;
  unavailableSource?: string;
  unavailableReason?: string;
  artifacts: Array<{ kind: string; path: string }>;
  runId?: string;
} {
  const facts: Record<string, string> = {};
  const artifacts: Array<{ kind: string; path: string }> = [];
  let role: string | undefined;
  let outcomeKind: string | undefined;
  let status: string | undefined;
  let navigatorDisposition: string | undefined;
  let nextRole: string | undefined;
  let nextPhase: string | undefined;
  let reason: string | undefined;
  let command: string | undefined;
  let unavailableSource: string | undefined;
  let unavailableReason: string | undefined;
  let runId: string | undefined;

  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("role\t")) continue;
    const cols = line.split("\t");
    const head = cols[0];
    if (head === "fact" && cols[1] !== undefined && cols[2] !== undefined) {
      // Encoded key/value are each one cell; join is belt-and-suspenders if a producer drifts.
      facts[decodeTerminalField(cols[1])] = decodeTerminalField(cols.slice(2).join("\t"));
      continue;
    }
    if (head === "navigator" && cols[1] !== undefined) {
      navigatorDisposition = cols[1];
      continue;
    }
    if (head === "next") {
      nextRole = cols[1];
      nextPhase = cols[2];
      continue;
    }
    if (head === "reason") {
      reason = decodeTerminalField(cols.slice(1).join("\t"));
      continue;
    }
    if (head === "command") {
      command = decodeTerminalField(cols.slice(1).join("\t"));
      continue;
    }
    if (head === "unavailable") {
      unavailableSource = cols[1];
      unavailableReason = decodeTerminalField(cols.slice(2).join("\t"));
      continue;
    }
    if (head === "artifact" && cols[1] !== undefined && cols[2] !== undefined) {
      artifacts.push({
        kind: cols[1],
        path: decodeTerminalField(cols.slice(2).join("\t")),
      });
      continue;
    }
    if (head === "run") {
      runId = decodeTerminalField(cols.slice(1).join("\t"));
      continue;
    }
    // role outcome data row: role \t kind \t status
    if (
      cols.length >= 3 &&
      head !== undefined &&
      !["fact", "navigator", "next", "reason", "command", "unavailable", "artifact", "run"].includes(
        head,
      )
    ) {
      role = cols[0];
      outcomeKind = cols[1];
      status = decodeTerminalField(cols[2]!);
    }
  }
  return {
    ...(role === undefined ? {} : { role }),
    ...(outcomeKind === undefined ? {} : { outcomeKind }),
    ...(status === undefined ? {} : { status }),
    facts,
    ...(navigatorDisposition === undefined ? {} : { navigatorDisposition }),
    ...(nextRole === undefined ? {} : { nextRole }),
    ...(nextPhase === undefined ? {} : { nextPhase }),
    ...(reason === undefined ? {} : { reason }),
    ...(command === undefined ? {} : { command }),
    ...(unavailableSource === undefined ? {} : { unavailableSource }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    artifacts,
    ...(runId === undefined ? {} : { runId }),
  };
}
