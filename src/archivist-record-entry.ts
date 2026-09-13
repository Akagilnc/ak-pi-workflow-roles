/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ActivationLedgerError,
  ensureRealDirectoryTree,
  errnoCode,
  errorText,
  pathContainedIn,
  physicallyContainedIn,
  resolveActivationLedgerHomeForPath,
} from "./activation-ledger-topology.ts";
import {
  NAVIGATOR_RECORD_KIND,
  resolveNavigatorWorkSubjectPlacement,
} from "./archivist-record-topology.ts";

export {
  NAVIGATOR_RECORD_KIND,
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

type CurrentSessionClaim =
  | { readonly won: true }
  | { readonly won: false; readonly winnerFile: string };

type NavigatorSessionHeader = {
  readonly type: "session";
  readonly id: string;
  readonly cwd?: string;
};

/**
 * Sole current-session publish authority: assemble complete payload, write a
 * same-directory temp, then exclusive hard-link install so readers never see a
 * half-written sidecar. EEXIST → nest-fenced winner adoption. Non-EEXIST keeps
 * the typed main failure. Shared by nest adoption, fresh mint, and every other
 * mayResumeSameNest write point.
 */
function claimCurrentSession(sessionDir: string, sessionFile: string): CurrentSessionClaim {
  const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
  const payload = `${JSON.stringify({ sessionFile })}\n`;
  const temporary = join(sessionDir, `.current-session-${randomUUID()}.tmp`);
  let primaryFailure: unknown;
  let claim: CurrentSessionClaim | undefined;
  try {
    writeFileSync(temporary, payload);
    try {
      linkSync(temporary, ledger);
      claim = { won: true };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") {
        throw new ActivationLedgerError(
          `archivist current-session ledger cannot be created (${ledger}): ${errorText(error)}`,
          { cause: error },
        );
      }
      const winnerFile = readCurrentSession(sessionDir);
      assertRecentFinalFileUnderSessionDir(sessionDir, winnerFile);
      claim = { won: false, winnerFile };
    }
  } catch (error) {
    primaryFailure = error instanceof ActivationLedgerError
      ? error
      : new ActivationLedgerError(
        `archivist current-session ledger cannot be created (${ledger}): ${errorText(error)}`,
        { cause: error },
      );
  }

  // Temp cleanup is mandatory when the file still exists. ENOENT = already clear.
  // No primary: cleanup failure is the main ActivationLedgerError. With primary:
  // keep primary cause and attach cleanup via AggregateError (activation-ledger shape).
  try {
    unlinkSync(temporary);
  } catch (cleanupError) {
    if (errnoCode(cleanupError) !== "ENOENT") {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, cleanupError],
          `archivist current-session temp cleanup failed beside primary failure (${temporary})`,
          { cause: primaryFailure },
        );
      }
      throw new ActivationLedgerError(
        `archivist current-session temp cleanup failed (${temporary}): ${errorText(cleanupError)}`,
        { cause: cleanupError },
      );
    }
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  return claim!;
}

type HeaderOnlyCandidateRead =
  | { readonly kind: "header-only"; readonly header: NavigatorSessionHeader }
  | { readonly kind: "not-header-only" }
  | { readonly kind: "absent" };

/**
 * Structure kernel for a mint candidate: first non-blank line is a session
 * header; no further non-blank lines (no business entry). Real read I/O
 * failures (EACCES/EIO/…) propagate as ActivationLedgerError — never washed
 * into not-header-only / false success. ENOENT → absent.
 */
function readHeaderOnlySessionCandidate(filePath: string): HeaderOnlyCandidateRead {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "absent" };
    throw new ActivationLedgerError(
      `archivist mint candidate structure kernel is not readable (${filePath}): ${errorText(error)}`,
      { cause: error },
    );
  }
  let header: NavigatorSessionHeader | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (header === undefined) {
      header = parseSessionHeaderLine(line);
      if (header === undefined) return { kind: "not-header-only" };
      continue;
    }
    return { kind: "not-header-only" };
  }
  return header === undefined
    ? { kind: "not-header-only" }
    : { kind: "header-only", header };
}

/**
 * Loser mint cleanup: delete only when (1) path still equals this SessionManager's
 * held candidate, (2) in-memory header/session identity matches the on-disk
 * header id, and (3) structure kernel is still header-only with no business
 * entry. Never touches winner, history, peers, or current-session.json.
 * Predicate-satisfied unlink failure is infrastructure failure with cause
 * preserved — not best-effort. Mismatch → do not delete (no fabricated success).
 */
