/**
 * The leg's terminal: the last `terminal` row of state.jsonl (#1161), written
 * whole by settlement, last write wins. `error` = a controlled failure,
 * `no_receipt` = the leg ended with no accepted receipt (#836). `report` (an
 * accepted receipt) is written no more (#1299) and is read only from older books.
 * The reader only checks presence and structural readability — it does not
 * re-derive role outcomes or invent a second candidate algorithm.
 */
import { basename } from "node:path";

import { parseRunLeaf } from "./role-run-placement.ts";
import { readPageSync, writeSectionSync } from "./run-dossier.ts";

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

/** Terminal body field naming the court that wrote this terminal (#1161 R2). */
export const TERMINAL_COURT_ATTEMPT_FIELD = "courtAttemptId" as const;

/** Replace the leg's terminal; returns the file the terminal row landed in. */
export function writeRunTerminal(
  runDirectory: string,
  face: Exclude<RunTerminalFace, "report">,
  body: Record<string, unknown>,
): string {
  return writeSectionSync(runDirectory, "terminal", { face, at: new Date().toISOString(), body });
}

/**
 * Read the leg's terminal. Minimum producer-owned face: a typed object body
 * with a nonblank `role` (ADR 0043); anything else is unreadable. Absence is a
 * valid no-receipt state. A damaged state.jsonl throws.
 */
export function readRunTerminal(runDirectory: string): RunTerminalRead {
  const terminal = readPageSync(runDirectory, "terminal");
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
  return { status: "present", face, body };
}

/**
 * Run-directory face is `<runId>@<role>`.
 * Sole authority for runDirectory → runId (last `@` split).
 */
export function runIdFromRunDirectory(runDirectory: string): string | undefined {
  return parseRunLeaf(basename(runDirectory))?.runId;
}

/** Run-directory face → seat role (last `@` split). */
export function roleFromRunDirectory(runDirectory: string): string | undefined {
  return parseRunLeaf(basename(runDirectory))?.role;
}
