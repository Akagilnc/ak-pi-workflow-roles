/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import {
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  ActivationLedgerError,
  activationBookDirectory,
  ensureRealDirectoryTree,
  errnoCode,
  errorText,
  pathContainedIn,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import { subjectKeyedRecordDirectory } from "./archivist-record-topology.ts";

export { subjectKeyedRecordDirectory } from "./archivist-record-topology.ts";

const CURRENT_SESSION_LEDGER = "current-session.json";

type CurrentSessionRecord = { readonly sessionFile: string };

/**
 * Native errno from an error or its cause chain, skipping ActivationLedgerError's
 * own `code = AK_ACTIVATION_LEDGER` brand so ENOENT/EEXIST on the fs cause remain visible.
 */
function nativeErrnoCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (!(current instanceof ActivationLedgerError)) {
      const code = errnoCode(current);
      if (code !== undefined) return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function readCurrentSession(sessionDir: string): string {
  const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
  try {
    const value: unknown = JSON.parse(readFileSync(ledger, "utf8"));
    if (
      typeof value !== "object"
      || value === null
      || typeof (value as CurrentSessionRecord).sessionFile !== "string"
      || (value as CurrentSessionRecord).sessionFile.length === 0
    ) {
      throw new Error("sessionFile is missing");
    }
    return (value as CurrentSessionRecord).sessionFile;
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist current-session ledger is unavailable or invalid (${ledger}): ${errorText(error)}`,
      { cause: error },
    );
  }
}

/**
 * Exclusive first-publisher claim for the nest's current-session pointer.
 * Body is fully written to a temp path first, then published with link (atomic
 * directory entry). Plain wx writeFile leaves an empty inode readable between
 * open and write — concurrent losers then parse truncated JSON. link EEXIST
 * means another creator already published — caller reopens the winner.
 * Every other native failure stays fatal (failure honesty). No wait/retry loop.
 */
function tryClaimCurrentSession(
  sessionDir: string,
  sessionFile: string,
): "claimed" | "lost-to-concurrent-publisher" {
  const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
  const tmp = join(
    sessionDir,
    `.${CURRENT_SESSION_LEDGER}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify({ sessionFile })}
`);
  try {
    linkSync(tmp, ledger);
    return "claimed";
  } catch (error) {
    if (nativeErrnoCode(error) === "EEXIST") {
      return "lost-to-concurrent-publisher";
    }
    throw new ActivationLedgerError(
      `archivist current-session ledger cannot be created (${ledger}): ${errorText(error)}`,
      { cause: error },
    );
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp residue is not the published claim; ignore best-effort cleanup failure.
    }
  }
}

/** Open the published current-session principal (shared resume path). */
function openPublishedCurrentSession(
  sessionDir: string,
  cwd: string,
): RecordSessionOpen {
  const recentFile = readCurrentSession(sessionDir);
  assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
  return {
    session: SessionManager.open(recentFile, sessionDir, cwd),
    resumed: true,
  };
}

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
 * Circle is the authorized nest (sessionDir) itself — lexical path and realpath must both
 * stay inside it. Same-book cross-nest pointers and cross-book symlinks are refused alike.
 * realpath/stat failures stay typed ActivationLedgerError with original cause — never
 * wash through physicalPathIdentity's non-ENOENT lexical fallback.
 */
function assertRecentFinalFileUnderSessionDir(
  sessionDir: string,
  recentFile: string,
): void {
  const absoluteSessionDir = resolve(sessionDir);
  const absoluteFile = resolve(recentFile);
  if (absoluteFile !== absoluteSessionDir && !pathContainedIn(absoluteSessionDir, absoluteFile)) {
    throw new ActivationLedgerError(
      `archivist record session must be under the authorized nest (${sessionDir}): ${recentFile}`,
    );
  }
  let realSessionDir: string;
  try {
    realSessionDir = realpathSync(absoluteSessionDir);
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist record sessionDir is not resolvable (${absoluteSessionDir}): ${errorText(error)}`,
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
  if (realFile !== realSessionDir && !pathContainedIn(realSessionDir, realFile)) {
    throw new ActivationLedgerError(
      `archivist record session must be under the authorized nest (${sessionDir}): ${recentFile}`,
    );
  }
}

/** Open result including the sole resumed fact (nest existed before this open). */
export type RecordSessionOpen = {
  readonly session: SessionManager;
  /** True only when an existing same-nest volume was reopened (subject/gate path). */
  readonly resumed: boolean;
};

/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 * SessionDir placement is owned by ensureRealDirectoryTree; resumed recent final-file
 * identity is checked once before SessionManager.open (directory walk cannot see a
 * trailing .jsonl symlink). New principals mint under the already-validated sessionDir
 * via destination-free SessionManager.create — no derived postcondition.
 * Resume via the AK-owned current-session ledger is limited to subject-keyed identity and the
 * authorized worker-submission-gate durable path. Ordinary no-subject children
 * (evidence-children, auditor-roles, …) always mint a fresh session — never reopen
 * a sibling volume selected only by kind/cwd/mtime.
 * New persisted principals materialize their deferred session header before return so
 * custom-entry-only writers do not need a parallel delayed-header helper.
 *
 * `resumed` is the sole open-or-continue fact — callers must not re-probe nest existence.
 */
export function createRecordSessionOpen(options: CreateRecordSessionOptions): RecordSessionOpen {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  // Path → ledger home is owned by topology (explicit env.home nests via parent path).
  const ledgerHome = resolveActivationLedgerHomeForPath(parentFile);

  let sessionDir: string;
  let parentSession: string | undefined;

  if (options.subject !== undefined) {
    sessionDir = subjectKeyedRecordDirectory({
      cwd,
      kind: options.kind,
      subject: options.subject,
      ...(parentFile === undefined || parentFile.length === 0
        ? {}
        : { parentSessionFile: parentFile }),
    });
    parentSession = parentFile && parentFile.length > 0 ? parentFile : undefined;
  } else if (parentFile === undefined || parentFile.length === 0) {
    // No durable parent principal — preserve prior in-memory child behavior.
    return { session: SessionManager.inMemory(cwd), resumed: false };
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
  // Concurrent first creators share ensureRealDirectoryTree's EEXIST recovery — no
  // existsSync→publish race on the nest directory itself.
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  // Subject-keyed nests continue by subject digest; gate durable resume is the only
  // authorized no-subject same-nest continuation. All other kinds mint fresh.
  const mayResumeSameNest =
    options.subject !== undefined || options.kind === WORKER_SUBMISSION_GATE_KIND;
  // Resume decision is the published current-session claim, not nest directory
  // existence. Directory-exists / ledger-not-yet-published is a first-creator window:
  // missing ledger → try claim; wx EEXIST → reopen the winner. Damaged ledger stays fatal.
  if (mayResumeSameNest) {
    try {
      return openPublishedCurrentSession(sessionDir, cwd);
    } catch (error) {
      if (nativeErrnoCode(error) !== "ENOENT") throw error;
      // Missing claim → fall through to first-publisher path.
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
    if (mayResumeSameNest && file !== undefined) {
      const claim = tryClaimCurrentSession(sessionDir, file);
      if (claim === "lost-to-concurrent-publisher") {
        // Another first creator published first — open their principal (reuse wx ownership).
        return openPublishedCurrentSession(sessionDir, cwd);
      }
    }
  }
  return { session, resumed: false };
}

/** Session-only facade — most callers only need the manager. */
export function createRecordSession(options: CreateRecordSessionOptions): SessionManager {
  return createRecordSessionOpen(options).session;
}
