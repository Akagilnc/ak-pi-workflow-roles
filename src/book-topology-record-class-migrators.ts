/**
 * #866 (T10): record-class partition migrators (build only; execution is #861).
 *
 * Line-closed placement by each row's typed kind (never by source directory alone):
 * - ticket-provenance → <ticket>/records.jsonl (live topology; human view cancelled #900)
 * - submission-ledger kinds → owning run session/submission-ledger/
 * - attempt-history → owning run session/attempt-history/
 * - unknown ownership → unbound/ (never silent discard)
 * - malformed → unbound with exact bytes + malformedRows entry
 * - misplaced: any foreign jsonl whose kind is one of the three classes
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  bookHistoricalRoots,
  findPlacedMigratingRun,
  findUniquePrincipalPlacedRun,
  isTicketNumberString,
  listMigrationBookKeys,
  listMigrationDirents,
  runCoordsFromSessionParent,
  runIdFromSubject,
  runRefFromBoundPath,
} from "./book-topology-migration-placement.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { formatRunLeaf, runsSegmentOf } from "./role-run-placement.ts";
import { sitianSubjectTicketNumber } from "./run-ticket-number.ts";
import {
  S4_SUBMISSION_LEDGER_KINDS,
  sitianRunVolumeDirectory,
  sitianVolumeRecordsFile,
  ticketProvenanceRecordFile,
} from "./sitian-appender.ts";
import { rewriteCopiedRunPages } from "./book-topology-runs-migrator.ts";
import { projectTicketProvenanceHeader } from "./ticket-provenance-contracts.ts";

import { sha256Hex } from "./sha256.ts";
import { isRecord, isEnoent } from "./unknown-value.ts";

const TICKET_PROVENANCE = "ticket-provenance";
const SUBMISSION_LEDGER = "submission-ledger";
const ATTEMPT_HISTORY = "attempt-history";
const MISPLACED = "misplaced-record-class";

type RecordClass = typeof TICKET_PROVENANCE | typeof SUBMISSION_LEDGER | typeof ATTEMPT_HISTORY;

type JsonLine =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly raw: string }
  | { readonly ok: false; readonly raw: string };

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
  return sha256Hex(material).slice(0, 32);
}

async function readJsonlLines(filePath: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** One provisional line written to a ticket dest before a bare volume may supersede it. */
type DestLinePlacement = {
  readonly raw: string;
  /** Index into the partition outcomes array — flipped to unbound if bare replaces dest. */
  readonly outcomeIndex: number;
};

/** Append-only placement accounting; identity merging is limited to offered-identity registries. */
class RecordWriteCache {
  private readonly offeredIdentities = new Map<string, Set<string>>();
  /** Dest paths written as whole #901 bare volumes — legacy must not append under them. */
  private readonly bareVolumeFiles = new Set<string>();
  /** Lines currently on a dest that are still claimed `placed` in outcomes. */
  private readonly destPlacements = new Map<string, DestLinePlacement[]>();

  private async load(recordFile: string): Promise<Set<string>> {
    const cached = this.offeredIdentities.get(recordFile);
    if (cached !== undefined) return cached;
    const set = new Set<string>();
    for (const line of await readJsonlLines(recordFile)) {
      if (line.trim() === "") continue;
      const parsed = parseJsonlLine(line);
      if (parsed.ok && typeof parsed.value.identity === "string") set.add(parsed.value.identity);
    }
    this.offeredIdentities.set(recordFile, set);
    return set;
  }

  markBareVolume(recordFile: string): void {
    this.bareVolumeFiles.add(recordFile);
  }

  isBareVolume(recordFile: string): boolean {
    return this.bareVolumeFiles.has(recordFile);
  }

  /**
   * After a bare whole-file write, register its lines so a later bare for the
   * same ticket can rehome them and flip dispositions (multi-bare honesty).
   */
  setDestPlacements(recordFile: string, placements: readonly DestLinePlacement[]): void {
    this.destPlacements.set(recordFile, [...placements]);
  }

