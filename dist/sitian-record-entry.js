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
function createRecordSession(options) {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  if (parentFile === void 0 || parentFile.length === 0) {
    return SessionManager.inMemory(cwd);
  }
  const ledgerHome = resolveActivationLedgerHome();
  const parentResolved = resolve(parentFile);
  const sessionDir = physicallyContainedIn(ledgerHome, parentResolved) ? join(dirname(parentResolved), options.kind) : join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind);
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  return SessionManager.create(cwd, sessionDir, { parentSession: parentFile });
}
export {
  createRecordSession,
  roleRunSessionCoordinates
};