function removeHeaderOnlyMintCandidate(
  session: SessionManager,
  candidateFile: string,
): void {
  const held = session.getSessionFile();
  if (held === undefined) return;
  const absoluteHeld = resolve(held);
  const absoluteCandidate = resolve(candidateFile);
  if (absoluteHeld !== absoluteCandidate) return;

  const memoryHeader = session.getHeader();
  const sessionId = session.getSessionId();
  if (
    memoryHeader === null
    || memoryHeader.type !== "session"
    || typeof memoryHeader.id !== "string"
    || memoryHeader.id.length === 0
    || memoryHeader.id !== sessionId
  ) {
    return;
  }

  const disk = readHeaderOnlySessionCandidate(absoluteCandidate);
  if (disk.kind === "absent") return;
  if (disk.kind !== "header-only") return;
  if (disk.header.id !== memoryHeader.id) return;

  try {
    unlinkSync(absoluteCandidate);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw new ActivationLedgerError(
      `archivist mint candidate cleanup failed (${absoluteCandidate}): ${errorText(error)}`,
      { cause: error },
    );
  }
}

function currentSessionLedgerPath(sessionDir: string): string {
  return join(sessionDir, CURRENT_SESSION_LEDGER);
}

/** Same bounds as Pi readSessionHeader — do not invent a second scan ceiling. */
const SESSION_HEADER_CHUNK_BYTES = 4096;
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

/**
 * Bounded session-header discovery matching Pi readSessionHeader:
 * 4KiB chunks, ≤1MiB total, StringDecoder across reads + EOF flush, skip leading
 * blank lines, first non-blank JSON line only. Accepted session header → value;
 * complete non-session / malformed first line → rejected (non-candidate, stop);
 * no complete line yet → incomplete (keep reading). Oversize-without-header →
 * undefined. Real open/read I/O failures propagate — never washed into non-candidate.
 */
type SessionHeaderRead =
  | { readonly kind: "accepted"; readonly header: NavigatorSessionHeader }
  | { readonly kind: "rejected" }
  | { readonly kind: "incomplete" };

