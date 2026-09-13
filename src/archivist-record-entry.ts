/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ActivationLedgerError,
  ensureRealDirectoryTree,
  errorText,
  pathContainedIn,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import {
  NAVIGATOR_RECORD_KIND,
  navigatorWorkSubjectRecordDirectory,
  resolveNavigatorWorkSubjectPlacement,
} from "./archivist-record-topology.ts";

export {
  NAVIGATOR_RECORD_KIND,
  navigatorWorkSubjectRecordDirectory,
  resolveNavigatorWorkSubjectPlacement,
} from "./archivist-record-topology.ts";

const CURRENT_SESSION_LEDGER = "current-session.json";

type CurrentSessionRecord = { readonly sessionFile: string };

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

function writeCurrentSession(sessionDir: string, sessionFile: string): void {
  const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
  try {
    writeFileSync(ledger, `${JSON.stringify({ sessionFile })}\n`, { flag: "wx" });
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist current-session ledger cannot be created (${ledger}): ${errorText(error)}`,
      { cause: error },
    );
  }
}

function currentSessionLedgerPath(sessionDir: string): string {
  return join(sessionDir, CURRENT_SESSION_LEDGER);
}

/**
 * Valid session principals already on disk under a navigator work-subject nest.
 * Used only when the AK current-session sidecar is absent (pre-sidecar / T11 copy).
 * Not a parallel scanner module — nest-local listing inside the sole record entry.
 */
function listNavigatorNestSessionFiles(sessionDir: string): string[] {
  const absoluteSessionDir = resolve(sessionDir);
  let names: string[];
  try {
    names = readdirSync(absoluteSessionDir);
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist navigator nest is not readable (${sessionDir}): ${errorText(error)}`,
      { cause: error },
    );
  }
  const found: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(absoluteSessionDir, name);
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // Header must be a real session principal — skip empty/malformed debris.
    try {
      const firstLine = readFileSync(filePath, "utf8").split("\n", 1)[0] ?? "";
      if (firstLine.trim() === "") continue;
      const header: unknown = JSON.parse(firstLine);
      if (
        typeof header !== "object"
        || header === null
        || (header as { type?: unknown }).type !== "session"
        || typeof (header as { id?: unknown }).id !== "string"
        || (header as { id: string }).id.length === 0
      ) {
        continue;
      }
    } catch {
      continue;
    }
    found.push(filePath);
  }
  return found;
}

/**
 * Resume target for an existing navigator work-subject nest.
 * Prefer the AK current-session sidecar. When absent (legal pre-sidecar / migrated
 * shape), adopt the sole valid session file in the nest and write the sidecar once.
 * Zero candidates or more than one valid session is durable damage / ambiguity — loud fail.
 * Ordinary kinds and worker-submission-gate do not use this path.
 */
function resolveNavigatorNestContinuation(sessionDir: string): string {
  const ledgerPath = currentSessionLedgerPath(sessionDir);
  if (existsSync(ledgerPath)) {
    const recentFile = readCurrentSession(sessionDir);
    assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
    return recentFile;
  }
  const candidates = listNavigatorNestSessionFiles(sessionDir);
  if (candidates.length === 0) {
    throw new ActivationLedgerError(
      `archivist navigator nest has no current-session sidecar and no adoptable session file (${sessionDir})`,
    );
  }
  if (candidates.length > 1) {
    throw new ActivationLedgerError(
      `archivist navigator nest has no current-session sidecar and multiple session files (${sessionDir}): ${candidates.length}`,
    );
  }
  const adopted = candidates[0]!;
  assertRecentFinalFileUnderSessionDir(sessionDir, adopted);
  writeCurrentSession(sessionDir, adopted);
  return adopted;
}

/** Durable parent session surface that links and nests the record. */
export type RecordSessionParent = {
  getSessionFile(): string | undefined;
};

