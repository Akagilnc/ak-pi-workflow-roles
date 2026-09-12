/**
 * Shared placement helpers for book-topology migrators (#865 / #866).
 * Board ticket → readRunTicketNumber; destination path → roleRunPlacement.
 * Worktree basename “所含票号” is the single #852/#865/#866 rule.
 * Shared ENOENT / book-key / dirent enumeration authority for migration modules.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { pathContainedIn } from "./activation-ledger-topology.ts";
import { roleRunPlacement } from "./role-run-placement.ts";
import { readRunTicketNumber } from "./run-ticket-number.ts";

const TICKET_NUMBER_RE = /^[1-9][0-9]*$/;
const RUN_DIR_NAME_RE = /^([^@]+)@([^@]+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sole migration ENOENT projection — non-ENOENT must propagate. */
export function isMigrationEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Book-key directories under a books root; missing root → []. */
export async function listMigrationBookKeys(
  booksDirectory: string,
): Promise<string[]> {
  try {
    const entries = await readdir(booksDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isMigrationEnoent(error)) return [];
    throw error;
  }
}

/** Directory entries sorted by name; missing directory → []. */
export async function listMigrationDirents(
  directory: string,
): Promise<readonly Dirent[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isMigrationEnoent(error)) return [];
    throw error;
  }
}

export function ticketNumberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && TICKET_NUMBER_RE.test(value)) return Number(value);
  return undefined;
}

export function isTicketNumberString(value: string): boolean {
  return TICKET_NUMBER_RE.test(value);
}

/**
 * Ticket number contained in a worktree path's final segment.
 * #852: 「工作树路径末段所含票号」— shared by #865 and #866.
 * Exactly one digit run that is itself a safe positive ticket spelling;
 * multiple or zero digit runs are undecidable → undefined (unbound).
 */
export function ticketNumberFromWorktreeBasename(
  pathBasename: string,
): number | undefined {
  const matches = pathBasename.match(/\d+/g);
  if (matches === null || matches.length !== 1) return undefined;
  const spelling = matches[0]!;
  if (!TICKET_NUMBER_RE.test(spelling)) return undefined;
  const ticketNumber = Number(spelling);
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) return undefined;
  return ticketNumber;
}

/**
 * projectRoot from a retained run's durable pages.
 * ENOENT → try next page / undefined; bad JSON and non-ENOENT IO propagate.
 */
async function readProjectRootFromRun(
  runDirectory: string,
): Promise<{ readonly projectRoot: string; readonly sourcePage: string } | undefined> {
  for (const page of ["admitted-request.json", "invocation.json", "run-state.json"] as const) {
    const path = join(runDirectory, page);
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(raw)) continue;
      const projectRoot = raw.projectRoot;
      if (typeof projectRoot === "string" && projectRoot.length > 0) {
        return { projectRoot, sourcePage: page };
      }
    } catch (error) {
      if (isMigrationEnoent(error)) continue;
      throw error;
    }
  }
  return undefined;
}

export type MigratingRunTicketDerivation =
  | { readonly method: "board"; readonly source: string }
  | {
      readonly method: "project-root-basename";
      readonly source: string;
      readonly sourcePage: string;
    };

/**
 * Ticket binding for a retained run directory (#852 / #865 / #866):
 * board-recorded ticketNumber (readRunTicketNumber) first, then worktree
 * basename containment when the leaf holds a ticket number.
 */
export async function resolveMigratingRunTicket(runDirectory: string): Promise<{
  readonly ticketNumber: number | undefined;
  readonly derivation: MigratingRunTicketDerivation | undefined;
}> {
  const boardTicket = await readRunTicketNumber(runDirectory);
  if (boardTicket !== undefined) {
    return {
      ticketNumber: boardTicket,
      derivation: { method: "board", source: runDirectory },
    };
  }

  const project = await readProjectRootFromRun(runDirectory);
  if (project === undefined) return { ticketNumber: undefined, derivation: undefined };
  const leaf = basename(project.projectRoot.replace(/\\/g, "/"));
  const ticketNumber = ticketNumberFromWorktreeBasename(leaf);
  if (ticketNumber === undefined) return { ticketNumber: undefined, derivation: undefined };
  return {
    ticketNumber,
    derivation: {
      method: "project-root-basename",
      source: project.projectRoot,
      sourcePage: project.sourcePage,
    },
  };
}

