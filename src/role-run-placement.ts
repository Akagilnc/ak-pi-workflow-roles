import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  activationBookDirectory,
  ensureRealDirectoryTree,
} from "./activation-ledger-topology.ts";
import { requireSafePositiveTicketNumber } from "./run-ticket-number.ts";

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

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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
      if (isMissingPathError(error)) return;
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
    if (isMissingPathError(error)) return out.sort();
    throw error;
  }
  for (const subject of subjects) {
    if (!subject.isDirectory() || subject.name === "runs") continue;
    await collect(join(bookDir, subject.name, "runs"));
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
    `${input.runId}@${input.role}`,
  );
  const sessionDirectory = join(runDirectory, "session");
  return {
    runDirectory,
    sessionDirectory,
    sessionFile: join(sessionDirectory, "session.jsonl"),
    artifactsDirectory: roleRunArtifactsDirectory(runDirectory),
    attachmentsDirectory: join(runDirectory, "attachments"),
  };
}

/** The single artifacts subpath definition for new and resumed role runs. */
export function roleRunArtifactsDirectory(runDirectory: string): string {
  return join(runDirectory, "artifacts");
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
