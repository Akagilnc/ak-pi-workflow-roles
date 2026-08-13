import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import {
  roleRunSessionCoordinates
} from "./sitian-role-run-coordinates.js";
import {
  ActivationLedgerError,
  activationBookDirectory,
  ensureRealDirectoryTree,
  errorText,
  pathContainedIn,
  physicallyContainedIn,
  resolveActivationLedgerHome
} from "./activation-ledger-topology.js";
const { findMostRecentSession } = await import(new URL("./core/session-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const WORKER_SUBMISSION_GATE_KIND = "worker-submission-gate";
function assertRecentFinalFileUnderLedgerHome(ledgerHome, recentFile) {
  const absoluteHome = resolve(ledgerHome);
  const absoluteFile = resolve(recentFile);
  let realHome;
  try {
    realHome = realpathSync(absoluteHome);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger home is not resolvable (${absoluteHome}): ${errorText(error)}`,
      { cause: error }
    );
  }
  let realFile;
  try {
    realFile = realpathSync(absoluteFile);
  } catch (error) {
    throw new ActivationLedgerError(
      `sitian record session file is not resolvable (${absoluteFile}): ${errorText(error)}`,
      { cause: error }
    );
  }
  if (realFile !== realHome && !pathContainedIn(realHome, realFile)) {
    throw new ActivationLedgerError(
      `sitian record session must be under the machine ledger home (${ledgerHome}): ${recentFile}`
    );
  }
}
function createRecordSession(options) {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  const ledgerHome = resolveActivationLedgerHome();
  let sessionDir;
  let parentSession;
  if (options.subject !== void 0) {
    const digest = createHash("sha256").update(options.subject).digest("hex").slice(0, 32);
    sessionDir = join(
      activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)),
      options.kind,
      digest
    );
    parentSession = parentFile && parentFile.length > 0 ? parentFile : void 0;
  } else if (parentFile === void 0 || parentFile.length === 0) {
    return SessionManager.inMemory(cwd);
  } else {
    const parentResolved = resolve(parentFile);
    sessionDir = physicallyContainedIn(ledgerHome, parentResolved) ? join(dirname(parentResolved), options.kind) : join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind);
    parentSession = parentFile;
  }
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  const mayResumeSameNest = options.subject !== void 0 || options.kind === WORKER_SUBMISSION_GATE_KIND;
  if (mayResumeSameNest) {
    const recentFile = findMostRecentSession(sessionDir, cwd);
    if (recentFile !== null) {
      assertRecentFinalFileUnderLedgerHome(ledgerHome, recentFile);
      return SessionManager.open(recentFile, sessionDir, cwd);
    }
  }
  const session = SessionManager.create(
    cwd,
    sessionDir,
    parentSession === void 0 ? void 0 : { parentSession }
  );
  if (session.isPersisted()) {
    const file = session.getSessionFile();
    if (file !== void 0 && !existsSync(file)) {
      const header = session.getHeader();
      if (header !== null && header.type === "session") {
        writeFileSync(file, `${JSON.stringify(header)}
`, { flag: "wx" });
        session.setSessionFile(file);
      }
    }
  }
  return session;
}
export {
  WORKER_SUBMISSION_GATE_KIND,
  createRecordSession,
  roleRunSessionCoordinates
};
