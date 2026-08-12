import { join } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";

export type RoleRunSessionCoordinates = {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

/**
 * Sole source of public top-level Role run session coordinates.
 * Callers supply identity only; no destination can be injected.
 */
export function roleRunSessionCoordinates(options: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: string;
  /** Machine-home identity; not a record destination. */
  readonly home?: string;
}): RoleRunSessionCoordinates {
  const ledgerHome = resolveActivationLedgerHome(
    options.home === undefined ? undefined : () => options.home!,
  );
  const bookKey = resolveBookKeyFromGit(options.cwd);
  const runDirectory = join(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${options.runId}@${options.role}`,
  );
  const sessionDirectory = join(runDirectory, "session");
  return {
    ledgerHome,
    bookKey,
    runDirectory,
    sessionDirectory,
    sessionFile: join(sessionDirectory, "session.jsonl"),
  };
}
