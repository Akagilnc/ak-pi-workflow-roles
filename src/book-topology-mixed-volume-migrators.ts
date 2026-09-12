/**
 * #868 T12: book-root mixed single volumes. Line-by-line (or per session
 * volume) attribution into the owning run; undecidable rows/volumes go to
 * unbound/. Never discard, never silent-merge, never leave at book root.
 */
import type { Dirent, Stats } from "node:fs";
import { appendFile, cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { pathContainedIn } from "./activation-ledger-topology.ts";
import { WORKER_SUBMISSION_GATE_KIND } from "./archivist-record-entry.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { findPlacedMigratingRun } from "./book-topology-migration-placement.ts";

const SITIAN_MIXED_VOLUME_PARTITIONS = [
  "attendance",
  "auditor",
  "dispatch-error",
  "gate",
] as const;

const CURRENT_SESSION_LEDGER = "current-session.json";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

async function listBookKeys(backupBooksDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(backupBooksDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function addPathCandidate(paths: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
  seen.add(value);
  paths.push(value);
}

/** Path fields that can carry a decidable run leaf (`.../runs/<leaf>/...`). */
function pathCandidatesFromRecord(record: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  addPathCandidate(paths, seen, record.sessionParent);
  addPathCandidate(paths, seen, record.parentSession);
  if (!isRecord(record.payload)) return paths;
  const payload = record.payload;
  addPathCandidate(paths, seen, payload.sessionParent);
  addPathCandidate(paths, seen, payload.parentSession);
  addPathCandidate(paths, seen, payload.sessionFile);
  if (isRecord(payload.parent)) {
    addPathCandidate(paths, seen, payload.parent.sessionFile);
    addPathCandidate(paths, seen, payload.parent.sessionParent);
    addPathCandidate(paths, seen, payload.parent.parentSession);
  }
  if (isRecord(payload.data)) {
    addPathCandidate(paths, seen, payload.data.sessionParent);
    addPathCandidate(paths, seen, payload.data.parentSession);
    addPathCandidate(paths, seen, payload.data.sessionFile);
    addPathCandidate(paths, seen, payload.data.file);
  }
  return paths;
}

function describeFsKind(entry: Dirent | Stats): string {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symbolic link";
  if (entry.isFIFO()) return "FIFO";
  if (entry.isSocket()) return "socket";
  if (entry.isCharacterDevice()) return "character device";
  if (entry.isBlockDevice()) return "block device";
  return "unknown filesystem object";
}

function bookHistoricalRoots(
  booksDirectory: string,
  backupBooksDirectory: string,
  bookKey: string,
): readonly string[] {
  return [join(booksDirectory, bookKey), join(backupBooksDirectory, bookKey)];
}

/** Last `runs/<leaf>` segment; leaf may be `<runId>@<role>` or bare. */
function runLeafFromPath(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
  const runsIndex = segments.lastIndexOf("runs");
  if (runsIndex < 0 || runsIndex + 1 >= segments.length) return undefined;
  const leaf = segments[runsIndex + 1];
  if (leaf === undefined || leaf === "." || leaf === "..") return undefined;
  return leaf;
}

type BoundRunRef = {
  readonly leaf: string;
  readonly sourceRelative: string;
};

/** Bind path evidence to this book's historical roots before taking a run leaf. */
function runRefFromBoundPath(
  path: string,
  bookRoots: readonly string[],
): BoundRunRef | undefined {
  for (const root of bookRoots) {
    const rootResolved = resolve(root);
    const candidate = isAbsolute(path) ? resolve(path) : resolve(rootResolved, path);
    if (candidate === rootResolved || !pathContainedIn(rootResolved, candidate)) continue;
    const rel = relative(rootResolved, candidate).split(sep).join("/");
    const leaf = runLeafFromPath(rel);
    if (leaf === undefined) continue;
    const parts = rel.split("/").filter((part) => part.length > 0);
    const runsIndex = parts.indexOf("runs");
    if (runsIndex < 0 || runsIndex + 1 >= parts.length) continue;
    return { leaf, sourceRelative: parts.slice(0, runsIndex + 2).join("/") };
  }
  return undefined;
}

function runRefFromRecord(
  record: Record<string, unknown>,
  bookRoots: readonly string[],
): BoundRunRef | undefined {
  for (const path of pathCandidatesFromRecord(record)) {
    const ref = runRefFromBoundPath(path, bookRoots);
    if (ref !== undefined) return ref;
  }
  return undefined;
}

async function readRegularBackupFile(path: string): Promise<string | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (!info.isFile()) {
    throw new Error(
      `cannot migrate mixed volume from ${path}: source is a ${describeFsKind(info)}, not a regular file`,
    );
  }
  return readFile(path, "utf8");
}

/**
 * Worker-submission-gate volumes are Pi session files. Ownership is only the
 * session header's parentSession — never later message/payload path fields.
 * Malformed JSONL rows are reported separately; they do not select the leaf.
 */
function inspectWorkerSubmissionGateVolume(
  text: string,
  bookRoots: readonly string[],
): {
  readonly leaf: string | undefined;
  readonly sourceRelative: string | undefined;
  readonly malformedRows: readonly { readonly lineNumber: number; readonly raw: string }[];
} {
  const malformedRows: { lineNumber: number; raw: string }[] = [];
  let firstRecord = true;
  let leaf: string | undefined;
  let sourceRelative: string | undefined;

  for (const row of jsonlRows(text)) {
    const isHeader = firstRecord;
    firstRecord = false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.raw);
    } catch {
      malformedRows.push({ lineNumber: row.lineNumber, raw: row.raw });
      continue;
    }
    if (!isRecord(parsed)) {
      malformedRows.push({ lineNumber: row.lineNumber, raw: row.raw });
      continue;
    }
    // Sole attribution evidence: the first JSONL record's parentSession.
    if (
      isHeader &&
      parsed.type === "session" &&
      typeof parsed.parentSession === "string"
    ) {
      const ref = runRefFromBoundPath(parsed.parentSession, bookRoots);
      leaf = ref?.leaf;
      sourceRelative = ref?.sourceRelative;
    }
  }

  return { leaf, sourceRelative, malformedRows };
}

