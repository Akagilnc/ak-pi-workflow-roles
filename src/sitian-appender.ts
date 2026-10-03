/**
 * Sitian Appender kernel (ADR 0065 / ADR 0086).
 * Computes destination automatically from ledger topology without destination parameters.
 * Log4j-style append-only record sink: appends one row, no deduplication, no read-back, no torn-tail repair.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseRunLeaf, sessionDirectoryOf } from "./role-run-placement.ts";
import { RUN_LOG_FILE } from "./run-dossier.ts";
import { ticketNumberFromSitianSubject } from "./run-ticket-number.ts";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  errorText,
  physicallyContainedIn,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import {
  SitianInfrastructureError,
  type RecordPointer,
  type SitianRecord,
  type SitianRecordInput,
} from "./sitian-contracts.ts";

/** Assign already-recorded lines, preserving their original text and malformed lines. */
export function appendSitianRecordBlock(input: SitianRecordInput, block: string): void {
  if (block === "") return;
  try {
    const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
    ensureRealDirectoryTree(ledgerHome, sessionDir);
    appendFileSync(recordFile, block, "utf8");
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}

/** Volume directory name for a record kind: the kind itself. */
export function resolveSitianVolumeCategory(kind: string): string {
  return kind;
}

type SitianRecordPath = {
  readonly sessionDir: string;
  readonly recordFile: string;
  readonly ledgerHome: string;
};

/** Sole records leaf under every sitian volume directory. */
const SITIAN_RECORDS_LEAF = "records.jsonl" as const;

export function sitianVolumeDirectory(sessionDirectory: string, category: string): string {
  return join(sessionDirectory, category);
}

export function sitianRunVolumeDirectory(runDirectory: string, category: string): string {
  return sitianVolumeDirectory(sessionDirectoryOf(runDirectory), category);
}

export function sitianVolumeRecordsFile(volumeDirectory: string): string {
  return join(volumeDirectory, SITIAN_RECORDS_LEAF);
}

/**
 * Ticket-provenance under-book paths (docs/dossier-topology.md sole authority).
 * Writer ticket branch and owner-visible shape share this join — one code path.
 */
function ticketProvenanceUnderBookPaths(
  ledgerHome: string,
  bookKey: string,
  ticketId: string,
): { sessionDir: string; recordFile: string } {
  const sessionDir = join(activationBookDirectory(ledgerHome, bookKey), ticketId);
  return { sessionDir, recordFile: sitianVolumeRecordsFile(sessionDir) };
}

/** Pure topology owner shared by ambient writes and explicit-home submission reads. */
export function resolveSitianRecordPathInLedger(
  input: SitianRecordInput,
  ledgerHome: string,
): SitianRecordPath {
  const category = resolveSitianVolumeCategory(input.kind);
  const ticketNumber = category === "ticket-provenance"
    ? ticketNumberFromSitianSubject(input.subject)
    : undefined;

  let sessionDir: string;
  let recordFile: string;
  if (ticketNumber !== undefined) {
    // docs/dossier-topology.md: ticket dir holds the unique records.jsonl directly (#900).
    const paths = ticketProvenanceUnderBookPaths(
      ledgerHome,
      resolveBookKeyFromGit(input.cwd ?? process.cwd()),
      ticketNumber,
    );
    sessionDir = paths.sessionDir;
    recordFile = paths.recordFile;
  } else if (category === "ticket-provenance" && input.runDirectory !== undefined) {
    sessionDir = input.runDirectory;
    recordFile = sitianVolumeRecordsFile(sessionDir);
  } else {
    if (
      input.sessionParent === undefined
      || input.sessionParent.length === 0
      || !physicallyContainedIn(ledgerHome, input.sessionParent)
    ) {
      throw new Error("Sitian record ownership requires a parent session inside the ledger home");
    }
    const sessionParentDir = dirname(input.sessionParent);
    const runDirectory = dirname(sessionParentDir);
    if (basename(sessionParentDir) === "session" && parseRunLeaf(basename(runDirectory)) !== undefined) {
      // A role run's own session: every record kind shares the run's one log (#1161).
      sessionDir = runDirectory;
      recordFile = join(runDirectory, RUN_LOG_FILE);
    } else {
      sessionDir = sitianVolumeDirectory(sessionParentDir, category);
      recordFile = sitianVolumeRecordsFile(sessionDir);
    }
  }
  if (!physicallyContainedIn(ledgerHome, sessionDir)) {
    throw new Error("Sitian record ownership requires a directory inside the ledger home");
  }

  return { sessionDir, recordFile, ledgerHome };
}

/** Compute a write destination from ambient ledger topology (ADR 0065). */
export function resolveSitianRecordPath(input: SitianRecordInput): SitianRecordPath {
  const ledgerHome =
    input.home !== undefined && input.home.length > 0
      ? resolveActivationLedgerHome(input.home)
      : resolveActivationLedgerHomeForPath(input.runDirectory ?? input.sessionParent);
  return resolveSitianRecordPathInLedger(input, ledgerHome);
}

/**
 * Appends a canonical record to its self-computed volume under the Sitian contract (ADR 0086).
 * - Log4j-style append-only record sink: O(1) append, unconditionally writes a new line.
 * - Zero read-back, zero per-append identity check / idempotency deduplication.
 * - Zero torn-tail repair.
 * - Commit point: full JSON string ending with newline.
 */
export function appendSitianRecord(input: SitianRecordInput): RecordPointer {
  try {
    const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
    ensureRealDirectoryTree(ledgerHome, sessionDir);

    const identity = input.identity ?? randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();
    const host = input.host ?? "pi";

    const record: SitianRecord = {
      level: input.level,
      kind: input.kind,
      identity,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.sessionParent === undefined ? {} : { sessionParent: input.sessionParent }),
      timestamp,
      host,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    };

    const row = `${JSON.stringify(record)}\n`;
    appendFileSync(recordFile, row, "utf8");
    return {
      identity: record.identity,
      recordFile,
      kind: record.kind,
      level: record.level,
    };
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}
