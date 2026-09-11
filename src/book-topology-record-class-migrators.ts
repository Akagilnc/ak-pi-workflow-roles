/**
 * #866 (T10): record-class partition migrators (build only; execution is #861).
 *
 * Line-closed placement:
 * - ticket-provenance → <ticket>/ticket-provenance/ by each row's subject
 * - submission-ledger / attempt-history → owning run session/<kind>/ by each row's runId
 * - unknown ownership → unbound/ (never silent discard)
 * - malformed rows → unbound with exact bytes preserved
 * - misplaced rows of these kinds rescanned from foreign partitions by content shape
 */
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  destinationRunDirectory,
  findBookRunDirectory,
  isTicketNumberString,
  resolveMigratingRunTicket,
  runCoordsFromSessionParent,
  runIdFromSubject,
  ticketNumberFromSubject,
  ticketNumberFromUnknown,
} from "./book-topology-migration-placement.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { S4_SUBMISSION_LEDGER_KINDS } from "./sitian-appender.ts";
import { TICKET_PROVENANCE_HUMAN_VIEW } from "./ticket-provenance-contracts.ts";

const TICKET_PROVENANCE = "ticket-provenance";
const SUBMISSION_LEDGER = "submission-ledger";
const ATTEMPT_HISTORY = "attempt-history";
const MISPLACED = "misplaced-record-class";

const HUMAN_VIEW_TICKET_RE = /^#\s*起居录\s*·\s*#([1-9][0-9]*)\b/m;

const MISPLACED_SCAN_PARTITIONS = [
  "auditor-roles",
  "auditor",
  "attendance",
  "dispatch-error",
  "gate",
  "worker-submission-gate",
  "scratchpad",
] as const;

type JsonLine =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly raw: string }
  | { readonly ok: false; readonly raw: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonlLine(raw: string): JsonLine {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return { ok: false, raw };
    return { ok: true, value, raw };
  } catch {
    return { ok: false, raw };
  }
}

function sourceRelative(backupBooksDirectory: string, absolutePath: string): string {
  return relative(backupBooksDirectory, absolutePath).split(sep).join("/");
}

function lineSource(backupBooksDirectory: string, filePath: string, index: number): string {
  return `${sourceRelative(backupBooksDirectory, filePath)}#${index + 1}`;
}

function stableKey(material: string): string {
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

async function readJsonlLines(filePath: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

async function listBookKeys(booksDirectory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(booksDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function existingIdentities(recordFile: string): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const line of await readJsonlLines(recordFile)) {
    if (line.trim() === "") continue;
    const parsed = parseJsonlLine(line);
    if (parsed.ok && typeof parsed.value.identity === "string") {
      identities.add(parsed.value.identity);
    }
  }
  return identities;
}

async function appendRecordLine(recordFile: string, raw: string): Promise<void> {
  await ensureDir(dirname(recordFile));
  const line = raw.endsWith("\n") ? raw : `${raw}\n`;
  const parsed = parseJsonlLine(raw);
  if (parsed.ok && typeof parsed.value.identity === "string") {
    const existing = await existingIdentities(recordFile);
    if (existing.has(parsed.value.identity)) return;
  }
  await appendFile(recordFile, line, "utf8");
}

function roleFromPayload(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload.role === "string" && payload.role.length > 0) {
    return payload.role;
  }
  return undefined;
}

function runIdFromPayload(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.runId === "string" && payload.runId.length > 0
    ? payload.runId
    : undefined;
}

function isSubmissionKind(kind: unknown): boolean {
  return typeof kind === "string" && S4_SUBMISSION_LEDGER_KINDS.has(kind);
}

function recordClassOfKind(
  kind: unknown,
): typeof TICKET_PROVENANCE | typeof SUBMISSION_LEDGER | typeof ATTEMPT_HISTORY | undefined {
  if (kind === TICKET_PROVENANCE) return TICKET_PROVENANCE;
  if (kind === ATTEMPT_HISTORY) return ATTEMPT_HISTORY;
  if (isSubmissionKind(kind)) return SUBMISSION_LEDGER;
  return undefined;
}

async function listFilesRecursive(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && predicate(entry.name)) out.push(path);
    }
  }
  await walk(root);
  return out;
}

async function listVolumeRecordFiles(partitionDir: string): Promise<string[]> {
  const volumes = await readdir(partitionDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return [] as const;
    throw error;
  });
  const files: string[] = [];
  for (const entry of volumes) {
    if (!entry.isDirectory()) continue;
    files.push(join(partitionDir, entry.name, "records.jsonl"));
  }
  return files;
}

function unboundCategoryFile(
  booksDirectory: string,
  bookKey: string,
  category: string,
  key: string,
): string {
  return join(booksDirectory, bookKey, "unbound", category, key, "records.jsonl");
}

async function placeUnboundLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  category: string,
  key: string,
  raw: string,
): Promise<void> {
  await appendRecordLine(unboundCategoryFile(context.booksDirectory, bookKey, category, key), raw);
}