  /**
   * Install a bare volume as the sole ticket file. Any lines already placed on
   * this dest (legacy appends or a prior bare) are moved to unbound and their
   * outcomes flipped — report stays honest.
   */
  async replaceWholeBare(
    recordFile: string,
    body: string,
    outcomes: MigrationItemOutcome[],
    unboundFileForRaw: (raw: string) => string,
  ): Promise<void> {
    const prior = this.destPlacements.get(recordFile) ?? [];
    for (const placement of prior) {
      await this.append(unboundFileForRaw(placement.raw), placement.raw);
      const previous = outcomes[placement.outcomeIndex];
      if (previous !== undefined) {
        outcomes[placement.outcomeIndex] = {
          disposition: "unbound",
          source: previous.source,
        };
      }
    }
    this.destPlacements.delete(recordFile);
    await ensureDir(dirname(recordFile));
    const text = body.endsWith("\n") ? body : `${body}\n`;
    await writeFile(recordFile, text, "utf8");
    this.markBareVolume(recordFile);
  }

  async append(
    recordFile: string,
    raw: string,
    options?: { readonly outcomeIndex?: number },
  ): Promise<void> {
    await ensureDir(dirname(recordFile));
    const line = raw.endsWith("\n") ? raw : `${raw}\n`;
    await appendFile(recordFile, line, "utf8");
    // Every claimed placement has a physical row.
    if (options?.outcomeIndex !== undefined && !this.bareVolumeFiles.has(recordFile)) {
      const list = this.destPlacements.get(recordFile) ?? [];
      list.push({ raw, outcomeIndex: options.outcomeIndex });
      this.destPlacements.set(recordFile, list);
    }
  }

  async mergeOfferedIdentity(recordFile: string, raw: string): Promise<void> {
    const parsed = parseJsonlLine(raw);
    if (parsed.ok && typeof parsed.value.identity === "string") {
      const existing = await this.load(recordFile);
      if (existing.has(parsed.value.identity)) return;
      existing.add(parsed.value.identity);
    }
    await this.append(recordFile, raw);
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
    for (const entry of await listMigrationDirents(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && predicate(entry.name)) out.push(path);
    }
  }
  await walk(root);
  return out;
}

/**
 * Home partition sources under one record-class root:
 * - direct `<category>/records.jsonl` (legacy flat book-root volume)
 * - hashed sub-volumes `<category>/<volumeId>/records.jsonl`
 * Both enter the same line-closed placement path; ENOENT yields empty reads.
 */
async function listVolumeRecordFiles(partitionDir: string): Promise<string[]> {
  const files: string[] = [join(partitionDir, "records.jsonl")];
  for (const entry of await listMigrationDirents(partitionDir)) {
    if (!entry.isDirectory()) continue;
    files.push(join(partitionDir, entry.name, "records.jsonl"));
  }
  return files;
}

/**
 * Paths already closed by the three home migrators — including the partition-root
 * direct records.jsonl. Criterion (not a partition name list): root record-class
 * trees and nested ticket-provenance. Run trees are NOT blanket-skipped — wrong-kind
 * rows inside a run must still rehome by content (#866 / #852 §落错).
 */
function isHomeRecordClassRelativePath(relPosix: string): boolean {
  const parts = relPosix.split("/");
  if (parts[0] === TICKET_PROVENANCE || parts[0] === SUBMISSION_LEDGER || parts[0] === ATTEMPT_HISTORY) {
    return true;
  }
  if (parts.length >= 2 && isTicketNumberString(parts[0]!)) {
    // Partial-nest era + live ticket-root volume (records.jsonl at ticket dir).
    if (parts[1] === TICKET_PROVENANCE) return true;
    if (parts.length === 2 && parts[1] === "records.jsonl") return true;
  }
  return false;
}

/** Canonical nested path for a run-owned record class; ticket-provenance is never run-nested. */
function isCanonicalRunNestedRecordFile(relPosix: string, recordClass: RecordClass): boolean {
  if (recordClass === TICKET_PROVENANCE) return false;
  const needle = `/session/${recordClass}/records.jsonl`;
  return relPosix.endsWith(needle) || relPosix.endsWith(needle.slice(1));
}

/**
 * Row already sits at the correct run's canonical nest — #865 carries the file.
 * Path-class alone is not enough: a submission-ledger row under run A that names
 * run B must still rehome (#866 run-principal).
 */
