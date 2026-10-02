import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord, errorText } from "./unknown-value.ts";

import { homeFromRunDirectory } from "./activation-ledger-topology.ts";
import { findRunDirectoryById, readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { rewriteRunDirectoryPathValue } from "./role-run-relocation.ts";
import { parseRunLeaf, runDirectoryOfSessionFile, runDirectoryFromSessionDirectory } from "./role-run-placement.ts";
import { sitianVolumeDirectory } from "./sitian-appender.ts";

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

function directOfficerRunPointerFile(
  parentSessionFile: string,
  officer: DirectOfficerRunPointer["officer"],
): string {
  return join(sitianVolumeDirectory(dirname(parentSessionFile), "auditor-roles"), `${officer}.pointer.json`);
}

/**
 * Book a typed pointer under parent session/auditor-roles (same nest owner as
 * createRecordSession). Never fabricates user/assistant/toolResult rows (#675).
 * Directory placement stays with the archivist record entry (ADR 0018 / 0065).
 *
 * Stable leaf per officer under one parent (#753 gate-round accounting):
 * same-parent re-summons upsert the same pointer instead of minting N files that
 * each re-scan the full officer session and multiply gate-cycle counts.
 */
export function bookDirectOfficerRunPointer(options: {
  readonly parentSessionFile: string;
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  readonly sessionFile: string;
  readonly runDirectory?: string;
  readonly submissionToolCallId?: string;
}): DirectOfficerRunPointer {
  const pointerFile = directOfficerRunPointerFile(options.parentSessionFile, options.officer);
  mkdirSync(dirname(pointerFile), { recursive: true });
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
  writeFileSync(
    pointerFile,
    `${JSON.stringify(pointer)}\n`,
    "utf8",
  );
  return pointer;
}

/** Shared strict pointer IO; internal audit wraps unreadability as a re-summons. */
export async function resolveOfficerSessionFromPointerFile(pointerPath: string): Promise<{
  sessionFile: string;
  officer?: DirectOfficerRunPointer["officer"];
  runDirectory?: string;
  submissionToolCallId?: string;
}> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    throw new Error(`direct officer run pointer unreadable in ${pointerPath}: ${errorText(error)}`, { cause: error });
  }
  if (!isRecord(raw) || raw.kind !== DIRECT_OFFICER_RUN_POINTER_KIND || raw.version !== 1) {
    throw new Error(`direct officer run pointer has unknown shape in ${pointerPath}`);
  }
  if (typeof raw.sessionFile !== "string" || raw.sessionFile.trim() === "") {
    throw new Error(`direct officer run pointer missing sessionFile in ${pointerPath}`);
  }
  const officer = raw.officer === "inspector" || raw.officer === "notary"
    || raw.officer === "auditor" || raw.officer === "countersign" ? raw.officer : undefined;
  let runDirectory = typeof raw.runDirectory === "string" && raw.runDirectory.trim() !== ""
    ? raw.runDirectory : undefined;
  let sessionFile = raw.sessionFile;
  const recordedRunDirectory = runDirectory ?? runDirectoryOfSessionFile(sessionFile);
  const leaf = parseRunLeaf(basename(recordedRunDirectory));
  const parentRunDirectory = runDirectoryFromSessionDirectory(dirname(dirname(pointerPath)));
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

/** Missing or unreadable is not a pass: the internal audit caller re-runs the gate. */
export async function readDirectOfficerRunPointer(
  parentSessionFile: string,
  officer: DirectOfficerRunPointer["officer"],
): Promise<DirectOfficerRunPointer | undefined> {
  try {
    const pointer = await resolveOfficerSessionFromPointerFile(directOfficerRunPointerFile(parentSessionFile, officer));
    if (pointer.officer !== officer) return undefined;
    return { ...pointer, officer, version: 1, kind: DIRECT_OFFICER_RUN_POINTER_KIND };
  } catch {
    return undefined;
  }
}
