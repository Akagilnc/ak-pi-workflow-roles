/**
 * #866 (T10): record-class partition migrators (build only; execution is #861).
 *
 * Line-closed placement by each row's typed kind (never by source directory alone):
 * - ticket-provenance → <ticket>/ticket-provenance/
 * - submission-ledger kinds → owning run session/submission-ledger/
 * - attempt-history → owning run session/attempt-history/
 * - unknown ownership → unbound/ (never silent discard)
 * - malformed → unbound with exact bytes + malformedRows entry
 * - misplaced: any foreign jsonl whose kind is one of the three classes
 */
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  destinationRunDirectory,
  findBookRunDirectory,
  isTicketNumberString,
  resolveMigratingRunTicket,
  runCoordsFromSessionParent,
  runIdFromSubject,
  ticketNumberFromSubject,
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

type RecordClass = typeof TICKET_PROVENANCE | typeof SUBMISSION_LEDGER | typeof ATTEMPT_HISTORY;

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

/** Per-destination identity cache — one read per file, O(1) subsequent checks. */
class RecordWriteCache {
  private readonly identities = new Map<string, Set<string>>();

  private async load(recordFile: string): Promise<Set<string>> {
    const cached = this.identities.get(recordFile);
    if (cached !== undefined) return cached;
    const set = new Set<string>();
    for (const line of await readJsonlLines(recordFile)) {
      if (line.trim() === "") continue;
      const parsed = parseJsonlLine(line);
      if (parsed.ok && typeof parsed.value.identity === "string") set.add(parsed.value.identity);
    }
    this.identities.set(recordFile, set);
    return set;
  }

