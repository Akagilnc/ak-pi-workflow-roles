import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  activationBookDirectory,
  ensureRealDirectoryTree,
} from "./activation-ledger-topology.ts";
import { requireSafePositiveTicketNumber } from "./run-ticket-number.ts";

import { isEnoent } from "./unknown-value.ts";

export type RoleRunSubject =
  | { readonly ticketNumber: number }
  | { readonly unbound: true };

export type RoleRunPlacement = {
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
  readonly attachmentsDirectory: string;
};

/** Writer leaf `<runId>@<role>`. Empty sides stay empty; this is not a validator. */
export function formatRunLeaf(runId: string, role: string): string {
  return `${runId}@${role}`;
}

/**
 * Inverse of formatRunLeaf: last `@`, both sides non-empty.
 * `a@b@c` is runId `a@b`, role `c`. Charset is not a second grammar.
 */
export function parseRunLeaf(name: string): { readonly runId: string; readonly role: string } | undefined {
  const at = name.lastIndexOf("@");
  if (at <= 0 || at === name.length - 1) return undefined;
  return { runId: name.slice(0, at), role: name.slice(at + 1) };
}

export function sessionDirectoryOf(runDirectory: string): string {
  return join(runDirectory, "session");
}

export const ROLE_RUN_SESSION_FILENAME = "session.jsonl";

export function sessionFileIn(sessionDirectory: string): string {
  return join(sessionDirectory, ROLE_RUN_SESSION_FILENAME);
}

export function sessionFileOf(runDirectory: string): string {
  return sessionFileIn(sessionDirectoryOf(runDirectory));
}

/** `<run>/session/session.jsonl` → run directory. */
export function runDirectoryOfSessionFile(sessionFile: string): string {
  return dirname(dirname(sessionFile));
}

/** `<run>/session` → run directory. */
export function runDirectoryFromSessionDirectory(sessionDirectory: string): string {
  return dirname(sessionDirectory);
}

/**
 * Sole book-level run directory walk: flat legacy `runs/` plus each
 * `subject/runs/` child (ticket / unbound). One authority for read-side
 * enumeration under a book directory — findRunDirectoryById, analyst scan,
 * and ticket trajectory must not hardcode a second subject-tree walk.
 */
export async function listBookRunDirectories(bookDir: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  const collect = async (runsDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(runsDir, entry.name);
      if (seen.has(runDir)) continue;
      seen.add(runDir);
      out.push(runDir);
    }
  };

  await collect(join(bookDir, "runs"));

  let subjects;
  try {
    subjects = await readdir(bookDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return out.sort();
    throw error;
  }
  for (const subject of subjects) {
    if (!subject.isDirectory() || subject.name === "runs") continue;
    await collect(join(bookDir, subject.name, "runs"));
  }
  return out.sort();
}

/** Resolve a complete run identity across the caller's books; ambiguity is never readdir-first. */
export async function findRoleRunDirectory(
  bookDirectories: readonly string[],
  runId: string,
  onlyRole?: string,
): Promise<string | undefined> {
  const matches: string[] = [];
  for (const bookDirectory of bookDirectories) {
    for (const runDirectory of await listBookRunDirectories(bookDirectory)) {
      const parsed = parseRunLeaf(basename(runDirectory));
      if (parsed === undefined || parsed.runId !== runId) continue;
      if (onlyRole !== undefined && parsed.role !== onlyRole) continue;
      matches.push(runDirectory);
    }
  }
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  throw new Error(`ambiguous role run id ${runId}: ${matches.join(", ")}`);
}

/** The single authority for every path belonging to an admitted role run. */
export function roleRunPlacement(
  ledgerHome: string,
  input: {
    readonly bookKey: string;
    readonly subject: RoleRunSubject;
    readonly runId: string;
    readonly role: string;
  },
): RoleRunPlacement {
  const subjectDirectory = "ticketNumber" in input.subject
    ? String(requireSafePositiveTicketNumber(
        input.subject.ticketNumber,
        "roleRunPlacement subject.ticketNumber",
      ))
    : "unbound";
  const runDirectory = join(
    activationBookDirectory(ledgerHome, input.bookKey),
    subjectDirectory,
    "runs",
    formatRunLeaf(input.runId, input.role),
  );
  const sessionDirectory = sessionDirectoryOf(runDirectory);
  return {
    runDirectory,
    sessionDirectory,
    sessionFile: sessionFileIn(sessionDirectory),
    attachmentsDirectory: join(runDirectory, "attachments"),
  };
}

/** Canonical unbound placement: a run directory under `<book>/unbound/runs/`. */
export function isUnboundRunDirectory(runDirectory: string): boolean {
  return runDirectory.replaceAll("\\", "/").includes("/unbound/runs/");
}

/** The placement seam owns creation for both new runs and resumed legacy runs. */
export function ensureRoleRunDirectory(
  ledgerHome: string,
  directory: string,
): string {
  return ensureRealDirectoryTree(ledgerHome, directory);
}

export function ensureRoleRunPlacement(
  ledgerHome: string,
  placement: RoleRunPlacement,
): void {
  ensureRoleRunDirectory(ledgerHome, placement.sessionDirectory);
}