export function isUnboundRunDirectory(runDirectory: string): boolean {
  return runDirectory.replaceAll("\\", "/").includes("/unbound/runs/");
}

export function bookHistoricalRoots(
  booksDirectory: string,
  backupBooksDirectory: string,
  bookKey: string,
): readonly string[] {
  return [join(booksDirectory, bookKey), join(backupBooksDirectory, bookKey)];
}

export type BoundRunRef = {
  readonly leaf: string;
  readonly sourceRelative: string;
};

function runLeafFromRelative(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
  const runsIndex = segments.lastIndexOf("runs");
  if (runsIndex < 0 || runsIndex + 1 >= segments.length) return undefined;
  const leaf = segments[runsIndex + 1];
  if (leaf === undefined || leaf === "." || leaf === "..") return undefined;
  return leaf;
}

/** Bind a path to this book's historical roots, then take complete leaf + source-relative run dir. */
export function runRefFromBoundPath(
  path: string,
  bookRoots: readonly string[],
): BoundRunRef | undefined {
  for (const root of bookRoots) {
    const rootResolved = resolve(root);
    const candidate = isAbsolute(path) ? resolve(path) : resolve(rootResolved, path);
    if (candidate === rootResolved || !pathContainedIn(rootResolved, candidate)) continue;
    const rel = relative(rootResolved, candidate).split(sep).join("/");
    const leaf = runLeafFromRelative(rel);
    if (leaf === undefined) continue;
    const parts = rel.split("/").filter((part) => part.length > 0);
    const runsIndex = parts.indexOf("runs");
    if (runsIndex < 0 || runsIndex + 1 >= parts.length) continue;
    return { leaf, sourceRelative: parts.slice(0, runsIndex + 2).join("/") };
  }
  return undefined;
}

export type BackupRunLeaf = {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly leafName: string;
  readonly isDirectory: boolean;
  readonly layout: "flat" | "ticket" | "unbound" | "issues";
};

async function listRunLeafEntries(
  runsDirectory: string,
): Promise<readonly { readonly name: string; readonly isDirectory: boolean }[]> {
  const entries = await listMigrationDirents(runsDirectory);
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));
}

/**
 * Every retained run tree under one backup book: legacy flat `runs/`,
 * already-canonical `<ticket>/runs/`, `unbound/runs/`, and legacy
 * `issues/<ticket>/runs/`.
 */
export async function listBackupRunLeaves(
  backupBookDirectory: string,
): Promise<readonly BackupRunLeaf[]> {
  const leaves: BackupRunLeaf[] = [];
  const collect = async (
    relativeDir: string,
    layout: BackupRunLeaf["layout"],
  ): Promise<void> => {
    const runsDirectory = join(backupBookDirectory, ...relativeDir.split("/"));
    for (const entry of await listRunLeafEntries(runsDirectory)) {
      leaves.push({
        relativePath: `${relativeDir}/${entry.name}`,
        sourcePath: join(runsDirectory, entry.name),
        leafName: entry.name,
        isDirectory: entry.isDirectory,
        layout,
      });
    }
  };
  await collect("runs", "flat");
  await collect("unbound/runs", "unbound");
  for (const subject of await listMigrationDirents(backupBookDirectory)) {
    if (!subject.isDirectory() || !isTicketNumberString(subject.name)) continue;
    await collect(`${subject.name}/runs`, "ticket");
  }
  for (const issue of await listMigrationDirents(join(backupBookDirectory, "issues"))) {
    if (!issue.isDirectory() || !isTicketNumberString(issue.name)) continue;
    await collect(`issues/${issue.name}/runs`, "issues");
  }
  return leaves;
}