  async append(recordFile: string, raw: string): Promise<void> {
    await ensureDir(dirname(recordFile));
    const line = raw.endsWith("\n") ? raw : `${raw}\n`;
    const parsed = parseJsonlLine(raw);
    if (parsed.ok && typeof parsed.value.identity === "string") {
      const existing = await this.load(recordFile);
      if (existing.has(parsed.value.identity)) return;
      existing.add(parsed.value.identity);
    } else if (!this.identities.has(recordFile)) {
      // Ensure subsequent identity loads see a live map even when first rows lack identity.
      this.identities.set(recordFile, await this.load(recordFile));
    }
    await appendFile(recordFile, line, "utf8");
  }
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

function recordClassOfKind(kind: unknown): RecordClass | undefined {
  if (kind === TICKET_PROVENANCE) return TICKET_PROVENANCE;
  if (kind === ATTEMPT_HISTORY) return ATTEMPT_HISTORY;
  if (typeof kind === "string" && S4_SUBMISSION_LEDGER_KINDS.has(kind)) return SUBMISSION_LEDGER;
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

/**
 * Paths already closed by the three home migrators.
 * Criterion (not a partition name list): root record-class volumes and nested
 * ticket-provenance. Run trees are NOT blanket-skipped — wrong-kind rows inside
 * a run must still rehome by content (#866 / #852 §落错).
 */
function isHomeRecordClassRelativePath(relPosix: string): boolean {
  const parts = relPosix.split("/");
  if (parts[0] === TICKET_PROVENANCE || parts[0] === SUBMISSION_LEDGER || parts[0] === ATTEMPT_HISTORY) {
    return true;
  }
  if (parts.length >= 2 && isTicketNumberString(parts[0]!) && parts[1] === TICKET_PROVENANCE) {
    return true;
  }
  return false;
}

/** Canonical nested path for a run-owned record class; ticket-provenance is never run-nested. */
function isCanonicalRunNestedRecordFile(relPosix: string, recordClass: RecordClass): boolean {
  if (recordClass === TICKET_PROVENANCE) return false;
  const needle = `/session/${recordClass}/records.jsonl`;
  return relPosix.endsWith(needle) || relPosix.endsWith(needle.slice(1));
}

function runCoordsFromRelativePath(relPosix: string): { readonly runId: string; readonly role: string } | undefined {
  const parts = relPosix.split("/");
  const runsIndex = parts.indexOf("runs");
  if (runsIndex < 0 || runsIndex + 1 >= parts.length) return undefined;
  const leaf = parts[runsIndex + 1]!;
  const at = leaf.indexOf("@");
  if (at <= 0 || at === leaf.length - 1) return undefined;
  return { runId: leaf.slice(0, at), role: leaf.slice(at + 1) };
}

/** Typed owning run for a record-class row (subject / payload / sessionParent). */
function owningRunIdFromRecord(value: Record<string, unknown>): string | undefined {
  return (
    runIdFromSubject(value.subject)
    ?? runIdFromPayload(value.payload)
    ?? runCoordsFromSessionParent(value.sessionParent)?.runId
  );
}

/**
 * Row already sits at the correct run's canonical nest — #865 carries the file.
 * Path-class alone is not enough: a submission-ledger row under run A that names
 * run B must still rehome (#866 run-principal).
 */
function isAlreadyHomeUnderOwningRun(
  withinBook: string,
  recordClass: RecordClass,
  value: Record<string, unknown>,
): boolean {
  if (!isCanonicalRunNestedRecordFile(withinBook, recordClass)) return false;
  const pathCoords = runCoordsFromRelativePath(withinBook);
  if (pathCoords === undefined) return false;
  const owningRunId = owningRunIdFromRecord(value);
  return owningRunId !== undefined && owningRunId === pathCoords.runId;
}

function relativePathWithinRun(relPosix: string): string | undefined {
  const parts = relPosix.split("/");
  const runsIndex = parts.indexOf("runs");
  if (runsIndex < 0 || runsIndex + 2 >= parts.length) return undefined;
  return parts.slice(runsIndex + 2).join("/");
}

function unboundCategoryFile(
  booksDirectory: string,
  bookKey: string,
  category: string,
  key: string,
): string {
  return join(booksDirectory, bookKey, "unbound", category, key, "records.jsonl");
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
    const ticketNumber = (await resolveMigratingRunTicket(backupRun.runDirectory)).ticketNumber;
    return {
      kind: "run",
      runDirectory: destinationRunDirectory(
        context.booksDirectory,
        bookKey,
        ticketNumber,
        runId,
        backupRun.role,
      ),
      disposition: ticketNumber !== undefined ? "placed" : "unbound",
    };
  }

  const role = hints.role ?? runCoordsFromSessionParent(hints.sessionParent)?.role;
  const key = role !== undefined ? stableKey(`${runId}@${role}`) : stableKey(runId);
  return { kind: "unbound-key", key };
}

async function placeTicketProvenanceLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  source: string,
  raw: string,
  value: Record<string, unknown> | undefined,
): Promise<MigrationItemOutcome> {
  if (value === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)), raw);
    return { disposition: "unbound", source, malformed: true, malformedRaw: raw };
  }
  const ticketNumber = ticketNumberFromSubject(value.subject);
  if (ticketNumber === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)), raw);
    return { disposition: "unbound", source };
  }
  await writes.append(
    join(context.booksDirectory, bookKey, String(ticketNumber), TICKET_PROVENANCE, "records.jsonl"),
    raw,
  );
  return { disposition: "placed", source };
}

async function placeRunOwnedLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  category: typeof SUBMISSION_LEDGER | typeof ATTEMPT_HISTORY,
  source: string,
  raw: string,
  value: Record<string, unknown> | undefined,
): Promise<MigrationItemOutcome> {
  if (value === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, category, stableKey(raw)), raw);
    return { disposition: "unbound", source, malformed: true, malformedRaw: raw };
  }

  const fromParent = runCoordsFromSessionParent(value.sessionParent);
  const runId =
    runIdFromSubject(value.subject)
    ?? runIdFromPayload(value.payload)
    ?? fromParent?.runId;
  if (runId === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, category, stableKey(raw)), raw);
    return { disposition: "unbound", source };
  }

  const role = roleFromPayload(value.payload) ?? fromParent?.role;
  const target = await resolveRunDestination(context, bookKey, runId, {
    ...(role === undefined ? {} : { role }),
    ...(value.sessionParent === undefined ? {} : { sessionParent: value.sessionParent }),
  });

  if (target.kind === "unbound-key") {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, category, target.key), raw);
    return { disposition: "unbound", source };
  }

  await writes.append(join(target.runDirectory, "session", category, "records.jsonl"), raw);
  return { disposition: target.disposition, source };
}

