/**
 * Single true source for the Taishi projectRoot→bookKey rule (#399 / ADR 0048).
 * Git-resolvable → git common-dir host directory name; otherwise the stable
 * synthetic `root:<projectRoot identity>` so read/write page paths agree
 * without a prior scan. Issue/sweep derivation and legacy library-index
 * healing must both call this rule — never a second copy of the fallback.
 *
 * Failure honesty: only failures that mean "this path can never host a
 * repository" become `root:` — the projectRoot itself being absent / not a
 * directory / unreachable through a plain-file path component (ENOTDIR —
 * structurally the same "no repository can live here" fact as ENOENT).
 * Every git child outcome keeps its own identity and propagates loudly —
 * including nonzero exits the shared resolver wraps as
 * ActivationGitRepositoryRequiredError: that type does not certify "non
 * repository" (a dubious-ownership exit 128 is not a no-repo verdict), so
 * washing it into a synthetic key would be silent identity drift (#413 r2 U5).
 * The real cause is the loud carrier.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import { errnoCode, physicalPathIdentity } from "./activation-ledger-topology.ts";

export function resolveTaishiBookKey(projectRoot: string): string {
  const identity = physicalPathIdentity(projectRoot);
  let stats;
  try {
    stats = statSync(identity);
  } catch (error) {
    // Absent root AND plain file mid-path both mean "this path can never be a
    // directory, hence never a Git repository" — same synthetic fallback.
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return `root:${identity}`;
    throw error;
  }
  if (!stats.isDirectory()) return `root:${identity}`;
  // No Activation catch (#413 r2 U5): a nonzero git exit is an unconfirmed
  // category — it must propagate with its real cause, never become `root:`.
  return resolveBookKeyFromGit(identity);
}

/**
 * #413 r2 U3: synthetic keys are exactly `root:` + an absolute path identity
 * (the physicalPathIdentity face). A real Git book whose basename is literally
 * `root:foo` is NOT synthetic — its remainder is not an absolute path. The
 * check is bidirectional: real books are never misclassified by the prefix,
 * and existing synthetic keys keep their path-scope meaning.
 */
export function isSyntheticTaishiBookKey(bookKey: string): boolean {
  return bookKey.startsWith("root:")
    && isAbsolute(bookKey.slice("root:".length));
}