export type CreateRecordSessionOptions = {
  /** Role working directory passed to the record session; not a placement input. */
  readonly cwd: string;
  /** What kind of record this is (e.g. "auditor-roles"). Single path segment; not a destination path. */
  readonly kind: string;
  /** Parent session — nesting authority for ordinary kinds; optional parentSession link for navigator. */
  readonly parent?: RecordSessionParent;
  /**
   * Durable work-subject intent. For navigator only, selects the book-top
   * `navigator/<work-subject>` nest (dossier-topology / #852); does not restore
   * generic kind partitions.
   */
  readonly subject?: string;
  /**
   * Process home when no parent path can derive the ledger home. Not a record
   * destination — same identity surface as resolveActivationLedgerHome(home).
   */
  readonly home?: string;
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

/** Open result including the sole continuation fact. */
export type RecordSessionOpen = {
  readonly session: SessionManager;
  /** True when an existing navigator work-subject or worker-submission-gate volume was reopened. */
  readonly resumed: boolean;
};

/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 * SessionDir placement is owned by ensureRealDirectoryTree; resumed recent final-file
 * identity is checked once before SessionManager.open (directory walk cannot see a
 * trailing .jsonl symlink). New principals mint under the already-validated sessionDir
 * via destination-free SessionManager.create — no derived postcondition.
 * Resume via the AK-owned current-session ledger is limited to navigator work-subject
 * nests and the authorized worker-submission-gate durable path (ADR 0066 / #852).
 * Other ordinary no-subject children (auditor-roles, evidence-children, …) always mint fresh.
 * New persisted principals materialize their deferred session header before return so
 * custom-entry-only writers do not need a parallel delayed-header helper.
 *
 * `resumed` is the sole open-or-continue fact — callers must not re-probe nest existence.
 */
export function createRecordSessionOpen(options: CreateRecordSessionOptions): RecordSessionOpen {
  const cwd = options.cwd;
  const parentFile = options.parent?.getSessionFile();

  let sessionDir: string;
  let parentSession: string | undefined;
  let mayResumeSameNest: boolean;
  let ledgerHome: string;

  // #852 sole book-top exception: navigator/<work-subject> via one topology authority.
  // Holds for no parent / unmaterialized parent / materialized parent — never silent in-memory.
  if (options.kind === NAVIGATOR_RECORD_KIND && options.subject !== undefined) {
    const placement = resolveNavigatorWorkSubjectPlacement({
      cwd,
      subject: options.subject,
      ...(parentFile === undefined || parentFile.length === 0
        ? {}
        : { parentSessionFile: parentFile }),
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    sessionDir = placement.sessionDir;
    ledgerHome = placement.ledgerHome;
    parentSession = parentFile && parentFile.length > 0 ? parentFile : undefined;
    mayResumeSameNest = true;
  } else if (parentFile === undefined || parentFile.length === 0) {
    if (options.subject === undefined) {
      // No durable principal requested: preserve prior in-memory child behavior.
      return { session: SessionManager.inMemory(cwd), resumed: false };
    }
    throw new Error("Durable record ownership requires a parent session inside the ledger home");
  } else {
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
  }

  const nestAlreadyExists = existsSync(sessionDir);
  // Directory-chain ownership: containment + physical components (no parallel assert).
  ensureRealDirectoryTree(ledgerHome, sessionDir);
  if (mayResumeSameNest && nestAlreadyExists) {
    let recentFile: string;
    if (options.kind === NAVIGATOR_RECORD_KIND) {
      recentFile = resolveNavigatorNestContinuation(sessionDir);
    } else {
      recentFile = readCurrentSession(sessionDir);
      assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
    }
    return {
      session: SessionManager.open(recentFile, sessionDir, cwd),
      resumed: true,
    };
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
      writeCurrentSession(sessionDir, file);
    }
  }
  return { session, resumed: false };
}

/** Session-only facade — most callers only need the manager. */
export function createRecordSession(options: CreateRecordSessionOptions): SessionManager {
  return createRecordSessionOpen(options).session;
}


/** Typed parent-side pointer to an independent officer run 正本 (ADR 0079 / #675). */
export const DIRECT_OFFICER_RUN_POINTER_KIND = "direct-officer-run-pointer" as const;

export type DirectOfficerRunPointer = {
  readonly version: 1;
  readonly kind: typeof DIRECT_OFFICER_RUN_POINTER_KIND;
  readonly officer: "inspector" | "notary" | "auditor";
  /** Absolute path to the officer session.jsonl 正本. */
  readonly sessionFile: string;
  /** Officer run directory when known. */
  readonly runDirectory?: string;
};

/**
 * Book a typed pointer under parent session/auditor-roles (same nest owner as
 * createRecordSession). Never fabricates user/assistant/toolResult rows (#675).
 * Directory placement stays with the archivist record entry (ADR 0018 / 0065).
 *
 * Stable leaf per officer under one parent (#753 gate-round accounting):
 * same-parent re-summons upsert the same pointer instead of minting N files that
 * each re-scan the full officer session and multiply terminal gate-round counts.
 */
export function bookDirectOfficerRunPointer(options: {
  readonly parentSessionFile: string;
  readonly officer: "inspector" | "notary" | "auditor";
  readonly sessionFile: string;
  readonly runDirectory?: string;
}): DirectOfficerRunPointer {
  const nest = join(dirname(options.parentSessionFile), "auditor-roles");
  mkdirSync(nest, { recursive: true });
  const pointer: DirectOfficerRunPointer = {
    version: 1,
    kind: DIRECT_OFFICER_RUN_POINTER_KIND,
    officer: options.officer,
    sessionFile: options.sessionFile,
    ...(options.runDirectory !== undefined && options.runDirectory.trim() !== ""
      ? { runDirectory: options.runDirectory }
      : {}),
  };
  writeFileSync(
    join(nest, `${options.officer}.pointer.json`),
    `${JSON.stringify(pointer)}\n`,
    "utf8",
  );
  return pointer;
}