/** Place one parsed row by its typed kind; unknown kinds fall back to the home category unbound. */
async function placeRecordClassLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  source: string,
  raw: string,
  value: Record<string, unknown>,
  fallbackCategory: RecordClass,
): Promise<MigrationItemOutcome> {
  const recordClass = recordClassOfKind(value.kind);
  if (recordClass === TICKET_PROVENANCE) {
    return placeTicketProvenanceLine(context, bookKey, writes, source, raw, value);
  }
  if (recordClass === SUBMISSION_LEDGER || recordClass === ATTEMPT_HISTORY) {
    return placeRunOwnedLine(context, bookKey, writes, recordClass, source, raw, value);
  }

  // Unknown kind inside a record-class home volume: preserve under that home's unbound.
  await writes.append(
    unboundCategoryFile(context.booksDirectory, bookKey, fallbackCategory, stableKey(raw)),
    raw,
  );
  return { disposition: "unbound", source };
}

async function migrateJsonlFileByKind(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  filePath: string,
  fallbackCategory: RecordClass,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const lines = await readJsonlLines(filePath);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.trim() === "") continue;
    const source = lineSource(context.backupBooksDirectory, filePath, index);
    const parsed = parseJsonlLine(raw);
    if (!parsed.ok) {
      // Malformed: preserve under the home partition's unbound bucket.
      if (fallbackCategory === TICKET_PROVENANCE) {
        outcomes.push(await placeTicketProvenanceLine(context, bookKey, writes, source, raw, undefined));
      } else {
        outcomes.push(await placeRunOwnedLine(context, bookKey, writes, fallbackCategory, source, raw, undefined));
      }
      continue;
    }
    outcomes.push(
      await placeRecordClassLine(context, bookKey, writes, source, raw, parsed.value, fallbackCategory),
    );
  }
}

/**
 * Copy human-view / offered-identities only when typed JSONL already names the
 * ticket. No free-text 起居录.md title parse — ticket identity is typed only.
 */
async function copyTicketCompanions(
  context: BookTopologyMigrationContext,
  bookKey: string,
  volumeDir: string,
): Promise<void> {
  const lines = await readJsonlLines(join(volumeDir, "records.jsonl"));
  let ticketNumber: number | undefined;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const parsed = parseJsonlLine(raw);
    if (!parsed.ok) continue;
    if (recordClassOfKind(parsed.value.kind) !== TICKET_PROVENANCE) continue;
    ticketNumber = ticketNumberFromSubject(parsed.value.subject);
    if (ticketNumber !== undefined) break;
  }
  if (ticketNumber === undefined) return;

  const destDir = join(context.booksDirectory, bookKey, String(ticketNumber), TICKET_PROVENANCE);
  await ensureDir(destDir);
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

async function migrateHomePartitionBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  category: RecordClass,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupBook = join(context.backupBooksDirectory, bookKey);
  const rootFiles = await listVolumeRecordFiles(join(backupBook, category));
  for (const filePath of rootFiles) {
    await migrateJsonlFileByKind(context, bookKey, writes, filePath, category, outcomes);
    if (category === TICKET_PROVENANCE) {
      await copyTicketCompanions(context, bookKey, dirname(filePath));
    }
  }

  if (category !== TICKET_PROVENANCE) return;

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
    await migrateJsonlFileByKind(context, bookKey, writes, nested, TICKET_PROVENANCE, outcomes);
    await copyTicketCompanions(context, bookKey, dirname(nested));
  }
}

/** Rewrite dest file without the given identities (drop wrong-nest copies after rehome). */
async function scrubIdentitiesFromFile(
  recordFile: string,
  identities: ReadonlySet<string>,
): Promise<void> {
  if (identities.size === 0) return;
  const lines = await readJsonlLines(recordFile);
  if (lines.length === 0) return;
  const kept: string[] = [];
  let changed = false;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const parsed = parseJsonlLine(raw);
    if (
      parsed.ok
      && typeof parsed.value.identity === "string"
      && identities.has(parsed.value.identity)
    ) {
      changed = true;
      continue;
    }
    kept.push(raw.endsWith("\n") ? raw : `${raw}\n`);
  }
  if (!changed) return;
  await ensureDir(dirname(recordFile));
  await writeFile(recordFile, kept.join(""), "utf8");
}

/**
 * Foreign jsonl rows whose typed kind is one of the three record classes.
 * Range = whole book minus home volumes. Inside runs/: skip only rows already
 * under their typed owning run at the canonical nest (those travel with #865);
 * path-class alone never excuses a cross-run wrong principal. Every other typed
 * row rehomes by content; dest copies at the source nest are scrubbed so a
 * recursive run cp cannot keep a lying duplicate.
 */