async function resolveRunDestination(
  context: BookTopologyMigrationContext,
  bookKey: string,
  runId: string,
  hints: { readonly role?: string; readonly sessionParent?: unknown },
): Promise<
  | { readonly kind: "run"; readonly runDirectory: string; readonly disposition: "placed" | "unbound" }
  | { readonly kind: "unbound-key"; readonly key: string }
> {
  const destBook = join(context.booksDirectory, bookKey);
  const existingDest = await findBookRunDirectory(destBook, runId);
  if (existingDest !== undefined) {
    const underUnbound = existingDest.runDirectory.includes(`${sep}unbound${sep}runs${sep}`);
    return {
      kind: "run",
      runDirectory: existingDest.runDirectory,
      disposition: underUnbound ? "unbound" : "placed",
    };
  }

  const backupRun = await findBookRunDirectory(join(context.backupBooksDirectory, bookKey), runId);
  if (backupRun !== undefined) {
    const role = backupRun.role;
    const ticketNumber = (await resolveMigratingRunTicket(backupRun.runDirectory)).ticketNumber;
    return {
      kind: "run",
      runDirectory: destinationRunDirectory(
        context.booksDirectory,
        bookKey,
        ticketNumber,
        runId,
        role,
      ),
      disposition: ticketNumber !== undefined ? "placed" : "unbound",
    };
  }

  // No retained run body — keep the row under unbound keyed by runId (or role hint).
  // Never discard solely because the run directory is missing (#852 unbound exit).
  const role = hints.role ?? runCoordsFromSessionParent(hints.sessionParent)?.role;
  const key = role !== undefined ? stableKey(`${runId}@${role}`) : stableKey(runId);
  return { kind: "unbound-key", key };
}

async function placeTicketProvenanceLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  source: string,
  raw: string,
  value: Record<string, unknown> | undefined,
): Promise<MigrationItemOutcome> {
  if (value === undefined) {
    await placeUnboundLine(context, bookKey, TICKET_PROVENANCE, stableKey(raw), raw);
    return { disposition: "unbound", source, malformed: true, malformedRaw: raw };
  }
  const ticketNumber = ticketNumberFromSubject(value.subject);
  if (ticketNumber === undefined) {
    await placeUnboundLine(context, bookKey, TICKET_PROVENANCE, stableKey(raw), raw);
    return { disposition: "unbound", source };
  }
  const dest = join(
    context.booksDirectory,
    bookKey,
    String(ticketNumber),
    TICKET_PROVENANCE,
    "records.jsonl",
  );
  await appendRecordLine(dest, raw);
  return { disposition: "placed", source };
}

async function placeRunOwnedLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  category: typeof SUBMISSION_LEDGER | typeof ATTEMPT_HISTORY,
  source: string,
  raw: string,
  value: Record<string, unknown> | undefined,
): Promise<MigrationItemOutcome> {
  if (value === undefined) {
    await placeUnboundLine(context, bookKey, category, stableKey(raw), raw);
    return { disposition: "unbound", source, malformed: true, malformedRaw: raw };
  }

  const fromParent = runCoordsFromSessionParent(value.sessionParent);
  const runId =
    runIdFromSubject(value.subject)
    ?? runIdFromPayload(value.payload)
    ?? fromParent?.runId;
  if (runId === undefined) {
    await placeUnboundLine(context, bookKey, category, stableKey(raw), raw);
    return { disposition: "unbound", source };
  }

  const role = roleFromPayload(value.payload) ?? fromParent?.role;
  const target = await resolveRunDestination(context, bookKey, runId, {
    ...(role === undefined ? {} : { role }),
    ...(value.sessionParent === undefined ? {} : { sessionParent: value.sessionParent }),
  });

  if (target.kind === "unbound-key") {
    await placeUnboundLine(context, bookKey, category, target.key, raw);
    return { disposition: "unbound", source };
  }

  await appendRecordLine(join(target.runDirectory, "session", category, "records.jsonl"), raw);
  return { disposition: target.disposition, source };
}

async function migrateJsonlFileLines(
  context: BookTopologyMigrationContext,
  bookKey: string,
  filePath: string,
  place: (
    source: string,
    raw: string,
    value: Record<string, unknown> | undefined,
  ) => Promise<MigrationItemOutcome>,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const lines = await readJsonlLines(filePath);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.trim() === "") continue;
    const source = lineSource(context.backupBooksDirectory, filePath, index);
    const parsed = parseJsonlLine(raw);
    outcomes.push(await place(source, raw, parsed.ok ? parsed.value : undefined));
  }
}

