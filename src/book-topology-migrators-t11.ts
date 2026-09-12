/**
 * #867 T11: migrate auditor-roles and issues/, discard retired kinds and run
 * pages, keep navigator / collector-handbook at book top-level, and move
 * manual archives out of the books home.
 *
 * Partition order below is the registration order: auditor-roles, issues,
 * deprecated-kinds, deprecated-run-pages, navigator, collector-handbook,
 * manual-archives.
 */
import { cp, lstat, mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  pathContainedIn,
  physicallyContainedIn,
} from "./activation-ledger-topology.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationDisposition,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import {
  findPlacedMigratingRun,
  isTicketNumberString,
  listBackupRunLeaves,
} from "./book-topology-migration-placement.ts";
import {
  rewriteRoleRunDurablePages,
  type RunDirectoryPathRewrite,
} from "./role-run-relocation.ts";

const AUDITOR_ROLES_PARTITION = "auditor-roles";
const ISSUES_PARTITION = "issues";
const DEPRECATED_KINDS_PARTITION = "deprecated-kinds";
const DEPRECATED_RUN_PAGES_PARTITION = "deprecated-run-pages";
const NAVIGATOR_PARTITION = "navigator";
const COLLECTOR_HANDBOOK_PARTITION = "collector-handbook";
const MANUAL_ARCHIVES_PARTITION = "manual-archives";

const TICKET_NUMBER_NAME = /^[1-9][0-9]*$/;
const RUN_LEAF = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9_-]*)$/;

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
  readonly sourceRelative: string;
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

/** Map a path still written against the pre-rename books root into this backup. */
function mapBooksPathToBackup(
  booksDirectory: string,
  backupBooksDirectory: string,
  absolutePath: string,
): string | undefined {
  const booksRoot = resolve(booksDirectory);
  const resolved = resolve(absolutePath);
  if (resolved !== booksRoot && !pathContainedIn(booksRoot, resolved)) return undefined;
  return join(backupBooksDirectory, relative(booksRoot, resolved));
}

/**
 * Live session for this volume: either already under the volume, or the books
 * original path that maps 1:1 onto a file inside this backup volume. Basename
 * fallback is not a binding. Physical containment rejects symlink escape.
 */
function resolveVolumeSessionFile(
  booksDirectory: string,
  backupBooksDirectory: string,
  volumeDirectory: string,
  sessionFileField: string,
): string | undefined {
  const resolvedVolume = resolve(volumeDirectory);
  const resolvedSession = resolve(sessionFileField);
  if (physicallyContainedIn(resolvedVolume, resolvedSession)) return resolvedSession;

  const mapped = mapBooksPathToBackup(
    booksDirectory,
    backupBooksDirectory,
    sessionFileField,
  );
  if (mapped === undefined) return undefined;
  const resolvedMapped = resolve(mapped);
  return physicallyContainedIn(resolvedVolume, resolvedMapped)
    ? resolvedMapped
    : undefined;
}

/**
 * Parent run bound to this migration's books or backup root. Any other
 * `.ak-roles/books/.../runs/...` spelling (temp/fixture spill) is rejected.
 */
function parseParentRunBoundToMigration(
  booksDirectory: string,
  backupBooksDirectory: string,
  parentSession: string,
): ParentRun | undefined {
  const resolved = resolve(parentSession);
  const booksRoot = resolve(booksDirectory);
  const backupRoot = resolve(backupBooksDirectory);

  let rel: string | undefined;
  if (resolved === booksRoot || pathContainedIn(booksRoot, resolved)) {
    rel = relative(booksRoot, resolved).split(sep).join("/");
  } else if (resolved === backupRoot || pathContainedIn(backupRoot, resolved)) {
    rel = relative(backupRoot, resolved).split(sep).join("/");
  } else {
    return undefined;
  }

  const parts = rel.split("/").filter((part) => part.length > 0);
  const runsIndex = parts.indexOf("runs");
  if (runsIndex < 1 || runsIndex + 1 >= parts.length) return undefined;
  const leafName = parts[runsIndex + 1];
  const before = parts.slice(0, runsIndex);
  if (leafName === undefined) return undefined;
  let bookKey: string | undefined;
  if (before.length === 1) {
    bookKey = before[0];
  } else if (
    before.length === 2
    && (before[1] === "unbound" || (before[1] !== undefined && isTicketNumberString(before[1])))
  ) {
    bookKey = before[0];
  }
  if (bookKey === undefined) return undefined;
  const leaf = parseRunLeaf(leafName);
  if (leaf === undefined) return undefined;
  return {
    bookKey,
    leafName,
    sourceRelative: parts.slice(1, runsIndex + 2).join("/"),
    runId: leaf.runId,
    role: leaf.role,
  };
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
    join(backupBooksDirectory, parent.bookKey, parent.sourceRelative),
  );
}

