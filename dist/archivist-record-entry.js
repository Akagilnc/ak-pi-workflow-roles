/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import { ActivationLedgerError, activationBookDirectory, ensureRealDirectoryTree, errorText, pathContainedIn, physicallyContainedIn, resolveActivationLedgerHome, } from "./activation-ledger-topology.js";
const CURRENT_SESSION_LEDGER = "current-session.json";
function readCurrentSession(sessionDir) {
    const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
    try {
        const value = JSON.parse(readFileSync(ledger, "utf8"));
        if (typeof value !== "object"
            || value === null
            || typeof value.sessionFile !== "string"
            || value.sessionFile.length === 0) {
            throw new Error("sessionFile is missing");
        }
        return value.sessionFile;
    }
    catch (error) {
        throw new ActivationLedgerError(`archivist current-session ledger is unavailable or invalid (${ledger}): ${errorText(error)}`, { cause: error });
    }
}
function writeCurrentSession(sessionDir, sessionFile) {
    const ledger = join(sessionDir, CURRENT_SESSION_LEDGER);
    try {
        writeFileSync(ledger, `${JSON.stringify({ sessionFile })}\n`, { flag: "wx" });
    }
    catch (error) {
        throw new ActivationLedgerError(`archivist current-session ledger cannot be created (${ledger}): ${errorText(error)}`, { cause: error });
    }
}
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
function assertRecentFinalFileUnderSessionDir(sessionDir, recentFile) {
    const absoluteSessionDir = resolve(sessionDir);
    const absoluteFile = resolve(recentFile);
    if (absoluteFile !== absoluteSessionDir && !pathContainedIn(absoluteSessionDir, absoluteFile)) {
        throw new ActivationLedgerError(`archivist record session must be under the authorized nest (${sessionDir}): ${recentFile}`);
    }
    let realSessionDir;
    try {
        realSessionDir = realpathSync(absoluteSessionDir);
    }
    catch (error) {
        throw new ActivationLedgerError(`archivist record sessionDir is not resolvable (${absoluteSessionDir}): ${errorText(error)}`, { cause: error });
    }
    let realFile;
    try {
        realFile = realpathSync(absoluteFile);
    }
    catch (error) {
        throw new ActivationLedgerError(`archivist record session file is not resolvable (${absoluteFile}): ${errorText(error)}`, { cause: error });
    }
    if (realFile !== realSessionDir && !pathContainedIn(realSessionDir, realFile)) {
        throw new ActivationLedgerError(`archivist record session must be under the authorized nest (${sessionDir}): ${recentFile}`);
    }
}
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
 */
export function createRecordSession(options) {
    const cwd = options.cwd;
    const parentFile = options.parent?.getSessionFile();
    const ledgerHome = resolveActivationLedgerHome();
    let sessionDir;
    let parentSession;
    if (options.subject !== undefined) {
        const digest = createHash("sha256").update(options.subject).digest("hex").slice(0, 32);
        sessionDir = join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind, digest);
        parentSession = parentFile && parentFile.length > 0 ? parentFile : undefined;
    }
    else if (parentFile === undefined || parentFile.length === 0) {
        // No durable parent principal — preserve prior in-memory child behavior.
        return SessionManager.inMemory(cwd);
    }
    else {
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
    const nestAlreadyExists = existsSync(sessionDir);
    // Directory-chain ownership: containment + physical components (no parallel assert).
    ensureRealDirectoryTree(ledgerHome, sessionDir);
    // Subject-keyed nests continue by subject digest; gate durable resume is the only
    // authorized no-subject same-nest continuation. All other kinds mint fresh.
    const mayResumeSameNest = options.subject !== undefined || options.kind === WORKER_SUBMISSION_GATE_KIND;
    if (mayResumeSameNest && nestAlreadyExists) {
        const recentFile = readCurrentSession(sessionDir);
        assertRecentFinalFileUnderSessionDir(sessionDir, recentFile);
        return SessionManager.open(recentFile, sessionDir, cwd);
    }
    const session = SessionManager.create(cwd, sessionDir, parentSession === undefined ? undefined : { parentSession });
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
    return session;
}
