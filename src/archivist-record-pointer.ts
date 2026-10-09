import { basename, join } from "node:path";
import { isRecord } from "./unknown-value.ts";
import { latestOfficerPointersFromRecords, RUN_HISTORY_FILE } from "./run-dossier.ts";
import { OFFICER_POINTER_RECORD_KIND } from "./run-dossier-files.ts";
import { readSitianRecords } from "./sitian-facade.ts";

import { homeFromRunDirectory } from "./activation-ledger-topology.ts";
import { resolveLiveRunDirectoryPath, readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { rewriteRunDirectoryPathValue } from "./role-run-relocation.ts";
import { parseRunLeaf, runDirectoryOfSessionFile } from "./role-run-placement.ts";

/**
 * Historical parent-side pointer shape (ADR 0079 / #675).
 * Production no longer writes these (#1195); retained only so analysts can read
 * already-archived officer volumes. New runs leave officers empty (lawful zero).
 */
export const DIRECT_OFFICER_RUN_POINTER_KIND = "direct-officer-run-pointer" as const;

export type DirectOfficerRunPointer = {
  readonly version: 1;
  readonly kind: typeof DIRECT_OFFICER_RUN_POINTER_KIND;
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  /** Absolute path to the officer session.jsonl 正本. */
  readonly sessionFile: string;
  /** Officer run directory when known. */
  readonly runDirectory?: string;
};

/** History record kind of a booked officer pointer (appender routes it to history.jsonl). */
export { OFFICER_POINTER_RECORD_KIND };

/** Decode one archived pointer; relocates session/run paths when the leaf moved. */
export async function resolveOfficerPointer(
  raw: unknown,
  parentRunDirectory: string,
): Promise<{
  sessionFile: string;
  officer?: DirectOfficerRunPointer["officer"];
  runDirectory?: string;
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
    const currentRunDirectory = await resolveLiveRunDirectoryPath(
      recordedRunDirectory, homeFromRunDirectory(parentRunDirectory), parentIdentity.bookKey,
    );
    if (currentRunDirectory !== undefined) {
      sessionFile = rewriteRunDirectoryPathValue(sessionFile, recordedRunDirectory, currentRunDirectory) as string;
      if (runDirectory !== undefined) runDirectory = currentRunDirectory;
    }
  }
  return {
    sessionFile,
    ...(officer === undefined ? {} : { officer }),
    ...(runDirectory === undefined ? {} : { runDirectory }),
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
