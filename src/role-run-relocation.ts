/**
 * Retained-path matching for live lookup. Pure path rewrite rules live in
 * role-run-path-rewrite.ts (sole authority) and are re-exported here.
 */
import { dirname } from "node:path";

import { activationBookDirectory, physicalPathIdentity } from "./activation-ledger-topology.ts";
import { readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { roleRunPlacement } from "./role-run-placement.ts";
import { rewriteRunDirectoryPathValue } from "./role-run-path-rewrite.ts";

// Re-export the pure path API so existing import sites stay on this module path.
export {
  PRINCIPAL_SESSION_PATH_FIELDS,
  projectTurnRequestLiveRunDirectory,
  rewriteAdmittedRoleRunPage,
  rewritePrincipalSessionPaths,
  rewriteRunDirectoryPathFields,
  rewriteRunDirectoryPathFieldsAgainstRewrites,
  rewriteRunDirectoryPathValue,
  rewriteRunDirectoryPathValueAgainstRewrites,
} from "./role-run-path-rewrite.ts";

/** Match physical aliases or a normal unbound→ticket bind, never historical migration layouts. */
export async function retainedRunPathsMatch(
  recordedPath: unknown,
  currentPath: string,
  currentRunDirectory?: string,
): Promise<boolean> {
  if (recordedPath === currentPath) return true;
  if (typeof recordedPath !== "string") return false;
  const recordedPathIdentity = physicalPathIdentity(recordedPath);
  const currentPathIdentity = physicalPathIdentity(currentPath);
  if (recordedPathIdentity === currentPathIdentity) return true;
  if (currentRunDirectory === undefined) return false;
  const runDirectory = physicalPathIdentity(currentRunDirectory);
  const identity = await readRoleRunIdentity(runDirectory);
  if (identity === undefined) return false;
  for (let directory = runDirectory; dirname(directory) !== directory; directory = dirname(directory)) {
    const ledgerHome = dirname(dirname(directory));
    if (directory !== activationBookDirectory(ledgerHome, identity.bookKey)) continue;
    const unbound = roleRunPlacement(ledgerHome, {
      bookKey: identity.bookKey,
      subject: { unbound: true },
      runId: identity.runId,
      role: identity.role,
    });
    if (rewriteRunDirectoryPathValue(recordedPathIdentity, unbound.runDirectory, runDirectory) !== currentPathIdentity) {
      return false;
    }
    // The current volume's identity and the unbound→ticket rewrite already
    // establish this relationship; do not select that volume again by bare ID.
    return true;
  }
  return false;
}