async function listExactPlacedRunPaths(
  bookDir: string,
  leafName: string,
): Promise<string[]> {
  const matches: string[] = [];
  const subjectEntries = await listMigrationDirents(bookDir);
  const runsDirs = [
    join(bookDir, "runs"),
    ...subjectEntries.filter((entry) => entry.isDirectory()).map((entry) => join(bookDir, entry.name, "runs")),
  ];
  for (const runsDir of runsDirs) {
    const entries = await listMigrationDirents(runsDir);
    if (entries.some((entry) => entry.name === leafName)) {
      matches.push(join(runsDir, leafName));
    }
  }
  return matches;
}

function destPathFromSourceRelative(
  booksDirectory: string,
  bookKey: string,
  sourceRelative: string,
): string | undefined {
  const parts = sourceRelative.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
  const runsIndex = parts.indexOf("runs");
  if (runsIndex < 0 || runsIndex + 1 >= parts.length) return undefined;
  const leaf = parts[runsIndex + 1];
  const before = parts.slice(0, runsIndex);
  if (leaf === undefined) return undefined;
  // Legacy issues/<ticket>/runs/<leaf> → canonical <ticket>/runs/<leaf>.
  if (
    before.length === 2
    && before[0] === "issues"
    && before[1] !== undefined
    && isTicketNumberString(before[1])
  ) {
    return join(booksDirectory, bookKey, before[1], "runs", leaf);
  }
  if (before.length !== 1) return undefined;
  const subject = before[0];
  if (subject === undefined) return undefined;
  if (subject !== "unbound" && !isTicketNumberString(subject)) return undefined;
  return join(booksDirectory, bookKey, subject, "runs", leaf);
}

function placedRunFromPath(runDirectory: string): {
  readonly runDirectory: string;
  readonly disposition: "placed" | "unbound";
} {
  return {
    runDirectory,
    disposition: isUnboundRunDirectory(runDirectory) ? "unbound" : "placed",
  };
}

async function listPrincipalPlacedRunPaths(
  bookDir: string,
  runId: string,
): Promise<string[]> {
  const matches = [...await listExactPlacedRunPaths(bookDir, runId)];
  const subjectEntries = await listMigrationDirents(bookDir);
  const runsDirs = [
    join(bookDir, "runs"),
    ...subjectEntries.filter((entry) => entry.isDirectory()).map((entry) => join(bookDir, entry.name, "runs")),
  ];
  const prefix = `${runId}@`;
  for (const runsDir of runsDirs) {
    for (const entry of await listMigrationDirents(runsDir)) {
      const name = entry.name;
      if (!name.startsWith(prefix) || name.slice(runId.length + 1).includes("@")) continue;
      const path = join(runsDir, name);
      if (!matches.includes(path)) matches.push(path);
    }
  }
  return matches;
}

function uniquePlacedRun(leafName: string, matches: readonly string[]): {
  readonly runDirectory: string;
  readonly disposition: "placed" | "unbound";
} | undefined {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return placedRunFromPath(matches[0]!);
  throw new Error(
    `book topology migration cannot uniquely place run ${leafName}: ${matches.join(", ")}`,
  );
}

/** Locate an exact run leaf under bookDir/runs, bookDir/<subject>/runs, bookDir/unbound/runs. */
export async function findBookRunDirectory(
  bookDir: string,
  runId: string,
  role?: string,
): Promise<{ readonly runDirectory: string; readonly role: string } | undefined> {
  if (runId.trim() === "") return undefined;
  const leafName = role !== undefined && role.length > 0 ? `${runId}@${role}` : runId;
  const matches = role !== undefined && role.length > 0
    ? await listExactPlacedRunPaths(bookDir, leafName)
    : await listPrincipalPlacedRunPaths(bookDir, runId);
  const unique = uniquePlacedRun(leafName, matches);
  if (unique === undefined) return undefined;
  const foundRole = unique.runDirectory.split(/[/\\]/).pop()?.split("@")[1] ?? role ?? "";
  return { runDirectory: unique.runDirectory, role: foundRole };
}