async function isAlreadyHomeUnderOwningRun(
  context: BookTopologyMigrationContext,
  bookKey: string,
  withinBook: string,
  recordClass: RecordClass,
  value: Record<string, unknown>,
): Promise<boolean> {
  if (!isCanonicalRunNestedRecordFile(withinBook, recordClass)) return false;
  const segment = runsSegmentOf(withinBook);
  if (segment === undefined) return false;
  const target = await resolveRecordRunDestination(context, bookKey, value);
  if (target?.kind !== "run") return false;
  const source = await findPlacedMigratingRun(
    context.booksDirectory, bookKey, segment.leaf, segment.sourceRelative,
  );
  return source?.runDirectory === target.runDirectory;
}

function relativePathWithinRun(relPosix: string): string | undefined {
  const segment = runsSegmentOf(relPosix);
  if (segment === undefined) return undefined;
  const parts = relPosix.split("/").filter((part) => part.length > 0);
  if (segment.index + 2 >= parts.length) return undefined;
  return parts.slice(segment.index + 2).join("/");
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
  const hasSessionParent =
    typeof hints.sessionParent === "string" && hints.sessionParent.length > 0;
  const bound = hasSessionParent
    ? runRefFromBoundPath(
      hints.sessionParent,
      bookHistoricalRoots(context.booksDirectory, context.backupBooksDirectory, bookKey),
    )
    : undefined;
  // Path present but not bound to this book: never steal role or unique-run-guess.
  if (hasSessionParent && bound === undefined) {
    return { kind: "unbound-key", key: stableKey(runId) };
  }
  if (bound !== undefined) {
    const existingDest = await findPlacedMigratingRun(
      context.booksDirectory,
      bookKey,
      bound.leaf,
      bound.sourceRelative,
    );
    if (existingDest !== undefined) {
      return {
        kind: "run",
        runDirectory: existingDest.runDirectory,
        disposition: existingDest.disposition,
      };
    }
    return { kind: "unbound-key", key: stableKey(bound.leaf) };
  }
  if (hints.role !== undefined && hints.role.length > 0) {
    const leaf = formatRunLeaf(runId, hints.role);
    const existingDest = await findPlacedMigratingRun(
      context.booksDirectory,
      bookKey,
      leaf,
    );
    if (existingDest !== undefined) {
      return {
        kind: "run",
        runDirectory: existingDest.runDirectory,
        disposition: existingDest.disposition,
      };
    }
    return { kind: "unbound-key", key: stableKey(leaf) };
  }
  // No path, no role: follow only a uniquely matching principal in this book.
  const uniquePrincipal = await findUniquePrincipalPlacedRun(
    context.booksDirectory,
    bookKey,
    runId,
  );
  if (uniquePrincipal !== undefined) {
    return {
      kind: "run",
      runDirectory: uniquePrincipal.runDirectory,
      disposition: uniquePrincipal.disposition,
    };
  }
  return { kind: "unbound-key", key: stableKey(runId) };
}

