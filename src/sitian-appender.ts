/**
 * Sitian Appender kernel (ADR 0065 / ADR 0086).
 * Computes destination automatically from ledger topology without destination parameters.
 * Log4j-style append-only record sink: appends one row, no deduplication, no read-back, no torn-tail repair.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Assign already-recorded lines, preserving their original text and malformed lines. */
export function appendSitianRecordBlock(input: SitianRecordInput, block: string): void {
  if (block === "") return;
  try {
    const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
    ensureRealDirectoryTree(ledgerHome, sessionDir);
    appendFileSync(recordFile, "", "utf8");
    const identityOf = (line: string): string | undefined => {
      try {
        const row: unknown = JSON.parse(line);
        return isRecord(row) && typeof row.identity === "string" ? row.identity : undefined;
      } catch {
        return undefined;
      }
    };
    const identities = new Set(readFileSync(recordFile, "utf8").split("\n").map(identityOf).filter((id): id is string => id !== undefined));
    for (const line of block.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const identity = identityOf(line);
      if (identity !== undefined && identities.has(identity)) continue;
      appendFileSync(recordFile, line, "utf8");
      if (identity !== undefined) identities.add(identity);
    }
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian appender persistence failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}

/** Authorized S4 submission ledger kinds that share a common run submission volume. */
export const S4_SUBMISSION_LEDGER_KINDS = new Set([
  "candidate",
  "roundContext",
  "outcome",
  "sealed",
  "post-seal-anomaly"
]);

/** Compute the volume partition key for directory placement. */
export function resolveSitianVolumeCategory(kind: string): string {
  if (S4_SUBMISSION_LEDGER_KINDS.has(kind)) {
    return "submission-ledger";
  }
  return kind;
}

type SitianRecordPath = {
  readonly sessionDir: string;
  readonly recordFile: string;
  readonly ledgerHome: string;
};

/** Sole records leaf under every sitian volume directory. */
const SITIAN_RECORDS_LEAF = "records.jsonl" as const;

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
  return { sessionDir, recordFile: join(sessionDir, SITIAN_RECORDS_LEAF) };
}

/** Pure topology owner shared by ambient writes and explicit-home submission reads. */
export function resolveSitianRecordPathInLedger(
  input: SitianRecordInput,
  ledgerHome: string,
): SitianRecordPath {
  const category = resolveSitianVolumeCategory(input.kind);
  const ticketNumber = category === "ticket-provenance"
    ? typeof input.subject === "string" && /^[1-9][0-9]*$/.test(input.subject)
      ? input.subject
      : typeof input.subject === "object"
        && typeof input.subject.ticketNumber === "number"
        && Number.isSafeInteger(input.subject.ticketNumber)
        && input.subject.ticketNumber > 0
        ? String(input.subject.ticketNumber)
        : undefined
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
    recordFile = join(sessionDir, SITIAN_RECORDS_LEAF);
  } else {
    if (
      input.sessionParent === undefined
      || input.sessionParent.length === 0
      || !physicallyContainedIn(ledgerHome, input.sessionParent)
    ) {
      throw new Error("Sitian record ownership requires a parent session inside the ledger home");
    }
    sessionDir = join(dirname(input.sessionParent), category);
    recordFile = join(sessionDir, SITIAN_RECORDS_LEAF);
  }
  if (!physicallyContainedIn(ledgerHome, sessionDir)) {
    throw new Error("Sitian record ownership requires a directory inside the ledger home");
  }

  return { sessionDir, recordFile, ledgerHome };
}

/**
 * Owner-visible ticket 起居录 path shape via the writer ticket joins
 * (ticketProvenanceUnderBookPaths). Ledger leaf is the package-owned `.ak-roles`
 * name (ADR 0048); variable slots keep owner labels; no fake-home path reverse.
 */
export function projectTicketRecordsPathShape(): string {
  const { recordFile } = ticketProvenanceUnderBookPaths(
    join("~", ".ak-roles"),
    "<簿>",
    "<票号>",
  );
  return recordFile.replace(/\\/g, "/");
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
      ...(input.priorEventId === undefined ? {} : { priorEventId: input.priorEventId }),
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
