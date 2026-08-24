/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, join, relative, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
export {
  roleRunSessionCoordinates,
  type RoleRunSessionCoordinates,
} from "./archivist-role-run-coordinates.ts";
import {
  ActivationLedgerError,
  activationBookDirectory,
  ensureRealDirectoryTree,
  errorText,
  pathContainedIn,
  physicallyContainedIn,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";

// continueRecent always allocates a deferred sessionFile; this is the discovery result.
const { findMostRecentSession } = await import(
  new URL("./core/session-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
) as {
  findMostRecentSession: (sessionDir: string, cwd?: string) => string | null;
};

/** Parent session surface needed to link and (when already under home) nest the record. */
export type RecordSessionParent = {
  getSessionFile(): string | undefined;
};

export type CreateRecordSessionOptions = {
  /** Role working directory — used for git book-key discovery when the parent is not already under home. Not a record destination. */
  readonly cwd: string;
  /** What kind of record this is (e.g. "auditor-roles"). Single path segment; not a destination path. */
  readonly kind: string;
  /** Optional parent session — supplies parentSession link; nest under parent only when that parent already lives under the ledger home. */
  readonly parent?: RecordSessionParent;
  /** Stable work identity for book-level records which continue across role runs. */
  readonly subject?: string;
};

/** Authorized no-subject kind that may resume the most recent same-nest peer (ADR 0066). Sole string true source for gate resume identity. */
export const WORKER_SUBMISSION_GATE_KIND = "worker-submission-gate";

/**
 * Sole file-level placement lock for a resumed same-nest principal (ADR 0065 / #221).
 * ensureRealDirectoryTree already owns the sessionDir chain; a final .jsonl symlink is
 * invisible to that directory walk, so this runs once before SessionManager.open.
 * Circle is the book physical root that owns sessionDir — not merely ledger home — so a
 * books/A nest cannot resume a final file whose realpath lands in books/B.
 * realpath/stat failures stay typed ActivationLedgerError with original cause — never
 * wash through physicalPathIdentity's non-ENOENT lexical fallback.
 */
function assertRecentFinalFileUnderLedgerHome(
  ledgerHome: string,
  sessionDir: string,
  recentFile: string,
): void {
  const absoluteHome = resolve(ledgerHome);
  const absoluteSessionDir = resolve(sessionDir);
  const absoluteFile = resolve(recentFile);
  // sessionDir just passed ensureRealDirectoryTree: derive the owning book lexically.
  const relToHome = relative(absoluteHome, absoluteSessionDir);
  const segments = relToHome.split(sep);
  if (
    relToHome === ""
    || isAbsolute(relToHome)
    || relToHome === ".."
    || relToHome.startsWith(`..${sep}`)
    || segments[0] !== "books"
    || segments[1] === undefined
    || segments[1] === ""
    || segments[1] === "."
    || segments[1] === ".."
  ) {
    throw new ActivationLedgerError(
      `archivist record sessionDir must be under a ledger book (${ledgerHome}): ${sessionDir}`,
    );
  }
  const bookRoot = join(absoluteHome, "books", segments[1]);
  let realBookRoot: string;
  try {
    realBookRoot = realpathSync(bookRoot);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger book is not resolvable (${bookRoot}): ${errorText(error)}`,
      { cause: error },
    );
  }
  let realFile: string;
  try {
    realFile = realpathSync(absoluteFile);
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist record session file is not resolvable (${absoluteFile}): ${errorText(error)}`,
      { cause: error },
    );
  }
  if (realFile !== realBookRoot && !pathContainedIn(realBookRoot, realFile)) {
    throw new ActivationLedgerError(
      `archivist record session must be under the ledger book (${bookRoot}): ${recentFile}`,
    );
  }
}

/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 * SessionDir placement is owned by ensureRealDirectoryTree; resumed recent final-file
 * identity is checked once before SessionManager.open (directory walk cannot see a
 * trailing .jsonl symlink). New principals mint under the already-validated sessionDir
 * via destination-free SessionManager.create — no derived postcondition.
 * Resume via Pi findMostRecentSession is limited to subject-keyed identity and the
 * authorized worker-submission-gate durable path. Ordinary no-subject children
 * (evidence-children, auditor-roles, …) always mint a fresh session — never reopen
 * a sibling volume selected only by kind/cwd/mtime.
 * New persisted principals materialize their deferred session header before return so
 * custom-entry-only writers do not need a parallel delayed-header helper.
 */
export function createRecordSession(options: CreateRecordSessionOptions): SessionManager {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  const ledgerHome = resolveActivationLedgerHome();

  let sessionDir: string;
  let parentSession: string | undefined;

  if (options.subject !== undefined) {
    const digest = createHash("sha256").update(options.subject).digest("hex").slice(0, 32);
    sessionDir = join(
      activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)),
      options.kind,
      digest,
    );
    parentSession = parentFile && parentFile.length > 0 ? parentFile : undefined;
  } else if (parentFile === undefined || parentFile.length === 0) {
    // No durable parent principal — preserve prior in-memory child behavior.
    return SessionManager.inMemory(cwd);
  } else {
    const parentResolved = resolve(parentFile);
    // Nest under parent only when the parent record already lives under the package home.
    // Nest base is dirname(parent file) — the durable principal's directory — never a
    // separate getSessionDir() that can diverge (empty in-memory dir + durable file).
    // Otherwise the book is resolved from cwd (ADR 0048) and the kind sits under that book —
    // workspace / foreign parents cannot drag records out of home.
    sessionDir = physicallyContainedIn(ledgerHome, parentResolved)
      ? join(dirname(parentResolved), options.kind)
      : join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind);
    parentSession = parentFile;
  }

  // Directory-chain ownership: containment + physical components (no parallel assert).
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  // Subject-keyed nests continue by subject digest; gate durable resume is the only
  // authorized no-subject same-nest continuation. All other kinds mint fresh.
  const mayResumeSameNest =
    options.subject !== undefined || options.kind === WORKER_SUBMISSION_GATE_KIND;
  if (mayResumeSameNest) {
    const recentFile = findMostRecentSession(sessionDir, cwd);
    if (recentFile !== null) {
      assertRecentFinalFileUnderLedgerHome(ledgerHome, sessionDir, recentFile);
      return SessionManager.open(recentFile, sessionDir, cwd);
    }
  }

  const session = SessionManager.create(
    cwd,
    sessionDir,
    parentSession === undefined ? undefined : { parentSession },
  );
  // Pi defers session-file create until the first assistant message. Custom-entry-only
  // records never get that turn, so the sole record entry materializes the in-memory
  // header onto the UUIDv7 path before returning. Existing path → early return.
  if (session.isPersisted()) {
    const file = session.getSessionFile();
    if (file !== undefined && !existsSync(file)) {
      const header = session.getHeader();
      if (header !== null && header.type === "session") {
        writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
        // Rebind so subsequent appendCustomEntry uses O_APPEND (flushed=true).
        session.setSessionFile(file);
      }
    }
  }
  return session;
}
