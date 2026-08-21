/**
 * Single true source for the Taishi projectRoot→bookKey rule (#399 / ADR 0048).
 * Git-resolvable → git common-dir host directory name; otherwise the stable
 * synthetic `root:<projectRoot identity>` so read/write page paths agree
 * without a prior scan. Issue/sweep derivation and legacy library-index
 * healing must both call this rule — never a second copy of the fallback.
 *
 * Failure honesty: a real existing directory that is a *confirmed* non-repository
 * (git's own "not a git repository" verdict, plus the structurally-identical
 * absent root / non-directory root / ENOTDIR mid-path faces — no repository can
 * ever live there) keeps the r4-adjudicated legal `root:<identity>` fallback.
 * Unconfirmed git failures — dubious ownership exit 128 and every other
 * diagnostic that does not certify "non repository" — propagate loudly with
 * their real cause (#413 r2 U5): washing them into a synthetic key would be
 * silent identity drift. Git infrastructure failures (missing binary → ENOENT)
 * stay loud too. The confirmed/unconfirmed classification is implemented once,
 * in the shared resolver owner.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ActivationGitRepositoryRequiredError,
  resolveBookKeyFromGit,
} from "./activation-ledger-git.ts";
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
  // #413 r2 U5 boundary at the Taishi seam: only git's own confirmed
  // "not a git repository" verdict may fall back to `root:<identity>`;
  // unconfirmed nonzero exits (dubious ownership etc.) stay loud.
  try {
    return resolveBookKeyFromGit(identity);
  } catch (error) {
    if (
      error instanceof ActivationGitRepositoryRequiredError
      && error.confirmedNonRepository
    ) {
      return `root:${identity}`;
    }
    throw error;
  }
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
