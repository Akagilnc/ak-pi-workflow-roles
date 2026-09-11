/**
 * #868 T12: book-root mixed single volumes. Line-by-line (or per session
 * volume) attribution into the owning run; undecidable rows/volumes go to
 * unbound/. Never discard, never silent-merge, never leave at book root.
 */
import type { Dirent } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { WORKER_SUBMISSION_GATE_KIND } from "./archivist-record-entry.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { roleRunPlacement } from "./role-run-placement.ts";
import { readRunTicketNumber } from "./run-ticket-number.ts";

const SITIAN_MIXED_VOLUME_PARTITIONS = [
  "attendance",
  "auditor",
  "dispatch-error",
  "gate",
] as const;

const RUN_LEAF = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9_-]*)$/;
const CURRENT_SESSION_LEDGER = "current-session.json";

type RunLeaf = { readonly runId: string; readonly role: string };

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

function parseRunLeaf(name: string): RunLeaf | undefined {
  const match = RUN_LEAF.exec(name);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
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

/** Last `runs/<leaf>` segment; leaf may be `<runId>@<role>` or bare. */
function runLeafFromPath(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
  const runsIndex = segments.lastIndexOf("runs");
  if (runsIndex < 0 || runsIndex + 1 >= segments.length) return undefined;
  const leaf = segments[runsIndex + 1];
  if (leaf === undefined || leaf === "." || leaf === "..") return undefined;
  return leaf;
}

function runLeafFromRecord(record: Record<string, unknown>): string | undefined {
  for (const path of pathCandidatesFromRecord(record)) {
    const leaf = runLeafFromPath(path);
    if (leaf !== undefined) return leaf;
  }
  return undefined;
}

function runLeafFromVolumeText(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const leaf = runLeafFromRecord(parsed);
      if (leaf !== undefined) return leaf;
    } catch {
      // Volume attribution scans parseable rows only; malformed rows stay in the copied bytes.
    }
  }
  return undefined;
}

function destinationKindFile(
  booksDirectory: string,
  bookKey: string,
  leaf: string | undefined,
  ticketNumber: number | undefined,
  kind: string,
  fileName: string,
): string {
  if (leaf === undefined) {
    return join(booksDirectory, bookKey, "unbound", kind, fileName);
  }
  const parsed = parseRunLeaf(leaf);
  if (parsed !== undefined) {
    const placement = roleRunPlacement(dirname(booksDirectory), {
      bookKey,
      subject: ticketNumber === undefined ? { unbound: true } : { ticketNumber },
      runId: parsed.runId,
      role: parsed.role,
    });
    return join(placement.sessionDirectory, kind, fileName);
  }
  const subject = ticketNumber === undefined ? "unbound" : String(ticketNumber);
  return join(
    booksDirectory,
    bookKey,
    subject,
    "runs",
    leaf,
    "session",
    kind,
    fileName,
  );
}

async function ticketForRunLeaf(
  cache: Map<string, number | undefined>,
  backupBooksDirectory: string,
  bookKey: string,
  leaf: string,
): Promise<number | undefined> {
  const cacheKey = `${bookKey}\0${leaf}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const ticketNumber = await readRunTicketNumber(
    join(backupBooksDirectory, bookKey, "runs", leaf),
  );
  cache.set(cacheKey, ticketNumber);
  return ticketNumber;
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
  let raw: string;
  try {
    raw = await readFile(sourceFile, "utf8");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

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
    if (destinationSessionFile === undefined) {
      const pointedName = basename(pointed);
      for (const [sourcePath, destination] of input.volumeDestinations) {
        if (basename(sourcePath) === pointedName) {
          destinationSessionFile = destination;
          break;
        }
      }
    }
  }

  const pointerFile = destinationSessionFile === undefined
    ? input.unboundPointerFile
    : join(dirname(destinationSessionFile), CURRENT_SESSION_LEDGER);
  await mkdir(dirname(pointerFile), { recursive: true });
  if (sessionFile === undefined) {
    await writeFile(pointerFile, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
    return;
  }
  const rewrittenSessionFile = destinationSessionFile
    ?? join(dirname(input.unboundPointerFile), basename(resolve(input.sourceDir, sessionFile)));
  await writeFile(
    pointerFile,
    `${JSON.stringify({ sessionFile: rewrittenSessionFile })}\n`,
    "utf8",
  );
}

async function migrateSitianMixedVolume(
  partition: (typeof SITIAN_MIXED_VOLUME_PARTITIONS)[number],
  context: BookTopologyMigrationContext,
): Promise<ReturnType<typeof reconcileMigrationPartition>> {
  const outcomes: MigrationItemOutcome[] = [];
  const ticketCache = new Map<string, number | undefined>();
  const { backupBooksDirectory, booksDirectory } = context;

  for (const bookKey of await listBookKeys(backupBooksDirectory)) {
    const sourceDir = join(backupBooksDirectory, bookKey, partition);
    const recordsFile = join(sourceDir, "records.jsonl");
    let text: string;
    try {
      text = await readFile(recordsFile, "utf8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
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
        const dest = destinationKindFile(
          booksDirectory,
          bookKey,
          undefined,
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
        const dest = destinationKindFile(
          booksDirectory,
          bookKey,
          undefined,
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

      const leaf = runLeafFromRecord(parsed);
      const ticketNumber = leaf === undefined
        ? undefined
        : await ticketForRunLeaf(ticketCache, backupBooksDirectory, bookKey, leaf);
      const dest = destinationKindFile(
        booksDirectory,
        bookKey,
        leaf,
        ticketNumber,
        partition,
        "records.jsonl",
      );
      await appendRawLine(dest, row.raw);
      outcomes.push({
        disposition: leaf !== undefined && ticketNumber !== undefined ? "placed" : "unbound",
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
  const ticketCache = new Map<string, number | undefined>();
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

    const volumes = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();
    const volumeDestinations = new Map<string, string>();

    for (const name of volumes) {
      const sourcePath = join(sourceDir, name);
      const source = posixRelative(backupBooksDirectory, sourcePath);
      const text = await readFile(sourcePath, "utf8");
      const leaf = runLeafFromVolumeText(text);
      const ticketNumber = leaf === undefined
        ? undefined
        : await ticketForRunLeaf(ticketCache, backupBooksDirectory, bookKey, leaf);
      const dest = destinationKindFile(
        booksDirectory,
        bookKey,
        leaf,
        ticketNumber,
        kind,
        name,
      );
      await mkdir(dirname(dest), { recursive: true });
      await cp(sourcePath, dest, { preserveTimestamps: true });
      volumeDestinations.set(resolve(sourcePath), dest);
      outcomes.push({
        disposition: leaf !== undefined && ticketNumber !== undefined ? "placed" : "unbound",
        source,
      });
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

  return reconcileMigrationPartition(kind, "entries", outcomes);
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