function volumeDestinationFile(
  booksDirectory: string,
  bookKey: string,
  destRun: { readonly runDirectory: string } | undefined,
  kind: string,
  fileName: string,
): string {
  if (destRun === undefined) {
    return join(booksDirectory, bookKey, "unbound", kind, fileName);
  }
  return join(destRun.runDirectory, "session", kind, fileName);
}

async function placedRunForLeaf(
  cache: Map<string, { runDirectory: string; disposition: "placed" | "unbound" } | undefined>,
  booksDirectory: string,
  bookKey: string,
  leaf: string,
  sourceRelative?: string,
): Promise<{ runDirectory: string; disposition: "placed" | "unbound" } | undefined> {
  const cacheKey = `${bookKey}\0${sourceRelative ?? ""}\0${leaf}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const placed = await findPlacedMigratingRun(
    booksDirectory,
    bookKey,
    leaf,
    sourceRelative,
  );
  cache.set(cacheKey, placed);
  return placed;
}

async function appendRawLine(file: string, raw: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${raw}\n`, "utf8");
}

function jsonlRows(text: string): readonly { lineNumber: number; raw: string }[] {
  const lines = text.split("\n");
  const rows: { lineNumber: number; raw: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (index === lines.length - 1 && raw.length === 0) continue;
    if (!raw.trim()) continue;
    rows.push({ lineNumber: index + 1, raw });
  }
  return rows;
}

