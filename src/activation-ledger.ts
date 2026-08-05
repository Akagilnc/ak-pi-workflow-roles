import { constants, mkdirSync, openSync, closeSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

/** Caller-preassigned correlation id, or an explicit absent identity (never empty string). */
export type ActivationCorrelationIdentity =
  | { readonly kind: "caller"; readonly id: string }
  | { readonly kind: "absent" };

/** Durable pointer to the authoritative Pi session file principal (ADR 0048/0049). */
export type ActivationSessionPointer = {
  readonly kind: "session-file";
  readonly path: string;
};

export const ACCEPTED_ACTIVATION_EVENT = "accepted-activation" as const;

/**
 * Closed activation fact: index fields only (ADR 0049).
 * No prompt, transcript, argv, excerpt, or other content.
 */
export type AcceptedActivationFact = {
  readonly event: typeof ACCEPTED_ACTIVATION_EVENT;
  readonly role: string;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly session: ActivationSessionPointer;
  readonly correlation: ActivationCorrelationIdentity;
};

export type AcceptedActivationFactInput = {
  readonly role: string;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly session: ActivationSessionPointer;
  readonly correlation: ActivationCorrelationIdentity;
};

/**
 * Sole package-owned machine home (ADR 0048 / #78): one enumerable family under
 * the process home directory. No env override — relative or invocation-varying
 * homes would split the family and can write into a consumer repository.
 */
export function resolveActivationLedgerHome(home: () => string = homedir): string {
  return join(home(), ".ak-roles");
}

/** Enumerable book directory for one basename key. */
export function activationBookDirectory(ledgerHome: string, bookKey: string): string {
  return join(ledgerHome, "books", bookKey);
}

/** Append-only waiting ledger path for one book. */
export function activationWaitingLedgerPath(ledgerHome: string, bookKey: string): string {
  return join(activationBookDirectory(ledgerHome, bookKey), "waiting.jsonl");
}

/**
 * Host correlation channel (not a CLI flag): non-empty AK_CORRELATION_ID carries
 * the caller id; missing/blank yields the typed absent identity.
 */
export function correlationIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ActivationCorrelationIdentity {
  const raw = env.AK_CORRELATION_ID;
  if (typeof raw === "string" && raw.length > 0) {
    return { kind: "caller", id: raw };
  }
  return { kind: "absent" };
}

/** True when candidate resolves strictly inside root (boundary-safe; not a string-prefix check). */
function pathContainedIn(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errnoCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

/**
 * Admit only a durable Pi session file principal under the resolved machine ledger
 * book (ADR 0048). Non-empty getSessionFile is not enough: reject relative paths,
 * paths outside the book, directories, and paths whose file and session-dir parent
 * are both missing. Original filesystem causes are retained.
 *
 * A missing file whose parent session-dir already exists under the book is admitted:
 * upstream Pi defers the first exclusive create until an assistant message, so the
 * path is the durable principal before bytes land (see SessionManager._persist).
 */
export function durableSessionPointer(
  sessionManager: {
    getSessionFile?(): string | undefined;
  },
  options: {
    ledgerHome: string;
    bookKey: string;
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
      `Workflow role activation requires an absolute durable session file path under the machine ledger book; got relative path: ${file}`,
    );
  }
  const resolvedFile = resolve(file);
  const bookRoot = resolve(activationBookDirectory(options.ledgerHome, options.bookKey));
  if (!pathContainedIn(bookRoot, resolvedFile)) {
    throw new Error(
      `Workflow role activation requires the durable session file principal under the machine ledger book (${bookRoot}); got: ${resolvedFile}`,
    );
  }

  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(resolvedFile);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw new Error(
        `Workflow role activation failed to stat durable session file (${resolvedFile}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    // File not yet written (Pi deferred create). Parent session-dir must already exist
    // under the book so the pointer is a prepared durable path, not a fabricated string.
    const parentPath = dirname(resolvedFile);
    try {
      const parent = statSync(parentPath);
      if (!parent.isDirectory()) {
        throw new Error(
          `Workflow role activation durable session parent is not a directory: ${parentPath}`,
          { cause: error },
        );
      }
    } catch (parentError) {
      if (errnoCode(parentError) === undefined && parentError instanceof Error) throw parentError;
      throw new Error(
        `Workflow role activation durable session file does not exist: ${resolvedFile}`,
        { cause: error },
      );
    }
    return { kind: "session-file", path: resolvedFile };
  }

  if (info.isDirectory()) {
    throw new Error(
      `Workflow role activation durable session principal must be a file, not a directory: ${resolvedFile}`,
    );
  }
  if (!info.isFile()) {
    throw new Error(
      `Workflow role activation durable session principal is not a regular file: ${resolvedFile}`,
    );
  }
  return { kind: "session-file", path: resolvedFile };
}

/**
 * Book key = basename of the git common-dir host directory (ADR 0048).
 * Worktrees resolve to the main repository host. Non-git cwd retains the original git cause.
 */
export function resolveBookKeyFromGit(cwd: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const detail = typeof err.stderr === "string"
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString("utf8").trim()
      : err.message;
    throw new Error(
      `Workflow role activation requires a git repository cwd (git rev-parse --git-common-dir failed): ${detail || "unknown git error"}`,
      { cause: error },
    );
  }
  if (commonDir.length === 0) {
    throw new Error("git rev-parse --git-common-dir returned an empty path");
  }
  const absoluteCommon = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const hostDirectory = basename(absoluteCommon) === ".git"
    ? dirname(absoluteCommon)
    : absoluteCommon;
  const bookKey = basename(hostDirectory);
  if (bookKey.length === 0 || bookKey === "." || bookKey === "/") {
    throw new Error(`Unable to derive activation book key from git common dir: ${absoluteCommon}`);
  }
  return bookKey;
}

/** Construct the closed fact from trusted typed inputs only (whitelist — no content keys). */
export function buildAcceptedActivationFact(input: AcceptedActivationFactInput): AcceptedActivationFact {
  return {
    event: ACCEPTED_ACTIVATION_EVENT,
    role: input.role,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    session: { kind: "session-file", path: input.session.path },
    correlation: input.correlation.kind === "caller"
      ? { kind: "caller", id: input.correlation.id }
      : { kind: "absent" },
  };
}

/** Serialize only the closed index fields (whitelist projection — no content keys). */
export function serializeAcceptedActivationFact(fact: AcceptedActivationFact): string {
  return `${JSON.stringify({
    event: fact.event,
    role: fact.role,
    observedAt: fact.observedAt,
    bookKey: fact.bookKey,
    session: { kind: "session-file", path: fact.session.path },
    correlation: fact.correlation.kind === "caller"
      ? { kind: "caller", id: fact.correlation.id }
      : { kind: "absent" },
  })}\n`;
}

/**
 * Append one complete JSONL record with O_APPEND and a single write of the full record.
 * Creates parent directories without destructive replacement. Short writes fail closed.
 */
export function appendAcceptedActivationFact(
  ledgerPath: string,
  fact: AcceptedActivationFact,
): void {
  const line = Buffer.from(serializeAcceptedActivationFact(fact), "utf8");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const fd = openSync(
    ledgerPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o644,
  );
  try {
    const written = writeSync(fd, line, 0, line.length, null);
    if (written !== line.length) {
      throw new Error(
        `activation ledger short write: wrote ${written} of ${line.length} bytes to ${ledgerPath}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

export function appendAcceptedActivationToBook(options: {
  ledgerHome: string;
  fact: AcceptedActivationFact;
}): void {
  appendAcceptedActivationFact(
    activationWaitingLedgerPath(options.ledgerHome, options.fact.bookKey),
    options.fact,
  );
}
