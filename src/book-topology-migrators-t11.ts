/**
 * #867 T11: migrate auditor-roles and issues/, discard retired kinds and run
 * pages, keep navigator / collector-handbook at book top-level, and move
 * manual archives out of the books home.
 *
 * Partition order below is the registration order: auditor-roles, issues,
 * deprecated-kinds, deprecated-run-pages, navigator, collector-handbook,
 * manual-archives.
 */
import { cp, mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { pathContainedIn } from "./activation-ledger-topology.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationDisposition,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { roleRunPlacement } from "./role-run-placement.ts";
import { readRunTicketNumber } from "./run-ticket-number.ts";

const AUDITOR_ROLES_PARTITION = "auditor-roles";
const ISSUES_PARTITION = "issues";
const DEPRECATED_KINDS_PARTITION = "deprecated-kinds";
const DEPRECATED_RUN_PAGES_PARTITION = "deprecated-run-pages";
const NAVIGATOR_PARTITION = "navigator";
const COLLECTOR_HANDBOOK_PARTITION = "collector-handbook";
const MANUAL_ARCHIVES_PARTITION = "manual-archives";

const TICKET_NUMBER_NAME = /^[1-9][0-9]*$/;
const RUN_LEAF = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9_-]*)$/;
const PARENT_RUN_IN_BOOKS =
  /(?:^|[\\/])\.ak-roles[\\/]books[\\/]([^\\/]+)[\\/]runs[\\/]([^\\/]+)(?:[\\/]|$)/;

const DEPRECATED_KIND_DIRECTORIES = [
  "submission-candidate",
  "submission-outcome",
  "submission-sealed",
  "submission-post-seal-anomaly",
] as const;

const MANUAL_ARCHIVE_DIRECTORIES = ["root-loose", "snapshots", "scratchpad"] as const;

const T10_MISFILED_NAME = "records.jsonl";
const CURRENT_SESSION_LEDGER = "current-session.json";

/** Frozen run-page names T9 must skip when copying whole runs. */
export const DEPRECATED_RUN_PAGE_NAMES = Object.freeze([
  "institutional-resolution.json",
  "capabilities.json",
  "grok-capabilities.json",
] as const);

const DEPRECATED_RUN_PAGE_NAME_SET: ReadonlySet<string> = new Set(DEPRECATED_RUN_PAGE_NAMES);

export function isDeprecatedRunPage(name: string): boolean {
  return DEPRECATED_RUN_PAGE_NAME_SET.has(name);
}

type RunLeaf = { readonly runId: string; readonly role: string };

type ParentRun = {
  readonly bookKey: string;
  readonly leafName: string;
  readonly runId: string;
  readonly role: string;
};

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseRunLeaf(name: string): RunLeaf | undefined {
  const match = RUN_LEAF.exec(name);
  if (match === null) return undefined;
  const runId = match[1];
  const role = match[2];
  if (runId === undefined || role === undefined) return undefined;
  return { runId, role };
}