async function copyTicketCompanions(
  context: BookTopologyMigrationContext,
  bookKey: string,
  volumeDir: string,
): Promise<void> {
  // Companions follow the ticket resolved from records or human view — not a second authority.
  const lines = await readJsonlLines(join(volumeDir, "records.jsonl"));
  let ticketNumber: number | undefined;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const parsed = parseJsonlLine(raw);
    if (!parsed.ok) continue;
    ticketNumber = ticketNumberFromSubject(parsed.value.subject);
    if (ticketNumber !== undefined) break;
  }
  if (ticketNumber === undefined) {
    try {
      const human = await readFile(join(volumeDir, TICKET_PROVENANCE_HUMAN_VIEW), "utf8");
      const match = HUMAN_VIEW_TICKET_RE.exec(human);
      if (match !== null) ticketNumber = ticketNumberFromUnknown(match[1]);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
  }
  if (ticketNumber === undefined) return;

  const destDir = join(context.booksDirectory, bookKey, String(ticketNumber), TICKET_PROVENANCE);
  await ensureDir(destDir);
  // Empty courts still get a volume face (ADR 0075).
  try {
    await stat(join(destDir, "records.jsonl"));
  } catch {
    await appendFile(join(destDir, "records.jsonl"), "", "utf8");
  }
  for (const name of [TICKET_PROVENANCE_HUMAN_VIEW, "offered-identities.jsonl"] as const) {
    const from = join(volumeDir, name);
    try {
      await stat(from);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      throw error;
    }
    await copyFile(from, join(destDir, name));
  }
}

async function migrateTicketProvenanceBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupBook = join(context.backupBooksDirectory, bookKey);
  const rootFiles = await listVolumeRecordFiles(join(backupBook, TICKET_PROVENANCE));
  for (const filePath of rootFiles) {
    await migrateJsonlFileLines(
      context,
      bookKey,
      filePath,
      (source, raw, value) => placeTicketProvenanceLine(context, bookKey, source, raw, value),
      outcomes,
    );
    await copyTicketCompanions(context, bookKey, dirname(filePath));
  }

  // Partial-nesting era: <ticket>/ticket-provenance/
  const ticketDirs = await readdir(backupBook, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return [] as const;
    throw error;
  });
  for (const entry of ticketDirs) {
    if (!entry.isDirectory() || !isTicketNumberString(entry.name)) continue;
    const nested = join(backupBook, entry.name, TICKET_PROVENANCE, "records.jsonl");
    try {
      await stat(nested);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      throw error;
    }
    await migrateJsonlFileLines(
      context,
      bookKey,
      nested,
      (source, raw, value) => placeTicketProvenanceLine(context, bookKey, source, raw, value),
      outcomes,
    );
    await copyTicketCompanions(context, bookKey, dirname(nested));
  }
}

async function migrateRunOwnedBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  category: typeof SUBMISSION_LEDGER | typeof ATTEMPT_HISTORY,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const files = await listVolumeRecordFiles(join(context.backupBooksDirectory, bookKey, category));
  for (const filePath of files) {
    await migrateJsonlFileLines(
      context,
      bookKey,
      filePath,
      (source, raw, value) => placeRunOwnedLine(context, bookKey, category, source, raw, value),
      outcomes,
    );
  }
}

async function migrateMisplacedBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupBook = join(context.backupBooksDirectory, bookKey);
  for (const partition of MISPLACED_SCAN_PARTITIONS) {
    const files = await listFilesRecursive(join(backupBook, partition), (name) => name.endsWith(".jsonl"));
    for (const filePath of files) {
      const lines = await readJsonlLines(filePath);
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index]!;
        if (raw.trim() === "") continue;
        const source = lineSource(context.backupBooksDirectory, filePath, index);
        const parsed = parseJsonlLine(raw);
        if (!parsed.ok) continue;
        const recordClass = recordClassOfKind(parsed.value.kind);
        if (recordClass === undefined) continue;
        if (recordClass === TICKET_PROVENANCE) {
          outcomes.push(await placeTicketProvenanceLine(context, bookKey, source, raw, parsed.value));
        } else {
          outcomes.push(
            await placeRunOwnedLine(context, bookKey, recordClass, source, raw, parsed.value),
          );
        }
      }
    }
  }
}

async function forEachBook(
  context: BookTopologyMigrationContext,
  body: (bookKey: string) => Promise<void>,
): Promise<void> {
  for (const bookKey of await listBookKeys(context.backupBooksDirectory)) {
    await body(bookKey);
  }
}

export const ticketProvenancePartitionMigrator: BookTopologyPartitionMigrator = {
  partition: TICKET_PROVENANCE,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) => migrateTicketProvenanceBook(context, bookKey, outcomes));
    return reconcileMigrationPartition(TICKET_PROVENANCE, "lines", outcomes);
  },
};

export const submissionLedgerPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: SUBMISSION_LEDGER,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) => migrateRunOwnedBook(context, bookKey, SUBMISSION_LEDGER, outcomes));
    return reconcileMigrationPartition(SUBMISSION_LEDGER, "lines", outcomes);
  },
};

export const attemptHistoryPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: ATTEMPT_HISTORY,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) => migrateRunOwnedBook(context, bookKey, ATTEMPT_HISTORY, outcomes));
    return reconcileMigrationPartition(ATTEMPT_HISTORY, "lines", outcomes);
  },
};

export const misplacedRecordClassPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: MISPLACED,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey) => migrateMisplacedBook(context, bookKey, outcomes));
    return reconcileMigrationPartition(MISPLACED, "lines", outcomes);
  },
};

export const BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ticketProvenancePartitionMigrator,
  submissionLedgerPartitionMigrator,
  attemptHistoryPartitionMigrator,
  misplacedRecordClassPartitionMigrator,
];
