/**
 * #865 T9: migrate the legacy flat `runs/` partition into ticket-scoped or
 * unbound placement. Derivation from the worktree basename is recorded beside
 * the run so it can be audited or overturned; board-recorded ticketNumber wins.
 */
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import { roleRunPlacement } from "./role-run-placement.ts";
import { rewriteRoleRunDurablePages } from "./role-run-relocation.ts";
import { readRunTicketNumber } from "./run-ticket-number.ts";

const RUNS_PARTITION = "runs";
const DERIVATION_PAGE = "migration-ticket-derivation.json";

const RUN_LEAF =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9_-]*)$/;

type RunLeaf = { readonly runId: string; readonly role: string };

type TicketAttribution =
  | { readonly kind: "board"; readonly ticketNumber: number }
  | {
      readonly kind: "worktree-basename";
      readonly ticketNumber: number;
      readonly projectRoot: string;
      readonly sourcePage: string;
      readonly basename: string;
    }
  | { readonly kind: "unbound" };

function parseRunLeaf(name: string): RunLeaf | undefined {
  const match = RUN_LEAF.exec(name);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Ticket number contained in a worktree path's final segment. */
function ticketNumberFromWorktreeBasename(
  pathBasename: string,
): number | undefined {
  const match = /(\d+)/.exec(pathBasename);
  if (match === null) return undefined;
  const ticketNumber = Number(match[1]);
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) return undefined;
  return ticketNumber;
}

async function readProjectRoot(
  runDirectory: string,
): Promise<{ projectRoot: string; sourcePage: string } | undefined> {
  for (const page of [
    "admitted-request.json",
    "invocation.json",
    "run-state.json",
  ] as const) {
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(runDirectory, page), "utf8"),
      );
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const projectRoot = (raw as { projectRoot?: unknown }).projectRoot;
      if (typeof projectRoot === "string" && projectRoot.length > 0) {
        return { projectRoot, sourcePage: page };
      }
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }
  return undefined;
}

async function attributeRun(runDirectory: string): Promise<TicketAttribution> {
  const boardTicket = await readRunTicketNumber(runDirectory);
  if (boardTicket !== undefined) {
    return { kind: "board", ticketNumber: boardTicket };
  }
  const project = await readProjectRoot(runDirectory);
  if (project === undefined) return { kind: "unbound" };
  const pathBasename = basename(project.projectRoot);
  const ticketNumber = ticketNumberFromWorktreeBasename(pathBasename);
  if (ticketNumber === undefined) return { kind: "unbound" };
  return {
    kind: "worktree-basename",
    ticketNumber,
    projectRoot: project.projectRoot,
    sourcePage: project.sourcePage,
    basename: pathBasename,
  };
}

async function writeDerivationPage(
  targetRunDirectory: string,
  attribution: Extract<TicketAttribution, { kind: "worktree-basename" }>,
): Promise<void> {
  const page = {
    ticketNumber: attribution.ticketNumber,
    derivation: "worktree-path-basename" as const,
    source: {
      page: attribution.sourcePage,
      field: "projectRoot",
      path: attribution.projectRoot,
      basename: attribution.basename,
    },
  };
  await writeFile(
    join(targetRunDirectory, DERIVATION_PAGE),
    `${JSON.stringify(page, null, 2)}\n`,
    "utf8",
  );
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

async function listRunLeaves(
  runsDirectory: string,
): Promise<readonly { name: string; isDirectory: boolean }[]> {
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    return entries
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function targetRunDirectoryFor(
  booksDirectory: string,
  bookKey: string,
  leafName: string,
  attribution: TicketAttribution,
): string {
  const leaf = parseRunLeaf(leafName);
  const ledgerHome = dirname(booksDirectory);
  if (leaf !== undefined) {
    const subject =
      attribution.kind === "unbound"
        ? ({ unbound: true } as const)
        : ({ ticketNumber: attribution.ticketNumber } as const);
    return roleRunPlacement(ledgerHome, {
      bookKey,
      subject,
      runId: leaf.runId,
      role: leaf.role,
    }).runDirectory;
  }
  // Non-<runId>@<role> entries still land under unbound/runs/ — never discarded.
  return join(booksDirectory, bookKey, "unbound", "runs", leafName);
}

async function copyRunTree(
  source: string,
  target: string,
  isDirectory: boolean,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (isDirectory) {
    await cp(source, target, { recursive: true, preserveTimestamps: true });
    return;
  }
  await cp(source, target, { preserveTimestamps: true });
}

export const bookTopologyRunsMigrator: BookTopologyPartitionMigrator = {
  partition: RUNS_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
      const sourceRunsDirectory = join(backupBooksDirectory, bookKey, "runs");
      for (const leaf of await listRunLeaves(sourceRunsDirectory)) {
        const sourcePath = join(sourceRunsDirectory, leaf.name);
        const sourceIdentity = relative(
          backupBooksDirectory,
          sourcePath,
        ).split(sep).join("/");

        // Only <runId>@<role> directories can occupy ticket placement; everything
        // else still lands under unbound/runs/ and is never discarded.
        const leafIdentity = leaf.isDirectory ? parseRunLeaf(leaf.name) : undefined;
        const attribution =
          leafIdentity === undefined
            ? ({ kind: "unbound" } as const)
            : await attributeRun(sourcePath);

        const targetPath = targetRunDirectoryFor(
          booksDirectory,
          bookKey,
          leaf.name,
          attribution,
        );
        // Historical path as pages still record it (pre-rename books/ location).
        const historicalRunDirectory = join(
          booksDirectory,
          bookKey,
          "runs",
          leaf.name,
        );

        await copyRunTree(sourcePath, targetPath, leaf.isDirectory);
        if (leaf.isDirectory) {
          await rewriteRoleRunDurablePages({
            pagesDirectory: targetPath,
            oldRunDirectory: historicalRunDirectory,
            newRunDirectory: targetPath,
          });
          if (attribution.kind === "worktree-basename") {
            await writeDerivationPage(targetPath, attribution);
          }
        }

        outcomes.push({
          disposition: attribution.kind === "unbound" ? "unbound" : "placed",
          source: sourceIdentity,
        });
      }
    }

    return reconcileMigrationPartition(RUNS_PARTITION, "entries", outcomes);
  },
};