/** Shared ownership resolution for both placement and the already-home shortcut. */
async function resolveRecordRunDestination(
  context: BookTopologyMigrationContext,
  bookKey: string,
  value: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof resolveRunDestination>> | undefined> {
  const fromParent = runCoordsFromSessionParent(
    value.sessionParent,
    bookHistoricalRoots(context.booksDirectory, context.backupBooksDirectory, bookKey),
  );
  const runId = runIdFromSubject(value.subject) ?? runIdFromPayload(value.payload) ?? fromParent?.runId;
  if (runId === undefined) return undefined;
  const role = roleFromPayload(value.payload);
  return resolveRunDestination(context, bookKey, runId, {
    ...(role === undefined ? {} : { role }),
    ...(value.sessionParent === undefined ? {} : { sessionParent: value.sessionParent }),
  });
}

async function placeTicketProvenanceLine(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  source: string,
  raw: string,
  value: Record<string, unknown> | undefined,
  /** Outcomes length at call time = index of the outcome the caller is about to push. */
  outcomeIndex: number,
): Promise<MigrationItemOutcome> {
  if (value === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)), raw);
    return { disposition: "unbound", source, malformed: true, malformedRaw: raw };
  }
  const ticketNumber = sitianSubjectTicketNumber(value.subject);
  if (ticketNumber === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)), raw);
    return { disposition: "unbound", source };
  }
  const dest = ticketProvenanceRecordFile(
    dirname(context.booksDirectory),
    bookKey,
    String(ticketNumber),
  );
  // Never append legacy SitianRecord under a bare #901 volume (header must stay first).
  if (writes.isBareVolume(dest)) {
    await writes.append(
      unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)),
      raw,
    );
    return { disposition: "unbound", source };
  }
  const existing = await readJsonlLines(dest);
  if (tryBareTicketProvenanceVolume(existing) !== undefined) {
    writes.markBareVolume(dest);
    await writes.append(
      unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)),
      raw,
    );
    return { disposition: "unbound", source };
  }
  await writes.append(dest, raw, { outcomeIndex });
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

  const target = await resolveRecordRunDestination(context, bookKey, value);
  if (target === undefined) {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, category, stableKey(raw)), raw);
    return { disposition: "unbound", source };
  }

  if (target.kind === "unbound-key") {
    await writes.append(unboundCategoryFile(context.booksDirectory, bookKey, category, target.key), raw);
    return { disposition: "unbound", source };
  }

  await writes.append(
    sitianVolumeRecordsFile(sitianRunVolumeDirectory(target.runDirectory, category)),
    raw,
  );
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
  outcomeIndex: number,
): Promise<MigrationItemOutcome> {
  const recordClass = recordClassOfKind(value.kind);
  if (recordClass === TICKET_PROVENANCE) {
    return placeTicketProvenanceLine(context, bookKey, writes, source, raw, value, outcomeIndex);
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

/**
 * #901 bare diary volume: first non-empty line is a header without SitianRecord
 * `kind`. Recognise the whole file as one ticket volume — do not split rows into unbound.
 */
function tryBareTicketProvenanceVolume(
  lines: readonly string[],
): { readonly ticket: number; readonly body: readonly string[] } | undefined {
  const body: string[] = [];
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    body.push(raw);
  }
  if (body.length === 0) return undefined;
  const first = parseJsonlLine(body[0]!);
  if (!first.ok) return undefined;
  // Legacy SitianRecord rows carry a typed kind — leave them to line placement.
  if (recordClassOfKind(first.value.kind) !== undefined) return undefined;
  const header = projectTicketProvenanceHeader(first.value);
  if (header === undefined || header.ticket === null) return undefined;
  return { ticket: header.ticket, body };
}

async function placeBareTicketProvenanceVolume(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  filePath: string,
  bare: { readonly ticket: number; readonly body: readonly string[] },
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const dest = ticketProvenanceRecordFile(
    dirname(context.booksDirectory),
    bookKey,
    String(bare.ticket),
  );
  // Whole-file bare install. Prior dest lines (legacy or earlier bare) rehome to
  // unbound with flipped dispositions — header stays first; no silent erase.
  const body = bare.body.map((raw) => (raw.endsWith("\n") ? raw : `${raw}\n`)).join("");
  await writes.replaceWholeBare(dest, body, outcomes, (raw) =>
    unboundCategoryFile(context.booksDirectory, bookKey, TICKET_PROVENANCE, stableKey(raw)),
  );
  const barePlacements: DestLinePlacement[] = [];
  for (let index = 0; index < bare.body.length; index += 1) {
    const source = lineSource(context.backupBooksDirectory, filePath, index);
    const outcomeIndex = outcomes.length;
    outcomes.push({ disposition: "placed", source });
    barePlacements.push({ raw: bare.body[index]!, outcomeIndex });
  }
  // Register so a later bare for the same ticket can supersede honestly.
  writes.setDestPlacements(dest, barePlacements);
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
  if (fallbackCategory === TICKET_PROVENANCE) {
    const bare = tryBareTicketProvenanceVolume(lines);
    if (bare !== undefined) {
      await placeBareTicketProvenanceVolume(context, bookKey, writes, filePath, bare, outcomes);
      return;
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.trim() === "") continue;
    const source = lineSource(context.backupBooksDirectory, filePath, index);
    const parsed = parseJsonlLine(raw);
    if (!parsed.ok) {
      // Malformed: preserve under the home partition's unbound bucket.
      if (fallbackCategory === TICKET_PROVENANCE) {
        outcomes.push(
          await placeTicketProvenanceLine(
            context,
            bookKey,
            writes,
            source,
            raw,
            undefined,
            outcomes.length,
          ),
        );
      } else {
        outcomes.push(await placeRunOwnedLine(context, bookKey, writes, fallbackCategory, source, raw, undefined));
      }
      continue;
    }
    outcomes.push(
      await placeRecordClassLine(
        context,
        bookKey,
        writes,
        source,
        raw,
        parsed.value,
        fallbackCategory,
        outcomes.length,
      ),
    );
  }
}

const OFFERED_IDENTITIES = "offered-identities.jsonl" as const;

/**
 * Merge offered-identities from one source volume into the destination ticket
 * dir by identity key. Never last-source-wins overwrite of the whole file.
 */
async function mergeOfferedIdentities(
  destDir: string,
  volumeDir: string,
  writes: RecordWriteCache,
): Promise<void> {
  const from = join(volumeDir, OFFERED_IDENTITIES);
  let lines: readonly string[];
  try {
    await stat(from);
    lines = await readJsonlLines(from);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  const destFile = join(destDir, OFFERED_IDENTITIES);
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    await writes.mergeOfferedIdentity(destFile, raw);
  }
}

/** Collect typed ticket numbers present in a source volume's records.jsonl. */
async function ticketNumbersInVolume(volumeDir: string): Promise<number[]> {
  const lines = await readJsonlLines(join(volumeDir, "records.jsonl"));
  const bare = tryBareTicketProvenanceVolume(lines);
  if (bare !== undefined) return [bare.ticket];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const parsed = parseJsonlLine(raw);
    if (!parsed.ok) continue;
    if (recordClassOfKind(parsed.value.kind) !== TICKET_PROVENANCE) continue;
    const ticketNumber = sitianSubjectTicketNumber(parsed.value.subject);
    if (ticketNumber === undefined || seen.has(ticketNumber)) continue;
    seen.add(ticketNumber);
    out.push(ticketNumber);
  }
  return out;
}