function sourceIdentity(backupBooksDirectory: string, path: string): string {
  return relative(backupBooksDirectory, path).split(sep).join("/");
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

async function listDirents(directory: string): Promise<readonly Dirent[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function hasAnyFileRecursive(directory: string): Promise<boolean> {
  for (const entry of await listDirents(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await hasAnyFileRecursive(path)) return true;
    } else {
      return true;
    }
  }
  return false;
}

function parseParentRun(parentSession: string): ParentRun | undefined {
  const normalized = parentSession.replaceAll("\\", "/");
  const match = PARENT_RUN_IN_BOOKS.exec(normalized);
  if (match === null) return undefined;
  const bookKey = match[1];
  const leafName = match[2];
  if (bookKey === undefined || leafName === undefined) return undefined;
  const leaf = parseRunLeaf(leafName);
  if (leaf === undefined) return undefined;
  return { bookKey, leafName, runId: leaf.runId, role: leaf.role };
}

async function readJsonlParentSession(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  const newline = raw.indexOf("\n");
  const line = newline === -1 ? raw : raw.slice(0, newline);
  if (line.length === 0) return undefined;
  try {
    const header: unknown = JSON.parse(line);
    if (header === null || typeof header !== "object" || Array.isArray(header)) {
      return undefined;
    }
    const parentSession = (header as { parentSession?: unknown }).parentSession;
    return typeof parentSession === "string" && parentSession.length > 0
      ? parentSession
      : undefined;
  } catch {
    return undefined;
  }
}

async function backupParentRunExists(
  backupBooksDirectory: string,
  parent: ParentRun,
): Promise<boolean> {
  return directoryExists(
    join(backupBooksDirectory, parent.bookKey, "runs", parent.leafName),
  );
}

/**
 * True volume = continuation pointer + live session under the volume + parent in a
 * real backup run (#867). Missing/malformed current-session, a sessionFile outside
 * the volume, temp/fixture parents, or absent backup parent all disqualify.
 */
async function findTrueVolumeParent(
  backupBooksDirectory: string,
  volumeDirectory: string,
): Promise<ParentRun | undefined> {
  let ledgerRaw: string;
  try {
    ledgerRaw = await readFile(join(volumeDirectory, CURRENT_SESSION_LEDGER), "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  let sessionFileField: string;
  try {
    const ledger: unknown = JSON.parse(ledgerRaw);
    if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) {
      return undefined;
    }
    const sessionFile = (ledger as { sessionFile?: unknown }).sessionFile;
    if (typeof sessionFile !== "string" || sessionFile.length === 0) return undefined;
    sessionFileField = sessionFile;
  } catch {
    return undefined;
  }

  const resolvedVolume = resolve(volumeDirectory);
  const resolvedSession = resolve(sessionFileField);
  const localSession = resolve(volumeDirectory, basename(sessionFileField));
  const liveSession =
    pathContainedIn(resolvedVolume, resolvedSession) ? resolvedSession
    : pathContainedIn(resolvedVolume, localSession) ? localSession
    : undefined;
  if (liveSession === undefined) return undefined;
  try {
    const info = await stat(liveSession);
    if (!info.isFile()) return undefined;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const parentSession = await readJsonlParentSession(liveSession);
  if (parentSession === undefined) return undefined;
  if (!isRealRunParentSession(parentSession)) return undefined;
  const parent = parseParentRun(parentSession);
  if (parent === undefined) return undefined;
  if (!(await backupParentRunExists(backupBooksDirectory, parent))) return undefined;
  return parent;
}

/** Real-run parent: under books/.../runs/...; reject temp and fixture spill parents. */
/** Real-run parent must sit under `.ak-roles/books/<book>/runs/<leaf>/`.
 * Flat spill parents under /tmp or fixture workdirs never match parseParentRun.
 */
function isRealRunParentSession(parentSession: string): boolean {
  const normalized = parentSession.replaceAll("\\", "/");
  return parseParentRun(normalized) !== undefined;
}

async function findPlacedRunDirectory(
  booksDirectory: string,
  bookKey: string,
  leafName: string,
): Promise<string | undefined> {
  const matches: string[] = [];
  for (const entry of await listDirents(join(booksDirectory, bookKey))) {
    if (!entry.isDirectory()) continue;
    const candidate = join(booksDirectory, bookKey, entry.name, "runs", leafName);
    if (await directoryExists(candidate)) matches.push(candidate);
  }
  if (matches.length === 0) return undefined;
  const ticketMatch = matches.find(
    (path) => basename(dirname(dirname(path))) !== "unbound",
  );
  return ticketMatch ?? matches[0];
}

async function resolveDestinationRun(
  context: BookTopologyMigrationContext,
  parent: ParentRun,
): Promise<{ readonly runDirectory: string; readonly disposition: MigrationDisposition }> {
  const placed = await findPlacedRunDirectory(
    context.booksDirectory,
    parent.bookKey,
    parent.leafName,
  );
  if (placed !== undefined) {
    const subject = basename(dirname(dirname(placed)));
    return {
      runDirectory: placed,
      disposition: subject === "unbound" ? "unbound" : "placed",
    };
  }
  const backupRun = join(
    context.backupBooksDirectory,
    parent.bookKey,
    "runs",
    parent.leafName,
  );
  const ticketNumber = await readRunTicketNumber(backupRun);
  const runDirectory = roleRunPlacement(dirname(context.booksDirectory), {
    bookKey: parent.bookKey,
    subject: ticketNumber === undefined ? { unbound: true } : { ticketNumber },
    runId: parent.runId,
    role: parent.role,
  }).runDirectory;
  return {
    runDirectory,
    disposition: ticketNumber === undefined ? "unbound" : "placed",
  };
}

function rewritePathIntoDestination(
  sessionFile: string,
  sourceRoots: readonly string[],
  destRoot: string,
): string {
  const resolved = resolve(sessionFile);
  for (const root of sourceRoots) {
    const resolvedRoot = resolve(root);
    if (pathContainedIn(resolvedRoot, resolved)) {
      return join(destRoot, relative(resolvedRoot, resolved));
    }
  }
  return sessionFile;
}

async function readSessionFileField(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const sessionFile = (parsed as { sessionFile?: unknown }).sessionFile;
    return typeof sessionFile === "string" ? sessionFile : undefined;
  } catch {
    return undefined;
  }
}

async function writeWinningCurrentSession(
  destPath: string,
  srcStat: Stats,
  destStat: Stats | undefined,
  nextRaw: string,
  nextSessionFile: string | undefined,
): Promise<void> {
  if (destStat !== undefined) {
    if (destStat.mtimeMs > srcStat.mtimeMs) return;
    if (destStat.mtimeMs === srcStat.mtimeMs) {
      const destSessionFile = await readSessionFileField(destPath);
      const srcName = basename(nextSessionFile ?? "");
      const destName = basename(destSessionFile ?? "");
      if (destName >= srcName) return;
    }
  }
  await writeFile(destPath, nextRaw, "utf8");
  await utimes(destPath, srcStat.atime, srcStat.mtime);
}

async function mergeRewrittenCurrentSession(
  volumeDirectory: string,
  historicalVolume: string,
  destNest: string,
): Promise<void> {
  const srcPath = join(volumeDirectory, CURRENT_SESSION_LEDGER);
  let srcRaw: string;
  let srcStat: Stats;
  try {
    srcStat = await stat(srcPath);
    srcRaw = await readFile(srcPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

  let nextRaw = srcRaw.endsWith("\n") ? srcRaw : `${srcRaw}\n`;
  let nextSessionFile: string | undefined;
  try {
    const parsed: unknown = JSON.parse(srcRaw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.sessionFile === "string") {
        const rewritten = rewritePathIntoDestination(
          record.sessionFile,
          [volumeDirectory, historicalVolume],
          destNest,
        );
        record.sessionFile = rewritten;
        nextSessionFile = rewritten;
      }
      nextRaw = `${JSON.stringify(record)}\n`;
    }
  } catch {
    nextSessionFile = undefined;
  }

  const destPath = join(destNest, CURRENT_SESSION_LEDGER);
  let destStat: Stats | undefined;
  try {
    destStat = await stat(destPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  await writeWinningCurrentSession(
    destPath,
    srcStat,
    destStat,
    nextRaw,
    nextSessionFile,
  );
}

async function copyDirSkippingCurrentSession(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await listDirents(from)) {
    if (entry.name === CURRENT_SESSION_LEDGER && entry.isFile()) continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirSkippingCurrentSession(src, dest);
    } else if (entry.isFile()) {
      await cp(src, dest, { preserveTimestamps: true });
    }
  }
}

async function copyVolumeIntoNest(
  volumeDirectory: string,
  historicalVolume: string,
  destNest: string,
): Promise<void> {
  await copyDirSkippingCurrentSession(volumeDirectory, destNest);
  await mergeRewrittenCurrentSession(volumeDirectory, historicalVolume, destNest);
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, preserveTimestamps: true });
}

export const bookTopologyAuditorRolesMigrator: BookTopologyPartitionMigrator = {
  partition: AUDITOR_ROLES_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      const auditorRoot = join(backupBooksDirectory, bookKey, AUDITOR_ROLES_PARTITION);
      for (const entry of await listDirents(auditorRoot)) {
        const sourcePath = join(auditorRoot, entry.name);
        if (entry.isFile() && entry.name === T10_MISFILED_NAME) {
          continue;
        }
        const source = sourceIdentity(backupBooksDirectory, sourcePath);
        if (!entry.isDirectory()) {
          outcomes.push({ disposition: "discarded", source });
          continue;
        }
        const parent = await findTrueVolumeParent(backupBooksDirectory, sourcePath);
        if (parent === undefined) {
          outcomes.push({ disposition: "discarded", source });
          continue;
        }
        const destination = await resolveDestinationRun(context, parent);
        const destNest = join(destination.runDirectory, "session", AUDITOR_ROLES_PARTITION);
        const historicalVolume = join(
          booksDirectory,
          bookKey,
          AUDITOR_ROLES_PARTITION,
          entry.name,
        );
        await copyVolumeIntoNest(sourcePath, historicalVolume, destNest);
        outcomes.push({ disposition: destination.disposition, source });
      }
    }

    return reconcileMigrationPartition(AUDITOR_ROLES_PARTITION, "entries", outcomes);
  },
};

