import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import {
  roleRunSessionCoordinates
} from "./sitian-role-run-coordinates.js";
import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  physicallyContainedIn,
  resolveActivationLedgerHome
} from "./activation-ledger-topology.js";
const { findMostRecentSession } = await import(new URL("./core/session-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
function createRecordSession(options) {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  const ledgerHome = resolveActivationLedgerHome();
  if (options.subject !== void 0) {
    const digest = createHash("sha256").update(options.subject).digest("hex").slice(0, 32);
    const sessionDir2 = join(
      activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)),
      options.kind,
      digest
    );
    ensureRealDirectoryTree(ledgerHome, sessionDir2);
    const recentFile = findMostRecentSession(sessionDir2, cwd);
    if (recentFile !== null) return SessionManager.open(recentFile, sessionDir2, cwd);
    return SessionManager.create(cwd, sessionDir2, parentFile ? { parentSession: parentFile } : void 0);
  }
  if (parentFile === void 0 || parentFile.length === 0) {
    return SessionManager.inMemory(cwd);
  }
  const parentResolved = resolve(parentFile);
  const sessionDir = physicallyContainedIn(ledgerHome, parentResolved) ? join(dirname(parentResolved), options.kind) : join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind);
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  return SessionManager.create(cwd, sessionDir, { parentSession: parentFile });
}
export {
  createRecordSession,
  roleRunSessionCoordinates
};