async function mergeCompanionsFromVolume(
  context: BookTopologyMigrationContext,
  bookKey: string,
  volumeDir: string,
  writes: RecordWriteCache,
): Promise<void> {
  for (const ticketNumber of await ticketNumbersInVolume(volumeDir)) {
    const destDir = dirname(ticketProvenanceRecordFile(
      dirname(context.booksDirectory),
      bookKey,
      String(ticketNumber),
    ));
    await ensureDir(destDir);
    await mergeOfferedIdentities(destDir, volumeDir, writes);
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
  // listVolumeRecordFiles covers partition-root records.jsonl + hashed sub-volumes.
  const rootFiles = await listVolumeRecordFiles(join(backupBook, category));
  for (const filePath of rootFiles) {
    await migrateJsonlFileByKind(context, bookKey, writes, filePath, category, outcomes);
    if (category === TICKET_PROVENANCE) {
      await mergeCompanionsFromVolume(context, bookKey, dirname(filePath), writes);
    }
  }

  if (category !== TICKET_PROVENANCE) return;

  // One ticket-dir walk: partial-nest <ticket>/ticket-provenance/ and live
  // <ticket>/ root volumes share existence check, line placement, companions.
  for (const entry of await listMigrationDirents(backupBook)) {
    if (!entry.isDirectory() || !isTicketNumberString(entry.name)) continue;
    const ticketDir = join(backupBook, entry.name);
    for (const volumeDir of [
      join(ticketDir, TICKET_PROVENANCE),
      ticketDir,
    ] as const) {
      const recordsFile = join(volumeDir, "records.jsonl");
      try {
        await stat(recordsFile);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      await migrateJsonlFileByKind(context, bookKey, writes, recordsFile, TICKET_PROVENANCE, outcomes);
      await mergeCompanionsFromVolume(context, bookKey, volumeDir, writes);
    }
  }
}

function normalizeJsonlRaw(raw: string): string {
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

/**
 * Drop rehomed rows from the copied source nest by backup line bytes.
 * Run-page rewrite has not touched those copies yet. Rows that were not
 * rehomed stay, including a neighbor whose sessionParent only looks similar.
 */
async function scrubRawLinesFromFile(
  recordFile: string,
  rawLines: ReadonlySet<string>,
): Promise<void> {
  if (rawLines.size === 0) return;
  const lines = await readJsonlLines(recordFile);
  if (lines.length === 0) return;
  const kept: string[] = [];
  let changed = false;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const normalized = normalizeJsonlRaw(raw);
    if (rawLines.has(normalized)) {
      changed = true;
      continue;
    }
    kept.push(normalized);
  }
  if (!changed) return;
  await ensureDir(dirname(recordFile));
  await writeFile(recordFile, kept.join(""), "utf8");
}

/**
 * Foreign jsonl rows whose typed kind is one of the three record classes.
 * Range = whole book minus home partitions (root records.jsonl, hashed volumes,
 * nested ticket-provenance) — those close under the three home migrators so T8
 * does not double-count. Inside runs/: skip only rows already under their typed
 * owning run at the canonical nest (those travel with #865); path-class alone
 * never excuses a cross-run wrong principal. Every other typed row rehomes by
 * content; dest copies at the source nest are scrubbed so a recursive run cp
 * cannot keep a lying duplicate.
 */
async function migrateMisplacedBook(
  context: BookTopologyMigrationContext,
  bookKey: string,
  writes: RecordWriteCache,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  const backupBook = join(context.backupBooksDirectory, bookKey);
  const files = await listFilesRecursive(backupBook, (name) => name.endsWith(".jsonl"));
  // backupRelPath → exact backup lines rehomed out of a source-run nest.
  // Match those bytes, not identity and not a normalized sessionParent.
  const scrubPlans = new Map<string, Set<string>>();

  for (const filePath of files) {
    const rel = sourceRelative(context.backupBooksDirectory, filePath);
    const withinBook = rel.split("/").slice(1).join("/");
    // Home partition roots (incl. direct records.jsonl) are owned by home migrators.
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
      if (await isAlreadyHomeUnderOwningRun(
        context,
        bookKey,
        withinBook,
        recordClass,
        parsed.value,
      )) continue;

      const source = lineSource(context.backupBooksDirectory, filePath, index);
      if (recordClass === TICKET_PROVENANCE) {
        outcomes.push(
          await placeTicketProvenanceLine(
            context,
            bookKey,
            writes,
            source,
            raw,
            parsed.value,
            outcomes.length,
          ),
        );
      } else {
        outcomes.push(
          await placeRunOwnedLine(context, bookKey, writes, recordClass, source, raw, parsed.value),
        );
      }

      if (withinBook.includes("/runs/") || withinBook.startsWith("runs/")) {
        let set = scrubPlans.get(withinBook);
        if (set === undefined) {
          set = new Set<string>();
          scrubPlans.set(withinBook, set);
        }
        set.add(normalizeJsonlRaw(raw));
      }
    }
  }

  // Drop rehomed lines from the source nest in dest (wrong path or wrong principal).
  for (const [withinBook, rawLines] of scrubPlans) {
    const segment = runsSegmentOf(withinBook);
    const withinRun = relativePathWithinRun(withinBook);
    if (segment === undefined || withinRun === undefined) continue;
    const destRun = await findPlacedMigratingRun(
      context.booksDirectory, bookKey, segment.leaf, segment.sourceRelative,
    );
    if (destRun === undefined) continue;
    await scrubRawLinesFromFile(join(destRun.runDirectory, withinRun), rawLines);
  }
}

async function forEachBook(
  context: BookTopologyMigrationContext,
  body: (bookKey: string, writes: RecordWriteCache) => Promise<void>,
): Promise<void> {
  for (const bookKey of await listMigrationBookKeys(context.backupBooksDirectory)) {
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
    await rewriteCopiedRunPages(context);
    return reconcileMigrationPartition(MISPLACED, "lines", outcomes);
  },
};

export const BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ticketProvenancePartitionMigrator,
  submissionLedgerPartitionMigrator,
  attemptHistoryPartitionMigrator,
  misplacedRecordClassPartitionMigrator,
];
