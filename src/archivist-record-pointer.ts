import { basename, join } from "node:path";
import { isRecord } from "./unknown-value.ts";
import { latestOfficerPointersFromRecords, RUN_HISTORY_FILE } from "./run-dossier.ts";
import { OFFICER_POINTER_RECORD_KIND } from "./run-dossier-files.ts";
import { readSitianRecords, reportRunRecord } from "./sitian-facade.ts";

import { homeFromRunDirectory } from "./activation-ledger-topology.ts";
import { findRunDirectoryById, readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { rewriteRunDirectoryPathValue } from "./role-run-relocation.ts";
import { parseRunLeaf, runDirectoryOfSessionFile } from "./role-run-placement.ts";

/** Typed parent-side pointer to an independent officer run 正本 (ADR 0079 / #675). */
export const DIRECT_OFFICER_RUN_POINTER_KIND = "direct-officer-run-pointer" as const;

export type DirectOfficerRunPointer = {
  readonly version: 1;
  readonly kind: typeof DIRECT_OFFICER_RUN_POINTER_KIND;
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  /** Absolute path to the officer session.jsonl 正本. */
  readonly sessionFile: string;
  /** Officer run directory when known. */
  readonly runDirectory?: string;
  /**
   * Parent submission tool call this officer run was summoned for.
   * Absent on pointers booked before that binding existed.
   */
  readonly submissionToolCallId?: string;
};

/** History record kind of a booked officer pointer (appender routes it to history.jsonl). */
export { OFFICER_POINTER_RECORD_KIND };

/**
 * Book a typed pointer as one history record of the parent run; the settlement
 * seam projects the latest per officer into current.json `officers`.
 * Never fabricates user/assistant/toolResult rows (#675).
 *
 * Latest record wins per officer under one parent (#753 gate-round accounting):
 * a same-parent re-summons supersedes the earlier pointer instead of adding a
 * second one that re-scans the full officer session and multiplies gate-cycle counts.
 */
export function bookDirectOfficerRunPointer(options: {
  readonly parentSessionFile: string;
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  readonly sessionFile: string;
  readonly runDirectory?: string;
  readonly submissionToolCallId?: string;
}): DirectOfficerRunPointer {
  const submissionToolCallId = options.submissionToolCallId?.trim() ?? "";
  const pointer: DirectOfficerRunPointer = {
    version: 1,
    kind: DIRECT_OFFICER_RUN_POINTER_KIND,
    officer: options.officer,
    sessionFile: options.sessionFile,
    ...(options.runDirectory !== undefined && options.runDirectory.trim() !== ""
      ? { runDirectory: options.runDirectory }
      : {}),
    ...(submissionToolCallId === "" ? {} : { submissionToolCallId }),
  };
  reportRunRecord(runDirectoryOfSessionFile(options.parentSessionFile), OFFICER_POINTER_RECORD_KIND, pointer, "submission-gate");
  return pointer;
}

/** Shared strict pointer IO; internal audit wraps unreadability as a re-summons. */
export async function resolveOfficerPointer(
  raw: unknown,
  parentRunDirectory: string,
): Promise<{
  sessionFile: string;
  officer?: DirectOfficerRunPointer["officer"];
  runDirectory?: string;
  submissionToolCallId?: string;
}> {
  const where = `${parentRunDirectory} officers`;
  if (!isRecord(raw) || raw.kind !== DIRECT_OFFICER_RUN_POINTER_KIND || raw.version !== 1) {
    throw new Error(`direct officer run pointer has unknown shape in ${where}`);
  }
  if (typeof raw.sessionFile !== "string" || raw.sessionFile.trim() === "") {
    throw new Error(`direct officer run pointer missing sessionFile in ${where}`);
  }
  const officer = raw.officer === "inspector" || raw.officer === "notary"
    || raw.officer === "auditor" || raw.officer === "countersign" ? raw.officer : undefined;
  let runDirectory = typeof raw.runDirectory === "string" && raw.runDirectory.trim() !== ""
    ? raw.runDirectory : undefined;
  let sessionFile = raw.sessionFile;
  const recordedRunDirectory = runDirectory ?? runDirectoryOfSessionFile(sessionFile);
  const leaf = parseRunLeaf(basename(recordedRunDirectory));
  const parentIdentity = await readRoleRunIdentity(parentRunDirectory);
  if (leaf !== undefined && parentIdentity !== undefined) {
    const currentRunDirectory = await findRunDirectoryById(
      homeFromRunDirectory(parentRunDirectory), leaf.runId, parentIdentity.bookKey, leaf.role,
    );
    if (currentRunDirectory !== undefined) {
      sessionFile = rewriteRunDirectoryPathValue(sessionFile, recordedRunDirectory, currentRunDirectory) as string;
      if (runDirectory !== undefined) runDirectory = currentRunDirectory;
    }
  }
  const submissionToolCallId = typeof raw.submissionToolCallId === "string"
    && raw.submissionToolCallId.trim() !== "" ? raw.submissionToolCallId : undefined;
  return {
    sessionFile,
    ...(officer === undefined ? {} : { officer }),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    ...(submissionToolCallId === undefined ? {} : { submissionToolCallId }),
  };
}

/**
 * The latest pointer booked per officer on one run, as stored. History absent → empty.
 * Canonical malformed diagnostics are not discarded: a damaged officer source must
 * not wash into lawful zero rounds (#1161 O1).
 */
export async function readBookedOfficerPointers(parentRunDirectory: string): Promise<Readonly<Record<string, unknown>>> {
  const { records, diagnostics } = await readSitianRecords(join(parentRunDirectory, RUN_HISTORY_FILE));
  if (diagnostics.length > 0) {
    throw new Error(
      `${RUN_HISTORY_FILE} has ${diagnostics.length} malformed row(s); officer pointers unreadable: ${parentRunDirectory}`,
    );
  }
  return latestOfficerPointersFromRecords(records);
}

/** Every pointer booked on one run, in officer-name order. No pointers → []. */
export async function readOfficerPointers(parentRunDirectory: string): Promise<readonly Awaited<ReturnType<typeof resolveOfficerPointer>>[]> {
  const officers = await readBookedOfficerPointers(parentRunDirectory);
  return Promise.all(
    Object.keys(officers).sort().map((name) => resolveOfficerPointer(officers[name], parentRunDirectory)),
  );
}

/** Missing or unreadable is not a pass: the internal audit caller re-runs the gate. */
export async function readDirectOfficerRunPointer(
  parentSessionFile: string,
  officer: DirectOfficerRunPointer["officer"],
): Promise<DirectOfficerRunPointer | undefined> {
  try {
    const parentRunDirectory = runDirectoryOfSessionFile(parentSessionFile);
    const pointer = await resolveOfficerPointer(
      (await readBookedOfficerPointers(parentRunDirectory))[officer],
      parentRunDirectory,
    );
    if (pointer.officer !== officer) return undefined;
    return { ...pointer, officer, version: 1, kind: DIRECT_OFFICER_RUN_POINTER_KIND };
  } catch {
    return undefined;
  }
}