function readBoundedSessionHeader(filePath: string): NavigatorSessionHeader | undefined {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SESSION_HEADER_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let scanned = 0;
    const consume = (chunk: string): SessionHeaderRead => {
      pending += chunk;
      let lineStart = 0;
      let newlineIndex = pending.indexOf("\n", lineStart);
      while (newlineIndex !== -1) {
        const line = pending.slice(lineStart, newlineIndex);
        lineStart = newlineIndex + 1;
        newlineIndex = pending.indexOf("\n", lineStart);
        if (line.trim() === "") continue;
        // First non-blank complete line decides — never scan past a rejection.
        pending = pending.slice(lineStart);
        const header = parseSessionHeaderLine(line);
        return header === undefined
          ? { kind: "rejected" }
          : { kind: "accepted", header };
      }
      pending = pending.slice(lineStart);
      return { kind: "incomplete" };
    };
    const finishPending = (tail: string): NavigatorSessionHeader | undefined => {
      const result = consume(tail);
      if (result.kind === "accepted") return result.header;
      if (result.kind === "rejected") return undefined;
      // EOF with residual non-blank bytes and no newline: treat as one final line.
      if (pending.trim() === "") return undefined;
      const header = parseSessionHeaderLine(pending);
      pending = "";
      return header;
    };
    while (scanned < MAX_SESSION_HEADER_SCAN_BYTES) {
      const toRead = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scanned);
      const bytesRead = readSync(fd, buffer, 0, toRead, null);
      if (bytesRead === 0) {
        return finishPending(decoder.end());
      }
      scanned += bytesRead;
      const found = consume(decoder.write(buffer.subarray(0, bytesRead)));
      if (found.kind === "accepted") return found.header;
      if (found.kind === "rejected") return undefined;
    }
    // Exactly at the scan limit with a complete final line is still accepted;
    // any further unread byte means the header never arrived in bounds.
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, null) === 0) {
      return finishPending(decoder.end());
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function parseSessionHeaderLine(line: string): NavigatorSessionHeader | undefined {
  if (line.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || (parsed as { type?: unknown }).type !== "session"
    || typeof (parsed as { id?: unknown }).id !== "string"
    || (parsed as { id: string }).id.length === 0
  ) {
    return undefined;
  }
  const cwd = (parsed as { cwd?: unknown }).cwd;
  return {
    type: "session",
    id: (parsed as { id: string }).id,
    ...(typeof cwd === "string" ? { cwd } : {}),
  };
}

/**
 * Pre-sidecar navigator continuation (historical findMostRecentSession selection):
 * bounded valid session header, header.cwd resolves equal to the calling cwd,
 * newest file mtime wins. Nest-local only — not a generic kind fallback.
 * Returns undefined when no candidate matches (caller mints fresh, old null path).
 * Directory/stat/read I/O failures propagate as ActivationLedgerError (failure honesty);
 * format non-candidates stay skippable.
 */
function mostRecentNavigatorSessionFile(sessionDir: string, cwd: string): string | undefined {
  const absoluteSessionDir = resolve(sessionDir);
  const absoluteCwd = resolve(cwd);
  let names: string[];
  try {
    names = readdirSync(absoluteSessionDir);
  } catch (error) {
    throw new ActivationLedgerError(
      `archivist navigator nest is not readable (${sessionDir}): ${errorText(error)}`,
      { cause: error },
    );
  }
  const matched: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(absoluteSessionDir, name);
    let st;
    try {
      st = statSync(filePath);
    } catch (error) {
      throw new ActivationLedgerError(
        `archivist navigator session file is not stat-able (${filePath}): ${errorText(error)}`,
        { cause: error },
      );
    }
    if (!st.isFile()) continue;
    let header: NavigatorSessionHeader | undefined;
    try {
      header = readBoundedSessionHeader(filePath);
    } catch (error) {
      throw new ActivationLedgerError(
        `archivist navigator session header is not readable (${filePath}): ${errorText(error)}`,
        { cause: error },
      );
    }
    if (header === undefined) continue;
    if (typeof header.cwd !== "string" || header.cwd.length === 0) continue;
    if (resolve(header.cwd) !== absoluteCwd) continue;
    matched.push({ path: filePath, mtimeMs: st.mtimeMs });
  }
  if (matched.length === 0) return undefined;
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matched[0]!.path;
}

/**
 * Resume target for an existing navigator work-subject nest.
 * Prefer the AK current-session sidecar. When absent (legal pre-sidecar / migrated
 * shape), adopt by historical cwd + mtime recency and write the sidecar once.
 * No match → undefined so the sole entry mints fresh (old null path).
 * Ordinary kinds and worker-submission-gate do not use this path.
 */
function resolveNavigatorNestContinuation(
  sessionDir: string,
  cwd: string,
): string | undefined {
  const ledgerPath = currentSessionLedgerPath(sessionDir);
  if (existsSync(ledgerPath)) {
    const recentFile = readCurrentSession(sessionDir);
    assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
    return recentFile;
  }
  const adopted = mostRecentNavigatorSessionFile(sessionDir, cwd);
  if (adopted === undefined) return undefined;
  assertRecentFinalFileUnderSessionDir(sessionDir, adopted);
  const claim = claimCurrentSession(sessionDir, adopted);
  return claim.won ? adopted : claim.winnerFile;
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
    if (options.kind === NAVIGATOR_RECORD_KIND) {
      const recentFile = resolveNavigatorNestContinuation(sessionDir, cwd);
      if (recentFile !== undefined) {
        return {
          session: SessionManager.open(recentFile, sessionDir, cwd),
          resumed: true,
        };
      }
      // No sidecar and no cwd-matching session — mint fresh in the existing nest.
    } else {
      const recentFile = readCurrentSession(sessionDir);
      assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
      return {
        session: SessionManager.open(recentFile, sessionDir, cwd),
        resumed: true,
      };
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
  // Fresh mayResumeSameNest mint order (fixed): header-only candidate first, then
  // exclusive complete sidecar claim; loser adopts the winner and conditionally
  // deletes only this process's still-header-only candidate.
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
      const claim = claimCurrentSession(sessionDir, file);
      if (!claim.won) {
        const winner = SessionManager.open(claim.winnerFile, sessionDir, cwd);
        removeHeaderOnlyMintCandidate(session, file);
        return { session: winner, resumed: true };
      }
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
