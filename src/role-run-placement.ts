import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  readonly artifactsDirectory: string;
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

export function sessionFileIn(sessionDirectory: string): string {
  return join(sessionDirectory, "session.jsonl");
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
 * First `runs` segment of a **book-relative** path. The next segment is the run leaf.
 * A later directory that is also named `runs` is inside the run, not another leaf.
 * Absolute ledger paths and `<bookKey>/...` books-root paths are a different
 * coordinate: a book key may itself be `runs`. Bind those to the caller's
 * historical book roots before calling.
 */
export function runsSegmentOf(path: string): {
  readonly index: number;
  readonly leaf: string;
  readonly sourceRelative: string;
} | undefined {
  const parts = path.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("runs");
  if (index < 0 || index + 1 >= parts.length) return undefined;
  const leaf = parts[index + 1];
  if (leaf === undefined || leaf === "." || leaf === "..") return undefined;
  return { index, leaf, sourceRelative: parts.slice(0, index + 2).join("/") };
}

/**
 * Run containers under one book: flat `runs/` plus each subject `runs/`.
 * A subject directory named `runs` is the flat container, not a second tree.
 * Missing book still yields the flat container so callers treat ENOENT as empty.
 */
export async function listBookRunContainers(bookDir: string): Promise<string[]> {
  const containers = [join(bookDir, "runs")];
  let subjects;
  try {
    subjects = await readdir(bookDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return containers;
    throw error;
  }
  const names = subjects
    .filter((subject) => subject.isDirectory() && subject.name !== "runs")
    .map((subject) => subject.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) containers.push(join(bookDir, name, "runs"));
  return containers;
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
  for (const runsDir of await listBookRunContainers(bookDir)) {
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(runsDir, entry.name);
      if (seen.has(runDir)) continue;
      seen.add(runDir);
      out.push(runDir);
    }
  }
  return out.sort();
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
    artifactsDirectory: roleRunArtifactsDirectory(runDirectory),
    attachmentsDirectory: join(runDirectory, "attachments"),
  };
}

/** The single artifacts subpath definition for new and resumed role runs. */
export function roleRunArtifactsDirectory(runDirectory: string): string {
  return join(runDirectory, "artifacts");
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
  for (const directory of [
    placement.sessionDirectory,
    placement.attachmentsDirectory,
  ]) {
    ensureRoleRunDirectory(ledgerHome, directory);
  }
}