export const bookTopologyIssuesMigrator: BookTopologyPartitionMigrator = {
  partition: ISSUES_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      const issuesRoot = join(backupBooksDirectory, bookKey, ISSUES_PARTITION);
      for (const entry of await listDirents(issuesRoot)) {
        const sourcePath = join(issuesRoot, entry.name);
        const source = sourceIdentity(backupBooksDirectory, sourcePath);
        const isTicketDir =
          entry.isDirectory() && TICKET_NUMBER_NAME.test(entry.name);
        if (isTicketDir && (await hasAnyFileRecursive(sourcePath))) {
          await copyTree(sourcePath, join(booksDirectory, bookKey, entry.name));
          outcomes.push({ disposition: "placed", source });
          continue;
        }
        outcomes.push({ disposition: "discarded", source });
      }
    }

    return reconcileMigrationPartition(ISSUES_PARTITION, "entries", outcomes);
  },
};

export const bookTopologyDeprecatedKindsMigrator: BookTopologyPartitionMigrator = {
  partition: DEPRECATED_KINDS_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory } = context;

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      for (const kind of DEPRECATED_KIND_DIRECTORIES) {
        const kindRoot = join(backupBooksDirectory, bookKey, kind);
        for (const entry of await listDirents(kindRoot)) {
          outcomes.push({
            disposition: "discarded",
            source: sourceIdentity(backupBooksDirectory, join(kindRoot, entry.name)),
          });
        }
      }
    }

    return reconcileMigrationPartition(DEPRECATED_KINDS_PARTITION, "entries", outcomes);
  },
};