/** Historical flat `runs/<leaf>` alias under a book root (not ticket/unbound). */
export function isFlatRunsRelative(sourceRelative: string, leafName: string): boolean {
  const parts = sourceRelative.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
  return parts.length === 2 && parts[0] === "runs" && parts[1] === leafName;
}

/** Destination run already placed by T9. Follow complete leaf; bind source path when given. */
export async function findPlacedMigratingRun(
  booksDirectory: string,
  bookKey: string,
  leafName: string,
  sourceRelative?: string,
): Promise<
  | { readonly runDirectory: string; readonly disposition: "placed" | "unbound" }
  | undefined
> {
  if (leafName.trim() === "") return undefined;
  const bookDir = join(booksDirectory, bookKey);
  const matches = await listExactPlacedRunPaths(bookDir, leafName);
  if (sourceRelative !== undefined && sourceRelative.length > 0) {
    const preferred = destPathFromSourceRelative(booksDirectory, bookKey, sourceRelative);
    if (preferred !== undefined) {
      const hit = matches.find((path) => path === preferred);
      return hit === undefined ? undefined : placedRunFromPath(hit);
    }
    // Historical flat `runs/<leaf>` alias after T9 nested the unique complete leaf.
    if (isFlatRunsRelative(sourceRelative, leafName)) {
      return uniquePlacedRun(leafName, matches);
    }
    return undefined;
  }
  return uniquePlacedRun(leafName, matches);
}

/** True when this book retains exactly one directory named leafName across layouts. */
export async function uniqueRunLeafExistsInBook(
  bookDir: string,
  leafName: string,
): Promise<boolean> {
  if (leafName.trim() === "") return false;
  const matches = await listExactPlacedRunPaths(bookDir, leafName);
  return matches.length === 1;
}

/**
 * No path / role evidence: follow runId only when exactly one `runId@role`
 * (or bare runId) exists across this book's layouts. Zero or multi → undefined.
 */
export async function findUniquePrincipalPlacedRun(
  booksDirectory: string,
  bookKey: string,
  runId: string,
): Promise<
  | { readonly runDirectory: string; readonly disposition: "placed" | "unbound" }
  | undefined
> {
  if (runId.trim() === "") return undefined;
  const matches = await listPrincipalPlacedRunPaths(join(booksDirectory, bookKey), runId);
  if (matches.length !== 1) return undefined;
  return placedRunFromPath(matches[0]!);
}

/**
 * Destination run directory via the sole live placement authority (roleRunPlacement).
 * booksDirectory is the books/ root; ledger home is its parent.
 */
export function destinationRunDirectory(
  booksDirectory: string,
  bookKey: string,
  ticketNumber: number | undefined,
  runId: string,
  role: string,
): string {
  const ledgerHome = dirname(booksDirectory);
  const subject =
    ticketNumber !== undefined
      ? ({ ticketNumber } as const)
      : ({ unbound: true } as const);
  return roleRunPlacement(ledgerHome, {
    bookKey,
    subject,
    runId,
    role,
  }).runDirectory;
}

/** Extract runId@role from a sessionParent path when it points at a run session. */
export function runCoordsFromSessionParent(
  sessionParent: unknown,
): { readonly runId: string; readonly role: string } | undefined {
  if (typeof sessionParent !== "string" || sessionParent.length === 0) return undefined;
  const normalized = sessionParent.replace(/\\/g, "/");
  const marker = "/runs/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const after = normalized.slice(index + marker.length);
  const leaf = after.split("/")[0] ?? "";
  const match = RUN_DIR_NAME_RE.exec(leaf);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
}

export function runIdFromSubject(subject: unknown): string | undefined {
  if (typeof subject === "string" && subject.length > 0) return subject;
  if (isRecord(subject) && typeof subject.runId === "string" && subject.runId.length > 0) {
    return subject.runId;
  }
  return undefined;
}

export function ticketNumberFromSubject(subject: unknown): number | undefined {
  if (typeof subject === "string" || typeof subject === "number") {
    return ticketNumberFromUnknown(subject);
  }
  if (isRecord(subject)) return ticketNumberFromUnknown(subject.ticketNumber);
  return undefined;
}
