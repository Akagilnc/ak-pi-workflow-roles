import {
  lstatSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  ensureRealDirectoryTree,
  errnoCode,
  errorText,
} from "./activation-ledger-topology.ts";

/** Durable pointer to the authoritative Pi session file principal (ADR 0048/0049). */
export type ActivationSessionPointer = {
  readonly kind: "session-file";
  readonly path: string;
};

/** Session manager surface needed to admit (and, when deferred, materialize) the durable principal. */
export type ActivationSessionManager = {
  getSessionFile?(): string | undefined;
  getHeader?(): { readonly type: string } | null;
  /** Full SessionManager rebind after early header materialization (keeps Pi append path consistent). */
  setSessionFile?(path: string): void;
};

/**
 * Typed missing durable session principal. Callers discriminate with instanceof/code;
 * never by parsing message prose. Original filesystem causes are retained.
 */
export class ActivationSessionFileMissingError extends Error {
  readonly code = "AK_ACTIVATION_SESSION_FILE_MISSING" as const;
  readonly path: string;
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `Workflow role activation durable session file does not exist: ${path}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ActivationSessionFileMissingError";
    this.path = path;
  }
}

function materializeDeferredSessionFile(
  sessionManager: ActivationSessionManager,
  resolvedFile: string,
  ledgerHome: string,
): void {
  const header = sessionManager.getHeader?.();
  if (header === null || header === undefined || header.type !== "session") {
    throw new ActivationSessionFileMissingError(resolvedFile);
  }
  ensureRealDirectoryTree(ledgerHome, dirname(resolvedFile));
  try {
    writeFileSync(resolvedFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") {
      throw new Error(
        `Workflow role activation failed to materialize durable session file (${resolvedFile}): ${errorText(error)}`,
        { cause: error },
      );
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
 * Admit a durable Pi session file principal (ADR 0048/0065).
 * Requires an existing regular file at admission (or a live SessionManager header that
 * can be materialized onto the same path). Rejects relative paths, directories,
 * non-files, and nonexistent paths that cannot be materialized. Original filesystem
 * causes are retained.
 *
 * Record-placement (session must live under the ledger book) is NOT enforced here —
 * that check lives on the sitian record entry (createRecordSession). Activation only
 * binds the durable principal identity for the role run.
 *
 * Upstream Pi defers exclusive create until the first assistant message. When the path
 * is the live SessionManager principal and only the header is in memory, admission
 * materializes that header onto the same path before the fact is written so the role
 * fact never points at a session that may be created later. Materialization still goes
 * through ledger-home directory creation (cannot invent trees outside the machine home).
 */
export function durableSessionPointer(
  sessionManager: ActivationSessionManager,
  options: {
    ledgerHome: string;
  },
): ActivationSessionPointer {
  const file = sessionManager.getSessionFile?.();
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(
      "Workflow role activation requires a durable Pi session file principal (getSessionFile); directory-only or --no-session invocations are rejected",
    );
  }
  if (!isAbsolute(file)) {
    throw new Error(
      `Workflow role activation requires an absolute durable session file path; got relative path: ${file}`,
    );
  }

  const resolvedFile = resolve(file);

  try {
    lstatSync(resolvedFile);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw new Error(
        `Workflow role activation failed to stat durable session file (${resolvedFile}): ${errorText(error)}`,
        { cause: error },
      );
    }
    try {
      materializeDeferredSessionFile(sessionManager, resolvedFile, options.ledgerHome);
    } catch (materializeError) {
      // Missing principal: rethrow typed missing-file identity with the original ENOENT cause.
      // Other materialize failures keep their own typed/native identity.
      if (materializeError instanceof ActivationSessionFileMissingError) {
        throw new ActivationSessionFileMissingError(resolvedFile, { cause: error });
      }
      throw materializeError;
    }
  }

  let realFile: string;
  try {
    realFile = realpathSync(resolvedFile);
  } catch (error) {
    throw new ActivationSessionFileMissingError(resolvedFile, { cause: error });
  }

  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(realFile);
  } catch (error) {
    throw new Error(
      `Workflow role activation failed to stat durable session file (${realFile}): ${errorText(error)}`,
      { cause: error },
    );
  }

  if (info.isDirectory()) {
    throw new Error(
      `Workflow role activation durable session principal must be a file, not a directory: ${realFile}`,
    );
  }
  if (!info.isFile()) {
    throw new Error(
      `Workflow role activation durable session principal is not a regular file: ${realFile}`,
    );
  }
  return { kind: "session-file", path: realFile };
}
