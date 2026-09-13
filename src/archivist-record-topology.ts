/**
 * Pure archivist record placement topology (ADR 0048 / 0065 / dossier-topology).
 * No SessionManager / pi-coding-agent — cold public-bin and ledger discovery
 * may import this without pulling open-session runtime into the graph.
 *
 * Navigator work-subject is the sole book-top subject partition (#852):
 * books/<book>/navigator/<work-subject-digest>/. Callers must not re-hash
 * subject or re-join book/navigator/digest themselves.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";

/** Book-top partition for cross-ticket navigator route-memory (dossier-topology). */
export const NAVIGATOR_RECORD_KIND = "navigator" as const;

/**
 * Sole navigator work-subject nest under the ledger book.
 * Work-subject key shape is sha256(subject) hex truncated to 32 — unchanged (#852 out of scope).
 */
export function navigatorWorkSubjectRecordDirectory(input: {
  readonly cwd: string;
  readonly subject: string;
  /** Parent session file — home path-derives from it when present. */
  readonly parentSessionFile?: string;
  /** Explicit process home when no parent file is available. */
  readonly home?: string;
}): string {
  const ledgerHome =
    input.parentSessionFile !== undefined && input.parentSessionFile.length > 0
      ? resolveActivationLedgerHomeForPath(input.parentSessionFile)
      : resolveActivationLedgerHome(input.home);
  const digest = createHash("sha256").update(input.subject).digest("hex").slice(0, 32);
  return join(
    activationBookDirectory(ledgerHome, resolveBookKeyFromGit(input.cwd)),
    NAVIGATOR_RECORD_KIND,
    digest,
  );
}
