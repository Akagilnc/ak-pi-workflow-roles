/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  ensureRealDirectoryTree,
  physicallyContainedIn,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";

/** Parent session surface needed to link and (when already under home) nest the record. */
export type RecordSessionParent = {
  getSessionFile(): string | undefined;
};

export type RoleRunSessionCoordinates = {
  readonly bookKey: string;
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

/**
 * Sole source of public top-level Role run session coordinates.
 * Callers supply identity only; no destination can be injected.
 */
export function roleRunSessionCoordinates(options: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: string;
  /** Machine-home identity; not a record destination. */
  readonly home?: string;
}): RoleRunSessionCoordinates {
  const bookKey = resolveBookKeyFromGit(options.cwd);
  const runDirectory = join(
    activationBookDirectory(
      resolveActivationLedgerHome(
        options.home === undefined ? undefined : () => options.home!,
      ),
      bookKey,
    ),
    "runs",
    `${options.runId}@${options.role}`,
  );
  const sessionDirectory = join(runDirectory, "session");
  return {
    bookKey,
    runDirectory,
    sessionDirectory,
    sessionFile: join(sessionDirectory, "session.jsonl"),
  };
}

export type CreateRecordSessionOptions = {
  /** Role working directory — used for git book-key discovery when the parent is not already under home. Not a record destination. */
  readonly cwd: string;
  /** What kind of record this is (e.g. "auditor-roles"). Single path segment; not a destination path. */
  readonly kind: string;
  /** Optional parent session — supplies parentSession link; nest under parent only when that parent already lives under the ledger home. */
  readonly parent?: RecordSessionParent;
};

/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 */
export function createRecordSession(options: CreateRecordSessionOptions): SessionManager {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();
  if (parentFile === undefined || parentFile.length === 0) {
    // No durable parent principal — preserve prior in-memory child behavior.
    return SessionManager.inMemory(cwd);
  }

  const ledgerHome = resolveActivationLedgerHome();
  const parentResolved = resolve(parentFile);

  // Nest under parent only when the parent record already lives under the package home.
  // Nest base is dirname(parent file) — the durable principal's directory — never a
  // separate getSessionDir() that can diverge (empty in-memory dir + durable file).
  // Otherwise the book is resolved from cwd (ADR 0048) and the kind sits under that book —
  // workspace / foreign parents cannot drag records out of home.
  const sessionDir = physicallyContainedIn(ledgerHome, parentResolved)
    ? join(dirname(parentResolved), options.kind)
    : join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind);

  ensureRealDirectoryTree(ledgerHome, sessionDir);
  return SessionManager.create(cwd, sessionDir, { parentSession: parentFile });
}