/**
 * True volume (#867 three-way conjunction):
 * 1. continuation pointer (current-session.sessionFile)
 * 2. that pointer binds a live session under this volume (direct, or books→backup map only)
 * 3. session content names a parent bound to this migration's real backup run
 *
 * Outside pointers, basename-only coincidence, temp/fixture parents, or missing
 * backup parents all disqualify.
 */
async function findTrueVolumeParent(
  backupBooksDirectory: string,
  booksDirectory: string,
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

  const liveSession = resolveVolumeSessionFile(
    booksDirectory,
    backupBooksDirectory,
    volumeDirectory,
    sessionFileField,
  );
  if (liveSession === undefined) return undefined;
  // lstat: only a regular file is later materialized by copyDirSkippingCurrentSession
  // (Dirent.isFile skips symlinks). Accepting a symlink would report placed with a
  // broken ledger target after copy.
  try {
    const info = await lstat(liveSession);
    if (!info.isFile()) return undefined;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const parentSession = await readJsonlParentSession(liveSession);
  if (parentSession === undefined) return undefined;
  const parent = parseParentRunBoundToMigration(
    booksDirectory,
    backupBooksDirectory,
    parentSession,
  );
  if (parent === undefined) return undefined;
  if (!(await backupParentRunExists(backupBooksDirectory, parent))) return undefined;
  return parent;
}

/**
 * Full historical→final run map for relocation. Covers every run already placed
 * under books/ (T9 ticket/unbound nests) so cross-run parent pointers rewrite to
 * each peer's final path, not only the current parent.
 */
async function collectPlacedRunRewrites(
  booksDirectory: string,
  backupBooksDirectory: string,
): Promise<RunDirectoryPathRewrite[]> {
  const rewrites: RunDirectoryPathRewrite[] = [];
  const seen = new Set<string>();
  const push = (oldRunDirectory: string, newRunDirectory: string): void => {
    if (seen.has(oldRunDirectory)) return;
    seen.add(oldRunDirectory);
    rewrites.push({ oldRunDirectory, newRunDirectory });
  };
  for (const bookKey of await listBookKeys(booksDirectory)) {
    for (const subject of await listDirents(join(booksDirectory, bookKey))) {
      if (!subject.isDirectory()) continue;
      const runsRoot = join(booksDirectory, bookKey, subject.name, "runs");
      for (const run of await listDirents(runsRoot)) {
        if (!run.isDirectory()) continue;
        const finalPath = join(runsRoot, run.name);
        push(join(booksDirectory, bookKey, "runs", run.name), finalPath);
        push(join(backupBooksDirectory, bookKey, "runs", run.name), finalPath);
      }
    }
  }
  return rewrites;
}

function historicalRunDirectoriesFor(
  booksDirectory: string,
  backupBooksDirectory: string,
  parent: ParentRun,
): readonly string[] {
  return [
    join(booksDirectory, parent.bookKey, "runs", parent.leafName),
    join(backupBooksDirectory, parent.bookKey, "runs", parent.leafName),
  ];
}

async function resolveDestinationRun(
  context: BookTopologyMigrationContext,
  parent: ParentRun,
): Promise<
  | { readonly runDirectory: string; readonly disposition: MigrationDisposition }
  | undefined
> {
  return findPlacedMigratingRun(
    context.booksDirectory,
    parent.bookKey,
    parent.leafName,
    parent.sourceRelative,
  );
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
    // T9 already rewrote pages present in flat runs; volumes land after that and
    // must reuse the same relocation authority with the full historical→final map.
    const crossRunRewrites = await collectPlacedRunRewrites(
      booksDirectory,
      backupBooksDirectory,
    );
    const rewriteSeen = new Set(crossRunRewrites.map((r) => r.oldRunDirectory));

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
        const parent = await findTrueVolumeParent(
          backupBooksDirectory,
          booksDirectory,
          sourcePath,
        );
        if (parent === undefined) {
          outcomes.push({ disposition: "discarded", source });
          continue;
        }
        const destination = await resolveDestinationRun(context, parent);
        const historicalVolume = join(
          booksDirectory,
          bookKey,
          AUDITOR_ROLES_PARTITION,
          entry.name,
        );
        if (destination === undefined) {
          const destNest = join(
            booksDirectory,
            bookKey,
            "unbound",
            AUDITOR_ROLES_PARTITION,
            entry.name,
          );
          await copyVolumeIntoNest(sourcePath, historicalVolume, destNest);
          outcomes.push({ disposition: "unbound", source });
          continue;
        }
        const destNest = join(destination.runDirectory, "session", AUDITOR_ROLES_PARTITION);
        await copyVolumeIntoNest(sourcePath, historicalVolume, destNest);

        const historicalParents = historicalRunDirectoriesFor(
          booksDirectory,
          backupBooksDirectory,
          parent,
        );
        for (const oldRunDirectory of historicalParents) {
          if (rewriteSeen.has(oldRunDirectory)) continue;
          rewriteSeen.add(oldRunDirectory);
          crossRunRewrites.push({
            oldRunDirectory,
            newRunDirectory: destination.runDirectory,
          });
        }
        // Own pair = this parent; cross map covers every other final placement.
        await rewriteRoleRunDurablePages({
          pagesDirectory: destination.runDirectory,
          oldRunDirectory: historicalParents[0]!,
          newRunDirectory: destination.runDirectory,
          crossRunRewrites,
        });

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

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/**
 * Source-correlated discard for one run directory: count each deprecated page
 * and delete it from the matching final run when that run was already copied.
 */
async function discardDeprecatedPagesFromRunSource(input: {
  readonly backupBooksDirectory: string;
  readonly sourceRunDirectory: string;
  readonly destinationRunDirectory: string | undefined;
  readonly outcomes: MigrationItemOutcome[];
}): Promise<void> {
  for (const page of await listDirents(input.sourceRunDirectory)) {
    if (!page.isFile() || !isDeprecatedRunPage(page.name)) continue;
    input.outcomes.push({
      disposition: "discarded",
      source: sourceIdentity(
        input.backupBooksDirectory,
        join(input.sourceRunDirectory, page.name),
      ),
    });
    if (input.destinationRunDirectory !== undefined) {
      await unlinkIfPresent(join(input.destinationRunDirectory, page.name));
    }
  }
}

/**
 * Count each backup deprecated run page as discarded, and delete the same page
 * from the destination run when it has already been placed. One rule, one place:
 * isDeprecatedRunPage names the pages; this migrator applies the discard across
 * both actual source populations — flat `runs/` and legacy `issues/<N>/runs/`.
 */
export const bookTopologyDeprecatedRunPagesMigrator: BookTopologyPartitionMigrator = {
  partition: DEPRECATED_RUN_PAGES_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      // Population 1: every retained run T9 inventories (flat, ticket, unbound).
      for (const leaf of await listBackupRunLeaves(join(backupBooksDirectory, bookKey))) {
        if (!leaf.isDirectory) continue;
        const placed = await findPlacedMigratingRun(
          booksDirectory,
          bookKey,
          leaf.leafName,
          leaf.relativePath,
        );
        await discardDeprecatedPagesFromRunSource({
          backupBooksDirectory,
          sourceRunDirectory: leaf.sourcePath,
          destinationRunDirectory: placed?.runDirectory,
          outcomes,
        });
      }

      // Population 2: legacy issues/<N>/runs (issues migrator copies whole tree
      // to <book>/<N>/runs). Same discard authority — no parallel scrub in the
      // issues copier.
      const issuesRoot = join(backupBooksDirectory, bookKey, ISSUES_PARTITION);
      for (const issue of await listDirents(issuesRoot)) {
        if (!issue.isDirectory() || !TICKET_NUMBER_NAME.test(issue.name)) continue;
        const issueRunsRoot = join(issuesRoot, issue.name, "runs");
        for (const run of await listDirents(issueRunsRoot)) {
          if (!run.isDirectory()) continue;
          const runDirectory = join(issueRunsRoot, run.name);
          const destination = join(
            booksDirectory,
            bookKey,
            issue.name,
            "runs",
            run.name,
          );
          const destExists = await directoryExists(destination);
          await discardDeprecatedPagesFromRunSource({
            backupBooksDirectory,
            sourceRunDirectory: runDirectory,
            destinationRunDirectory: destExists ? destination : undefined,
            outcomes,
          });
        }
      }
    }

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
