/**
 * Single true source for the Taishi projectRoot→bookKey rule (#399 / ADR 0048).
 * Git-resolvable → git common-dir host directory name; otherwise the stable
 * synthetic `root:<projectRoot identity>` so read/write page paths agree
 * without a prior scan. Issue/sweep derivation and legacy library-index
 * healing must both call this rule — never a second copy of the fallback.
 *
 * Failure honesty: only failures that mean "Git cannot adjudicate this root"
 * become `root:` — the projectRoot itself being absent / not a directory, and
 * a git child that ran and reported non-repository status
 * (ActivationGitRepositoryRequiredError). Git infrastructure failures
 * (missing/unreadable binary, OS errors, anything unknown) keep their own
 * identity and propagate loudly — never washed into a valid book key.
 */
import { statSync } from "node:fs";
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
    if (errnoCode(error) === "ENOENT") return `root:${identity}`;
    throw error;
  }
  if (!stats.isDirectory()) return `root:${identity}`;
  try {
    return resolveBookKeyFromGit(identity);
  } catch (error) {
    if (error instanceof ActivationGitRepositoryRequiredError) return `root:${identity}`;
    throw error;
  }
}
