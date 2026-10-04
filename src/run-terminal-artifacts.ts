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

/**
 * Terminal body field naming the `attempt-history` row this settlement appended.
 * Readers resolve submitted payloads by this identity (#1161 甲); they must not
 * pick the last history row of the same role.
 */
export const ATTEMPT_HISTORY_IDENTITY_FIELD = "attemptHistoryIdentity" as const;

/**
 * Terminal body field naming the court that wrote this terminal (#1161 R2).
 * Historical `state.jsonl` terminal rows keep it so a later re-projection of the
 * same court can recover that court's `attemptHistoryIdentity` without reading
 * the leg's latest terminal or guessing by payload.
 */
export const TERMINAL_COURT_ATTEMPT_FIELD = "courtAttemptId" as const;

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
  if (face !== "report") return { status: "present", face, body };
  const resolved = withSubmittedPayloads(runDirectory, body);
  if (resolved.status === "unreadable") return resolved;
  return { status: "present", face, body: resolved.body };
}

/**
 * The report's outcome carries the verdict facts only; the role's submitted payloads are not
 * stored a second time. A reader that wants them takes them from the attempt-history row this
 * settlement named on the terminal body (`attemptHistoryIdentity`). When payloads are absent
 * and that identity is missing or cannot supply them, the gap is unreadable — never a silent
 * present body (#1161 R2-gap).
 */
function withSubmittedPayloads(
  runDirectory: string,
  body: Record<string, unknown>,
):
  | { readonly status: "present"; readonly body: Record<string, unknown> }
  | { readonly status: "unreadable"; readonly reason: string } {
  const outcome = body.outcome;
  if (!isRecord(outcome) || outcome.payloads !== undefined) {
    return { status: "present", body };
  }
  const identity = body[ATTEMPT_HISTORY_IDENTITY_FIELD];
  if (typeof identity !== "string" || identity.trim() === "") {
    return {
      status: "unreadable",
      reason: "terminal report has no payloads and no attemptHistoryIdentity",
    };
  }
  for (const row of readHistoryRowsSync(runDirectory)) {
    if (row.kind !== "attempt-history" || row.identity !== identity || !isRecord(row.payload)) continue;
    const attempt = row.payload.outcome;
    if (isRecord(attempt) && Array.isArray(attempt.payloads)) {
      return {
        status: "present",
        body: { ...body, outcome: { ...outcome, payloads: attempt.payloads } },
      };
    }
  }
  return {
    status: "unreadable",
    reason: `terminal attemptHistoryIdentity ${identity} has no readable attempt-history payloads`,
  };
}

/**
 * Run-directory face is `<runId>@<role>`.
 * Sole authority for runDirectory → runId (last `@` split).
 */
export function runIdFromRunDirectory(runDirectory: string): string | undefined {
  return parseRunLeaf(basename(runDirectory))?.runId;
}