async function migrateMisplacedBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupBook = join(context.backupBooksDirectory, bookKey);
  const files = await listFilesRecursive(backupBook, (name) => name.endsWith(".jsonl"));
  // backupRelPath → identities rehomed out of a source-run nest (wrong path or wrong principal)
  const scrubPlans = new Map<string, Set<string>>();

  for (const filePath of files) {
    const rel = sourceRelative(context.backupBooksDirectory, filePath);
    const withinBook = rel.split("/").slice(1).join("/");
    if (isHomeRecordClassRelativePath(withinBook)) continue;

    const lines = await readJsonlLines(filePath);
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index]!;
      if (raw.trim() === "") continue;
      const parsed = parseJsonlLine(raw);
      if (!parsed.ok) continue;
      const recordClass = recordClassOfKind(parsed.value.kind);
      if (recordClass === undefined) continue;

      // Correct principal + canonical nest — #865 carries the file as-is.
      if (isAlreadyHomeUnderOwningRun(withinBook, recordClass, parsed.value)) continue;

      const source = lineSource(context.backupBooksDirectory, filePath, index);
      if (recordClass === TICKET_PROVENANCE) {
        outcomes.push(await placeTicketProvenanceLine(context, bookKey, writes, source, raw, parsed.value));
      } else {
        outcomes.push(
          await placeRunOwnedLine(context, bookKey, writes, recordClass, source, raw, parsed.value),
        );
      }

      if (
        (withinBook.includes("/runs/") || withinBook.startsWith("runs/"))
        && typeof parsed.value.identity === "string"
      ) {
        let set = scrubPlans.get(withinBook);
        if (set === undefined) {
          set = new Set<string>();
          scrubPlans.set(withinBook, set);
        }
        set.add(parsed.value.identity);
      }
    }
  }

  // Drop rehomed identities from the source nest in dest (wrong path or wrong principal).
  for (const [withinBook, identities] of scrubPlans) {
    const coords = runCoordsFromRelativePath(withinBook);
    const withinRun = relativePathWithinRun(withinBook);
    if (coords === undefined || withinRun === undefined) continue;
    const destRun = await findBookRunDirectory(join(context.booksDirectory, bookKey), coords.runId);
    if (destRun === undefined) continue;
    await scrubIdentitiesFromFile(join(destRun.runDirectory, withinRun), identities);
  }
}

async function forEachBook(
  context: BookTopologyMigrationContext,
  body: (bookKey: string, writes: RecordWriteCache) => Promise<void>,
): Promise<void> {
  for (const bookKey of await listBookKeys(context.backupBooksDirectory)) {
    await body(bookKey, new RecordWriteCache());
  }
}

export const ticketProvenancePartitionMigrator: BookTopologyPartitionMigrator = {
  partition: TICKET_PROVENANCE,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey, writes) =>
      migrateHomePartitionBook(context, bookKey, writes, TICKET_PROVENANCE, outcomes));
    return reconcileMigrationPartition(TICKET_PROVENANCE, "lines", outcomes);
  },
};

export const submissionLedgerPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: SUBMISSION_LEDGER,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey, writes) =>
      migrateHomePartitionBook(context, bookKey, writes, SUBMISSION_LEDGER, outcomes));
    return reconcileMigrationPartition(SUBMISSION_LEDGER, "lines", outcomes);
  },
};

export const attemptHistoryPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: ATTEMPT_HISTORY,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey, writes) =>
      migrateHomePartitionBook(context, bookKey, writes, ATTEMPT_HISTORY, outcomes));
    return reconcileMigrationPartition(ATTEMPT_HISTORY, "lines", outcomes);
  },
};

export const misplacedRecordClassPartitionMigrator: BookTopologyPartitionMigrator = {
  partition: MISPLACED,
  async migrate(context) {
    const outcomes: MigrationItemOutcome[] = [];
    await forEachBook(context, (bookKey, writes) => migrateMisplacedBook(context, bookKey, writes, outcomes));
    return reconcileMigrationPartition(MISPLACED, "lines", outcomes);
  },
};

export const BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ticketProvenancePartitionMigrator,
  submissionLedgerPartitionMigrator,
  attemptHistoryPartitionMigrator,
  misplacedRecordClassPartitionMigrator,
];