async function migrateCurrentSessionPointer(input: {
  readonly sourceDir: string;
  readonly volumeDestinations: ReadonlyMap<string, string>;
  readonly unboundPointerFile: string;
}): Promise<void> {
  const sourceFile = join(input.sourceDir, CURRENT_SESSION_LEDGER);
  const raw = await readRegularBackupFile(sourceFile);
  if (raw === undefined) return;

  let sessionFile: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.sessionFile === "string" && parsed.sessionFile.length > 0) {
      sessionFile = parsed.sessionFile;
    }
  } catch {
    sessionFile = undefined;
  }

  let destinationSessionFile: string | undefined;
  if (sessionFile !== undefined) {
    const pointed = resolve(input.sourceDir, sessionFile);
    destinationSessionFile = input.volumeDestinations.get(pointed)
      ?? input.volumeDestinations.get(sessionFile);
  }

  if (destinationSessionFile === undefined) {
    await mkdir(dirname(input.unboundPointerFile), { recursive: true });
    await writeFile(
      input.unboundPointerFile,
      raw.endsWith("\n") ? raw : `${raw}\n`,
      "utf8",
    );
    return;
  }
  const pointerFile = join(dirname(destinationSessionFile), CURRENT_SESSION_LEDGER);
  await mkdir(dirname(pointerFile), { recursive: true });
  await writeFile(
    pointerFile,
    `${JSON.stringify({ sessionFile: destinationSessionFile })}\n`,
    "utf8",
  );
}

