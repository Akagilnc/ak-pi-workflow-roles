/**
 * Pure archivist record placement topology (ADR 0048 / 0065).
 * No SessionManager / pi-coding-agent — cold public-bin and ledger discovery
 * may import this without pulling open-session runtime into the graph.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";

/**
 * Sole subject-keyed nest path under the ledger book (ADR 0048 / 0065).
 * Callers must not re-hash subject or re-join book/kind/digest themselves.
 */
export function subjectKeyedRecordDirectory(input: {
  readonly cwd: string;
  readonly kind: string;
  readonly subject: string;
  /** Parent session file — home path-derives from it when present. */
  readonly parentSessionFile?: string;
  /** Explicit process home when no parent file is available (discovery-only). */
  readonly home?: string;
}): string {
  const ledgerHome =
    input.parentSessionFile !== undefined && input.parentSessionFile.length > 0
      ? resolveActivationLedgerHomeForPath(input.parentSessionFile)
      : resolveActivationLedgerHome(input.home);
  const digest = createHash("sha256").update(input.subject).digest("hex").slice(0, 32);
  return join(
    activationBookDirectory(ledgerHome, resolveBookKeyFromGit(input.cwd)),
    input.kind,
    digest,
  );
}