/**
 * Copy one legacy run directory into the new tree while omitting deprecated
 * top-level pages. T9 must use this (or equivalent isDeprecatedRunPage filter)
 * when placing whole runs; the deprecated-run-pages migrator also scrubs any
 * leftover destination pages so the external contract holds after the full
 * partition sequence.
 */
export async function copyRunDirectoryForMigration(
  sourceRunDirectory: string,
  destinationRunDirectory: string,
): Promise<void> {
  await mkdir(destinationRunDirectory, { recursive: true });
  for (const entry of await listDirents(sourceRunDirectory)) {
    if (entry.isFile() && isDeprecatedRunPage(entry.name)) continue;
    const src = join(sourceRunDirectory, entry.name);
    const dest = join(destinationRunDirectory, entry.name);
    if (entry.isDirectory()) {
      await cp(src, dest, { recursive: true, preserveTimestamps: true });
    } else if (entry.isFile()) {
      await cp(src, dest, { preserveTimestamps: true });
    }
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/** Remove deprecated pages from every run already present under destination books. */
async function scrubDestinationDeprecatedRunPages(booksDirectory: string): Promise<void> {
  for (const bookKey of await listBookKeys(booksDirectory)) {
    const bookRoot = join(booksDirectory, bookKey);
    for (const subject of await listDirents(bookRoot)) {
      if (!subject.isDirectory()) continue;
      const runsRoot = join(bookRoot, subject.name, "runs");
      if (!(await directoryExists(runsRoot))) continue;
      for (const run of await listDirents(runsRoot)) {
        if (!run.isDirectory()) continue;
        const runDirectory = join(runsRoot, run.name);
        for (const page of await listDirents(runDirectory)) {
          if (!page.isFile() || !isDeprecatedRunPage(page.name)) continue;
          await unlinkIfPresent(join(runDirectory, page.name));
        }
      }
    }
    // Legacy flat runs/ under a book (if a migrator staged there) — scrub too.
    const flatRuns = join(bookRoot, "runs");
    if (await directoryExists(flatRuns)) {
      for (const run of await listDirents(flatRuns)) {
        if (!run.isDirectory()) continue;
        const runDirectory = join(flatRuns, run.name);
        for (const page of await listDirents(runDirectory)) {
          if (!page.isFile() || !isDeprecatedRunPage(page.name)) continue;
          await unlinkIfPresent(join(runDirectory, page.name));
        }
      }
    }
  }
}

export const bookTopologyDeprecatedRunPagesMigrator: BookTopologyPartitionMigrator = {
  partition: DEPRECATED_RUN_PAGES_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      const runsRoot = join(backupBooksDirectory, bookKey, "runs");
      for (const run of await listDirents(runsRoot)) {
        if (!run.isDirectory()) continue;
        const runDirectory = join(runsRoot, run.name);
        for (const page of await listDirents(runDirectory)) {
          if (!page.isFile() || !isDeprecatedRunPage(page.name)) continue;
          outcomes.push({
            disposition: "discarded",
            source: sourceIdentity(backupBooksDirectory, join(runDirectory, page.name)),
          });
          // If T9 already placed this run, strip the page from the destination now.
          const placed = await findPlacedRunDirectory(booksDirectory, bookKey, run.name);
          if (placed !== undefined) {
            await unlinkIfPresent(join(placed, page.name));
          }
        }
      }
    }

    // Full-tree scrub so the external contract holds even if a run copier used raw cp.
    await scrubDestinationDeprecatedRunPages(booksDirectory);

    return reconcileMigrationPartition(DEPRECATED_RUN_PAGES_PARTITION, "entries", outcomes);
  },
};