async function migrateSitianMixedVolume(
  partition: (typeof SITIAN_MIXED_VOLUME_PARTITIONS)[number],
  context: BookTopologyMigrationContext,
): Promise<ReturnType<typeof reconcileMigrationPartition>> {
  const outcomes: MigrationItemOutcome[] = [];
  const placedCache = new Map<string, { runDirectory: string; disposition: "placed" | "unbound" } | undefined>();
  const { backupBooksDirectory, booksDirectory } = context;

  for (const bookKey of await listBookKeys(backupBooksDirectory)) {
    const sourceDir = join(backupBooksDirectory, bookKey, partition);
    const recordsFile = join(sourceDir, "records.jsonl");
    const bookRoots = bookHistoricalRoots(booksDirectory, backupBooksDirectory, bookKey);
    const text = await readRegularBackupFile(recordsFile);
    if (text === undefined) {
      await migrateCurrentSessionPointer({
        sourceDir,
        volumeDestinations: new Map(),
        unboundPointerFile: join(
          booksDirectory,
          bookKey,
          "unbound",
          partition,
          CURRENT_SESSION_LEDGER,
        ),
      });
      continue;
    }

    const sourceIdentity = posixRelative(backupBooksDirectory, recordsFile);
    for (const row of jsonlRows(text)) {
      const source = `${sourceIdentity}:${row.lineNumber}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.raw);
      } catch {
        const dest = volumeDestinationFile(
          booksDirectory,
          bookKey,
          undefined,
          partition,
          "records.jsonl",
        );
        await appendRawLine(dest, row.raw);
        outcomes.push({
          disposition: "unbound",
          source,
          malformed: true,
          malformedRaw: row.raw,
        });
        continue;
      }
      if (!isRecord(parsed)) {
        const dest = volumeDestinationFile(
          booksDirectory,
          bookKey,
          undefined,
          partition,
          "records.jsonl",
        );
        await appendRawLine(dest, row.raw);
        outcomes.push({
          disposition: "unbound",
          source,
          malformed: true,
          malformedRaw: row.raw,
        });
        continue;
      }

      const ref = runRefFromRecord(parsed, bookRoots);
      const destRun = ref === undefined
        ? undefined
        : await placedRunForLeaf(
          placedCache,
          booksDirectory,
          bookKey,
          ref.leaf,
          ref.sourceRelative,
        );
      const dest = volumeDestinationFile(
        booksDirectory,
        bookKey,
        destRun,
        partition,
        "records.jsonl",
      );
      await appendRawLine(dest, row.raw);
      outcomes.push({
        disposition: destRun?.disposition === "placed" ? "placed" : "unbound",
        source,
      });
    }

    await migrateCurrentSessionPointer({
      sourceDir,
      volumeDestinations: new Map(),
      unboundPointerFile: join(
        booksDirectory,
        bookKey,
        "unbound",
        partition,
        CURRENT_SESSION_LEDGER,
      ),
    });
  }

  return reconcileMigrationPartition(partition, "lines", outcomes);
}

async function migrateWorkerSubmissionGate(
  context: BookTopologyMigrationContext,
): Promise<ReturnType<typeof reconcileMigrationPartition>> {
  const outcomes: MigrationItemOutcome[] = [];
  const volumeMalformedRows: { source: string; raw: string }[] = [];
  const placedCache = new Map<string, { runDirectory: string; disposition: "placed" | "unbound" } | undefined>();
  const { backupBooksDirectory, booksDirectory } = context;
  const kind = WORKER_SUBMISSION_GATE_KIND;

  for (const bookKey of await listBookKeys(backupBooksDirectory)) {
    const sourceDir = join(backupBooksDirectory, bookKey, kind);
    let entries: Dirent[];
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }

    const bookRoots = bookHistoricalRoots(booksDirectory, backupBooksDirectory, bookKey);
    const volumes = entries
      .filter((entry) => entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();
    const volumeDestinations = new Map<string, string>();

    for (const name of volumes) {
      const sourcePath = join(sourceDir, name);
      const source = posixRelative(backupBooksDirectory, sourcePath);
      const text = await readRegularBackupFile(sourcePath);
      if (text === undefined) continue;
      const inspected = inspectWorkerSubmissionGateVolume(text, bookRoots);
      const destRun = inspected.leaf === undefined
        ? undefined
        : await placedRunForLeaf(
          placedCache,
          booksDirectory,
          bookKey,
          inspected.leaf,
          inspected.sourceRelative,
        );
      const dest = volumeDestinationFile(
        booksDirectory,
        bookKey,
        destRun,
        kind,
        name,
      );
      await mkdir(dirname(dest), { recursive: true });
      await cp(sourcePath, dest, { preserveTimestamps: true });
      volumeDestinations.set(resolve(sourcePath), dest);
      volumeDestinations.set(resolve(join(booksDirectory, bookKey, kind, name)), dest);
      // One outcome per volume keeps the entries closure; bad rows attach below.
      outcomes.push({
        disposition: destRun?.disposition === "placed" ? "placed" : "unbound",
        source,
      });
      for (const bad of inspected.malformedRows) {
        volumeMalformedRows.push({
          source: `${source}:${bad.lineNumber}`,
          raw: bad.raw,
        });
      }
    }

    await migrateCurrentSessionPointer({
      sourceDir,
      volumeDestinations,
      unboundPointerFile: join(
        booksDirectory,
        bookKey,
        "unbound",
        kind,
        CURRENT_SESSION_LEDGER,
      ),
    });
  }

  const report = reconcileMigrationPartition(kind, "entries", outcomes);
  return {
    ...report,
    // Malformed rows are evidence on the volume bytes, not extra entry units.
    malformedRows: [...report.malformedRows, ...volumeMalformedRows],
  };
}

const bookTopologySitianMixedVolumeMigrators: readonly BookTopologyPartitionMigrator[] =
  SITIAN_MIXED_VOLUME_PARTITIONS.map((partition) => ({
    partition,
    migrate: (context) => migrateSitianMixedVolume(partition, context),
  }));

const bookTopologyWorkerSubmissionGateMigrator: BookTopologyPartitionMigrator = {
  partition: WORKER_SUBMISSION_GATE_KIND,
  migrate: migrateWorkerSubmissionGate,
};

export const BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ...bookTopologySitianMixedVolumeMigrators,
  bookTopologyWorkerSubmissionGateMigrator,
];
