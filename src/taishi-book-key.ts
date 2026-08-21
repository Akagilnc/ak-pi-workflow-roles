/**
 * Single true source for the Taishi projectRoot→bookKey rule (#399 / ADR 0048).
 * Git-resolvable → git common-dir host directory name; otherwise the stable
 * synthetic `root:<projectRoot identity>` so read/write page paths agree
 * without a prior scan. Issue/sweep derivation and legacy library-index
 * healing must both call this rule — never a second copy of the fallback.
 */
import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import { physicalPathIdentity } from "./activation-ledger-topology.ts";

export function resolveTaishiBookKey(projectRoot: string): string {
  const identity = physicalPathIdentity(projectRoot);
  try {
    return resolveBookKeyFromGit(identity);
  } catch {
    return `root:${identity}`;
  }
}
