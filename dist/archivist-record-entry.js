import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import {
  ActivationLedgerError,
  activationBookDirectory,
  ensureRealDirectoryTree,
  errorText,
  pathContainedIn,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath
} from "./activation-ledger-topology.js";
const CURRENT_SESSION_LEDGER = "current-session.json";
function readCurrentSession(sessionDir) {
  const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
  try {
    const value = JSON.parse(readFileSync(ledger, "utf8"));
    if (typeof value !== "object" || value === null || typeof value.sessionFile !== "string" || value.sessionFile.length === 0) {
      throw new Error("sessionFile is missing");
    }
    return value.sessionFile;
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist current-session ledger is unavailable or invalid (${ledger}): ${errorText(error)}`,
      { cause: error }
    );
  }
}
function writeCurrentSession(sessionDir, sessionFile) {
  const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
  try {
    writeFileSync(ledger, `${JSON.stringify({ sessionFile })}
`, { flag: "wx" });
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist current-session ledger cannot be created (${ledger}): ${errorText(error)}`,
      { cause: error }
    );
  }
}
const WORKER_SUBMISSION_GATE_KIND = "worker-submission-gate";
function assertRecentFinalFileUnderSessionDir(sessionDir, recentFile) {
  const absoluteSessionDir = resolve(sessionDir);
  const absoluteFile = resolve(recentFile);
  if (absoluteFile !== absoluteSessionDir && !pathContainedIn(absoluteSessionDir, absoluteFile)) {
    throw new ActivationLedgerError(
      `archivist record session must be under the authorized nest (${sessionDir}): ${recentFile}`
    );
  }
  let realSessionDir;
  try {
    realSessionDir = realpathSync(absoluteSessionDir);
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist record sessionDir is not resolvable (${absoluteSessionDir}): ${errorText(error)}`,
      { cause: error }
    );
  }
  let realFile;
  try {
    realFile = realpathSync(absoluteFile);
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist record session file is not resolvable (${absoluteFile}): ${errorText(error)}`,
      { cause: error }
    );
  }
  if (realFile !== realSessionDir && !pathContainedIn(realSessionDir, realFile)) {
    throw new ActivationLedgerError(
      `archivist record session must be under the authorized nest (${sessionDir}): ${recentFile}`
    );
  }
}
function createRecordSession(options) {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  const ledgerHome = resolveActivationLedgerHomeForPath(parentFile);
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
  const nestAlreadyExists = existsSync(sessionDir);
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  const mayResumeSameNest = options.subject !== void 0 || options.kind === WORKER_SUBMISSION_GATE_KIND;
  if (mayResumeSameNest && nestAlreadyExists) {
    const recentFile = readCurrentSession(sessionDir);
    assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
    return SessionManager.open(recentFile, sessionDir, cwd);
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
    if (mayResumeSameNest && file !== void 0) {
      writeCurrentSession(sessionDir, file);
    }
  }
  return session;
}
export {
  WORKER_SUBMISSION_GATE_KIND,
  createRecordSession
};
