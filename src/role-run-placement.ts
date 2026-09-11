import { join } from "node:path";

import {
  activationBookDirectory,
  ensureRealDirectoryTree,
} from "./activation-ledger-topology.ts";

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
    ? String(input.subject.ticketNumber)
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
    artifactsDirectory: join(runDirectory, "artifacts"),
    attachmentsDirectory: join(runDirectory, "attachments"),
  };
}

/** Create every standard run directory at the placement authority. */
export function ensureRoleRunPlacement(
  ledgerHome: string,
  placement: RoleRunPlacement,
): void {
  for (const directory of [
    placement.sessionDirectory,
    placement.artifactsDirectory,
    placement.attachmentsDirectory,
  ]) {
    ensureRealDirectoryTree(ledgerHome, directory);
  }
}
