/**
 * The leg's terminal: the `terminal` section of current.json (#1161), written
 * whole by settlement, last write wins. `report` = an accepted / escalated
 * receipt, `error` = a controlled failure, `no_receipt` = the leg ended with no
 * accepted receipt (#836). The reader only checks presence and structural
 * readability — it does not re-derive role outcomes or invent a second
 * candidate algorithm.
 */
import { basename } from "node:path";

import { parseRunLeaf } from "./role-run-placement.ts";
import { readHistoryRowsSync, readSectionSync, writeSectionSync } from "./run-dossier.ts";

import { isRecord } from "./unknown-value.ts";

export type RunTerminalFace = "report" | "error" | "no_receipt";

export type RunTerminalRead =
  | { readonly status: "absent" }
  | {
      readonly status: "present";
      readonly face: RunTerminalFace;
      readonly body: Record<string, unknown>;
    }
  | { readonly status: "unreadable"; readonly reason: string };

/** Replace the leg's terminal. */
export function writeRunTerminal(
  runDirectory: string,
  face: RunTerminalFace,
  body: Record<string, unknown>,
): void {
  writeSectionSync(runDirectory, "terminal", { face, at: new Date().toISOString(), body });
}

/**
 * Read the leg's terminal. Minimum producer-owned face: a typed object body
 * with a nonblank `role` (ADR 0043); anything else is unreadable. Absence is a
 * valid no-receipt state. A damaged current.json throws.
 */
export function readRunTerminal(runDirectory: string): RunTerminalRead {
  const terminal = readSectionSync(runDirectory, "terminal");
  if (terminal === undefined) return { status: "absent" };
  const { face, body } = terminal;
  if (face !== "report" && face !== "error" && face !== "no_receipt") {
    return { status: "unreadable", reason: "terminal section has no known face" };
  }
  if (!isRecord(body)) {
    return { status: "unreadable", reason: "terminal body is not a typed object" };
  }
  if (typeof body.role !== "string" || body.role.trim() === "") {
    return { status: "unreadable", reason: "terminal body missing nonblank producer-owned role field" };
  }
  return { status: "present", face, body: face === "report" ? withSubmittedPayloads(runDirectory, body) : body };
}

/**
 * The report's outcome carries the verdict facts only; the role's submitted payloads are not
 * stored a second time. A reader that wants them takes them from the attempt-history row the
 * same settlement appended: the last row of this role, whose outcome holds the payloads.
 */
function withSubmittedPayloads(runDirectory: string, body: Record<string, unknown>): Record<string, unknown> {
  const outcome = body.outcome;
  if (!isRecord(outcome) || outcome.payloads !== undefined) return body;
  for (const row of [...readHistoryRowsSync(runDirectory)].reverse()) {
    if (row.kind !== "attempt-history" || !isRecord(row.payload)) continue;
    const attempt = row.payload.outcome;
    if (isRecord(attempt) && attempt.role === outcome.role && Array.isArray(attempt.payloads)) {
      return { ...body, outcome: { ...outcome, payloads: attempt.payloads } };
    }
  }
  return body;
}

/**
 * Run-directory face is `<runId>@<role>`.
 * Sole authority for runDirectory → runId (last `@` split).
 */
export function runIdFromRunDirectory(runDirectory: string): string | undefined {
  return parseRunLeaf(basename(runDirectory))?.runId;
}
