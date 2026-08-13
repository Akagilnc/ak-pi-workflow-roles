/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
export {
  roleRunSessionCoordinates,
  type RoleRunSessionCoordinates,
} from "./sitian-role-run-coordinates.ts";
import {
  activationBookDirectory,
  ensureRealDirectoryTree,
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

/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 * Same-nest resume reuses Pi findMostRecentSession (valid header, cwd filter, mtime).
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

  ensureRealDirectoryTree(ledgerHome, sessionDir);
  // Delegate discovery to Pi so custom-directory continuation retains its
  // mtime ordering, valid-header scan, and cwd filtering semantics.
  const recentFile = findMostRecentSession(sessionDir, cwd);
  if (recentFile !== null) return SessionManager.open(recentFile, sessionDir, cwd);

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
