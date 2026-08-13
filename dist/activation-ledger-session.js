import { lstatSync, realpathSync, statSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { activationBookDirectory, ensureRealDirectoryTree, errnoCode, errorText, pathContainedIn, } from "./activation-ledger-topology.js";
/**
 * Typed missing durable session principal. Callers discriminate with instanceof/code;
 * never by parsing message prose. Original filesystem causes are retained.
 */
export class ActivationSessionFileMissingError extends Error {
    code = "AK_ACTIVATION_SESSION_FILE_MISSING";
    path;
    constructor(path, options) {
        super(`Workflow role activation durable session file does not exist: ${path}`, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "ActivationSessionFileMissingError";
        this.path = path;
    }
}
function materializeDeferredSessionFile(sessionManager, resolvedFile, ledgerHome) {
    const header = sessionManager.getHeader?.();
    if (header === null || header === undefined || header.type !== "session") {
        throw new ActivationSessionFileMissingError(resolvedFile);
    }
    ensureRealDirectoryTree(ledgerHome, dirname(resolvedFile));
    try {
        writeFileSync(resolvedFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
    }
    catch (error) {
        if (errnoCode(error) !== "EEXIST") {
            throw new Error(`Workflow role activation failed to materialize durable session file (${resolvedFile}): ${errorText(error)}`, { cause: error });
        }
        // Lost a create race — validate the winner below.
    }
    // Rebind full SessionManager so subsequent Pi appends use O_APPEND (flushed=true)
    // instead of exclusive wx create against the file we just wrote.
    if (typeof sessionManager.setSessionFile === "function") {
        sessionManager.setSessionFile(resolvedFile);
    }
}
/**
 * Admit only a durable Pi session file principal under the resolved machine ledger
 * book (ADR 0048). Requires an existing regular file at admission: resolve real paths
 * and prove containment under the real book. Reject relative paths, outside-book paths,
 * directories, symlink escapes, and nonexistent paths that cannot be materialized from
 * the live SessionManager header. Original filesystem causes are retained.
 *
 * Upstream Pi defers exclusive create until the first assistant message. When the path
 * is the live SessionManager principal under the book and only the header is in memory,
 * admission materializes that header onto the same path before the fact is written so
 * the role fact never points at a session that may be created later.
 */
export function durableSessionPointer(sessionManager, options) {
    const file = sessionManager.getSessionFile?.();
    if (typeof file !== "string" || file.length === 0) {
        throw new Error("Workflow role activation requires a durable Pi session file principal (getSessionFile); directory-only or --no-session invocations are rejected");
    }
    if (!isAbsolute(file)) {
        throw new Error(`Workflow role activation requires an absolute durable session file path under the machine ledger book; got relative path: ${file}`);
    }
    const resolvedFile = resolve(file);
    const bookRoot = resolve(activationBookDirectory(options.ledgerHome, options.bookKey));
    if (!pathContainedIn(bookRoot, resolvedFile)) {
        throw new Error(`Workflow role activation requires the durable session file principal under the machine ledger book (${bookRoot}); got: ${resolvedFile}`);
    }
    try {
        lstatSync(resolvedFile);
    }
    catch (error) {
        if (errnoCode(error) !== "ENOENT") {
            throw new Error(`Workflow role activation failed to stat durable session file (${resolvedFile}): ${errorText(error)}`, { cause: error });
        }
        try {
            materializeDeferredSessionFile(sessionManager, resolvedFile, options.ledgerHome);
        }
        catch (materializeError) {
            // Missing principal: rethrow typed missing-file identity with the original ENOENT cause.
            // Other materialize failures keep their own typed/native identity.
            if (materializeError instanceof ActivationSessionFileMissingError) {
                throw new ActivationSessionFileMissingError(resolvedFile, { cause: error });
            }
            throw materializeError;
        }
    }
    let realBook;
    try {
        realBook = realpathSync(bookRoot);
    }
    catch (error) {
        throw new Error(`Workflow role activation machine ledger book is not resolvable (${bookRoot}): ${errorText(error)}`, { cause: error });
    }
    let realFile;
    try {
        realFile = realpathSync(resolvedFile);
    }
    catch (error) {
        throw new ActivationSessionFileMissingError(resolvedFile, { cause: error });
    }
    if (!pathContainedIn(realBook, realFile)) {
        throw new Error(`Workflow role activation requires the durable session file principal under the machine ledger book (${realBook}); got: ${realFile}`);
    }
    let info;
    try {
        info = statSync(realFile);
    }
    catch (error) {
        throw new Error(`Workflow role activation failed to stat durable session file (${realFile}): ${errorText(error)}`, { cause: error });
    }
    if (info.isDirectory()) {
        throw new Error(`Workflow role activation durable session principal must be a file, not a directory: ${realFile}`);
    }
    if (!info.isFile()) {
        throw new Error(`Workflow role activation durable session principal is not a regular file: ${realFile}`);
    }
    return { kind: "session-file", path: realFile };
}
