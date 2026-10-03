import { basename } from "node:path";
import { isRecord } from "./unknown-value.ts";
import { readSectionSync, writeSectionSync } from "./run-dossier.ts";

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

/**
 * Book a typed pointer in the parent run's current.json `officers` section.
 * Never fabricates user/assistant/toolResult rows (#675).
 *
 * Stable slot per officer under one parent (#753 gate-round accounting):
 * same-parent re-summons upsert the same slot instead of minting N pointers
 * that each re-scan the full officer session and multiply gate-cycle counts.
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
  const parentRunDirectory = runDirectoryOfSessionFile(options.parentSessionFile);
  writeSectionSync(parentRunDirectory, "officers", {
    ...readSectionSync(parentRunDirectory, "officers"),
    [options.officer]: pointer,
  });
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

/** Every pointer booked on one run, in officer-name order. Absent section → []. */
export async function readOfficerPointers(parentRunDirectory: string): Promise<readonly Awaited<ReturnType<typeof resolveOfficerPointer>>[]> {
  const officers = readSectionSync(parentRunDirectory, "officers");
  if (officers === undefined) return [];
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
      readSectionSync(parentRunDirectory, "officers")?.[officer],
      parentRunDirectory,
    );
    if (pointer.officer !== officer) return undefined;
    return { ...pointer, officer, version: 1, kind: DIRECT_OFFICER_RUN_POINTER_KIND };
  } catch {
    return undefined;
  }
}