async function copyBookTopLevelPartition(
  context: BookTopologyMigrationContext,
  partition: string,
  outcomes: MigrationItemOutcome[],
): Promise<void> {
  for (const bookKey of await listBookKeys(context.backupBooksDirectory)) {
    const sourceDir = join(context.backupBooksDirectory, bookKey, partition);
    if (!(await directoryExists(sourceDir))) continue;
    await copyTree(sourceDir, join(context.booksDirectory, bookKey, partition));
    for (const entry of await listDirents(sourceDir)) {
      outcomes.push({
        disposition: "placed",
        source: sourceIdentity(
          context.backupBooksDirectory,
          join(sourceDir, entry.name),
        ),
      });
    }
  }
}

export const bookTopologyNavigatorMigrator: BookTopologyPartitionMigrator = {
  partition: NAVIGATOR_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    await copyBookTopLevelPartition(context, NAVIGATOR_PARTITION, outcomes);
    return reconcileMigrationPartition(NAVIGATOR_PARTITION, "entries", outcomes);
  },
};

export const bookTopologyCollectorHandbookMigrator: BookTopologyPartitionMigrator = {
  partition: COLLECTOR_HANDBOOK_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    await copyBookTopLevelPartition(context, COLLECTOR_HANDBOOK_PARTITION, outcomes);
    return reconcileMigrationPartition(COLLECTOR_HANDBOOK_PARTITION, "entries", outcomes);
  },
};

export const bookTopologyManualArchivesMigrator: BookTopologyPartitionMigrator = {
  partition: MANUAL_ARCHIVES_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;
    const archivesRoot = join(dirname(booksDirectory), MANUAL_ARCHIVES_PARTITION);

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      for (const dirName of MANUAL_ARCHIVE_DIRECTORIES) {
        const sourceDir = join(backupBooksDirectory, bookKey, dirName);
        if (!(await directoryExists(sourceDir))) continue;
        await copyTree(sourceDir, join(archivesRoot, bookKey, dirName));
        outcomes.push({
          disposition: "placed",
          source: sourceIdentity(backupBooksDirectory, sourceDir),
        });
      }
    }

    return reconcileMigrationPartition(MANUAL_ARCHIVES_PARTITION, "entries", outcomes);
  },
};

/** T11 partitions in the documented registration order. */
export const BOOK_TOPOLOGY_T11_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  bookTopologyAuditorRolesMigrator,
  bookTopologyIssuesMigrator,
  bookTopologyDeprecatedKindsMigrator,
  bookTopologyDeprecatedRunPagesMigrator,
  bookTopologyNavigatorMigrator,
  bookTopologyCollectorHandbookMigrator,
  bookTopologyManualArchivesMigrator,
];
