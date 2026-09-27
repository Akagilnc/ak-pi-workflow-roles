/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession，不新增 caller 字段（#855 两面对账 correlation 键已删）。
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import {
  ensureRealDirectoryTree,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import type { HostRecordSession, RecordSessionHost } from "./host-contracts.ts";
import { piRecordSessionHost } from "./pi/record-session-host.ts";
export {
  DIRECT_OFFICER_RUN_POINTER_KIND,
  bookDirectOfficerRunPointer,
} from "./archivist-record-pointer.ts";
export type { DirectOfficerRunPointer } from "./archivist-record-pointer.ts";

/** Durable parent session surface that links and nests the record. */
export type RecordSessionParent = {
  getSessionFile(): string | undefined;
};

export type CreateRecordSessionOptions = {
  /** Role working directory passed to the record session; not a placement input. */
  readonly cwd: string;
  /** What kind of record this is (e.g. "auditor-roles"). Single path segment; not a destination path. */
  readonly kind: string;
  /** Parent session — nesting authority for ordinary kinds. */
  readonly parent?: RecordSessionParent;
  /**
   * Process home when no parent path can derive the ledger home. Not a record
   * destination — same identity surface as resolveActivationLedgerHome(home).
   */
  readonly home?: string;
};

/** Authorized no-subject kind that may resume the most recent same-nest peer (ADR 0066). Sole string true source for gate resume identity. */
export const WORKER_SUBMISSION_GATE_KIND = "worker-submission-gate";

/** Open result including the sole continuation fact. */
export type RecordSessionOpen = {
  readonly session: HostRecordSession;
  /** True when an existing worker-submission-gate volume was continued. */
  readonly resumed: boolean;
};

/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 * SessionDir placement is owned by ensureRealDirectoryTree. Worker-submission-gate asks the
 * host to continue its recent native session without selecting a stored file path.
 * Other ordinary no-subject children (auditor-roles, …) always mint fresh.
 * New persisted principals materialize their deferred session header before return so
 * custom-entry-only writers do not need a parallel delayed-header helper.
 *
 * `resumed` is the sole open-or-continue fact — callers must not re-probe nest existence.
 */
export function createRecordSessionOpen(
  options: CreateRecordSessionOptions,
  host: RecordSessionHost = piRecordSessionHost,
): RecordSessionOpen {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();

  let sessionDir: string;
  let parentSession: string | undefined;
  let mayResumeSameNest: boolean;
  let ledgerHome: string;

  if (parentFile === undefined || parentFile.length === 0) {
    return { session: host.inMemoryRecordSession(cwd), resumed: false };
  }

  ledgerHome = resolveActivationLedgerHomeForPath(parentFile);
  const parentResolved = resolve(parentFile);
  if (!physicallyContainedIn(ledgerHome, parentResolved)) {
    throw new Error("Durable record ownership requires a parent session inside the ledger home");
  }
  // Ordinary kinds: durable parent's file is the sole nesting authority. A divergent
  // SessionManager directory must not create a second placement route.
  // Do not restore generic bookDir/<kind> fallback for foreign/unrooted parents.
  sessionDir = join(dirname(parentResolved), options.kind);
  parentSession = parentFile;
  mayResumeSameNest = options.kind === WORKER_SUBMISSION_GATE_KIND;

  const nestAlreadyExists = existsSync(sessionDir);
  // Directory-chain ownership: containment + physical components (no parallel assert).
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  if (mayResumeSameNest && nestAlreadyExists) {
    const continued = host.continueRecentRecordSession({ cwd, sessionDir });
    if (continued.resumed) {
      return continued;
    }
    // Pi's native continuation falls back to an unparented fresh session. The
    // archivist owns the durable parent, so mint through the ordinary fresh path.
  }

  const session = host.createRecordSession({
    cwd,
    sessionDir,
    ...(parentSession === undefined ? {} : { parentSession }),
  });
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
  return { session, resumed: false };
}

/** Session-only facade — most callers only need the manager. */
export function createRecordSession(options: CreateRecordSessionOptions): HostRecordSession {
  return createRecordSessionOpen(options).session;
}
