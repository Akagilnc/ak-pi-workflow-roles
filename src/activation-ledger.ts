import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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

/** Session manager surface needed to admit (and, when deferred, materialize) the durable principal. */
export type ActivationSessionManager = {
  getSessionFile?(): string | undefined;
  getHeader?(): { readonly type: string } | null;
  /** Full SessionManager rebind after early header materialization (keeps Pi append path consistent). */
  setSessionFile?(path: string): void;
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
 * Host correlation channel (not a CLI flag): a non-blank AK_CORRELATION_ID carries
 * the caller id verbatim; missing/blank/whitespace-only yields the typed absent identity.
 */
export function correlationIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ActivationCorrelationIdentity {
  const raw = env.AK_CORRELATION_ID;
  if (typeof raw === "string" && raw.trim().length > 0) {
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

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message;
}

/**
 * Create `targetDir` (and missing parents) under `root` without following pre-existing
 * symlink components that escape the real root. Returns the real path of `targetDir`.
 * Original filesystem causes are retained.
 */
function ensureRealDirectoryTree(root: string, targetDir: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(targetDir);
  if (absoluteTarget !== absoluteRoot && !pathContainedIn(absoluteRoot, absoluteTarget)) {
    throw new Error(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`,
    );
  }

  try {
    mkdirSync(absoluteRoot, { recursive: true });
  } catch (error) {
    throw new Error(
      `activation ledger failed to create home (${absoluteRoot}): ${errorText(error)}`,
      { cause: error },
    );
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(absoluteRoot);
  } catch (error) {
    throw new Error(
      `activation ledger home is not resolvable (${absoluteRoot}): ${errorText(error)}`,
      { cause: error },
    );
  }
  if (!statSync(realRoot).isDirectory()) {
    throw new Error(`activation ledger home is not a directory: ${realRoot}`);
  }

  const rel = absoluteTarget === absoluteRoot ? "" : relative(absoluteRoot, absoluteTarget);
  if (rel === "") return realRoot;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`,
    );
  }

  let lexicalCursor = absoluteRoot;
  for (const part of rel.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new Error(`activation ledger path contains '..': ${absoluteTarget}`);
    }
    lexicalCursor = join(lexicalCursor, part);

    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(lexicalCursor);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw new Error(
          `activation ledger failed to stat path component (${lexicalCursor}): ${errorText(error)}`,
          { cause: error },
        );
      }
      try {
        mkdirSync(lexicalCursor);
      } catch (mkdirError) {
        // Concurrent first-time creators can lose the mkdir race. Only EEXIST is
        // recoverable; re-lstat/realpath validation below still admits the winner.
        if (errnoCode(mkdirError) !== "EEXIST") {
          throw new Error(
            `activation ledger failed to create directory (${lexicalCursor}): ${errorText(mkdirError)}`,
            { cause: mkdirError },
          );
        }
      }
      try {
        st = lstatSync(lexicalCursor);
      } catch (statError) {
        throw new Error(
          `activation ledger failed to stat path component (${lexicalCursor}): ${errorText(statError)}`,
          { cause: statError },
        );
      }
    }

    if (st.isSymbolicLink()) {
      let realNext: string;
      try {
        realNext = realpathSync(lexicalCursor);
      } catch (error) {
        throw new Error(
          `activation ledger symlink component is not resolvable (${lexicalCursor}): ${errorText(error)}`,
          { cause: error },
        );
      }
      if (realNext !== realRoot && !pathContainedIn(realRoot, realNext)) {
        throw new Error(
          `activation ledger path component escapes ledger home via symlink (${lexicalCursor} -> ${realNext})`,
        );
      }
      if (!statSync(realNext).isDirectory()) {
        throw new Error(`activation ledger path component is not a directory: ${realNext}`);
      }
      continue;
    }

    if (!st.isDirectory()) {
      throw new Error(`activation ledger path component is not a directory: ${lexicalCursor}`);
    }

    let realCursor: string;
    try {
      realCursor = realpathSync(lexicalCursor);
    } catch (error) {
      throw new Error(
        `activation ledger path component is not resolvable (${lexicalCursor}): ${errorText(error)}`,
        { cause: error },
      );
    }
    if (realCursor !== realRoot && !pathContainedIn(realRoot, realCursor)) {
      throw new Error(
        `activation ledger path component escapes ledger home (${lexicalCursor} -> ${realCursor})`,
      );
    }
  }

  try {
    return realpathSync(absoluteTarget);
  } catch (error) {
    throw new Error(
      `activation ledger directory is not resolvable (${absoluteTarget}): ${errorText(error)}`,
      { cause: error },
    );
  }
}

function materializeDeferredSessionFile(
  sessionManager: ActivationSessionManager,
  resolvedFile: string,
  ledgerHome: string,
): void {
  const header = sessionManager.getHeader?.();
  if (header === null || header === undefined || header.type !== "session") {
    throw new Error(
      `Workflow role activation durable session file does not exist: ${resolvedFile}`,
    );
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
export function durableSessionPointer(
  sessionManager: ActivationSessionManager,
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
      if (
        materializeError instanceof Error
        && materializeError.message.startsWith("Workflow role activation durable session file does not exist:")
      ) {
        throw new Error(materializeError.message, { cause: error });
      }
      throw materializeError;
    }
  }

  let realBook: string;
  try {
    realBook = realpathSync(bookRoot);
  } catch (error) {
    throw new Error(
      `Workflow role activation machine ledger book is not resolvable (${bookRoot}): ${errorText(error)}`,
      { cause: error },
    );
  }

  let realFile: string;
  try {
    realFile = realpathSync(resolvedFile);
  } catch (error) {
    throw new Error(
      `Workflow role activation durable session file does not exist: ${resolvedFile}`,
      { cause: error },
    );
  }

  if (!pathContainedIn(realBook, realFile)) {
    throw new Error(
      `Workflow role activation requires the durable session file principal under the machine ledger book (${realBook}); got: ${realFile}`,
    );
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

/** Git discovery env vars that must not influence book-key resolution from cwd. */
const GIT_DISCOVERY_ENV_KEYS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

function envWithoutGitDiscovery(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_DISCOVERY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Typed book-key discovery failure: a git child ran and reported non-repository status.
 * Original git cause (nonzero exit) is retained. Spawn/OS failures never become this type.
 */
export class ActivationGitRepositoryRequiredError extends Error {
  readonly code = "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED" as const;
  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      `Workflow role activation requires a git repository cwd (git rev-parse --git-common-dir failed): ${detail || "unknown git error"}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ActivationGitRepositoryRequiredError";
  }
}

/** Spawn/OS failure identity for the git child — not a repository-status result. */
function isGitSpawnInfrastructureError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

/** True when the git child process started and exited with a typed nonzero status. */
function gitChildExitedNonzero(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" && status !== 0;
}

/**
 * Book key = basename of the git common-dir host directory (ADR 0048).
 * Worktrees resolve to the main repository host.
 * A git child that exits nonzero becomes ActivationGitRepositoryRequiredError with cause;
 * spawn/infrastructure failures (ENOENT/EACCES/EPERM) retain their own identity.
 * Discovery is bound to `cwd` only — caller-controlled GIT_DIR / GIT_COMMON_DIR /
 * work-tree / ceiling / discovery env cannot redirect the lookup.
 */
export function resolveBookKeyFromGit(cwd: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithoutGitDiscovery(),
    }).trim();
  } catch (error) {
    // Infrastructure (missing binary, permission) keeps its own identity.
    // Only a git child that ran and returned nonzero may become the typed non-git error.
    // Do not classify by stderr prose.
    if (isGitSpawnInfrastructureError(error) || !gitChildExitedNonzero(error)) {
      throw error;
    }
    const err = error as { stderr?: string | Buffer; message?: string };
    const detail = typeof err.stderr === "string"
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString("utf8").trim()
      : typeof err.message === "string"
      ? err.message
      : "";
    throw new ActivationGitRepositoryRequiredError(detail || "unknown git error", { cause: error });
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

/**
 * Sole closed whitelist projection for accepted-activation facts (ADR 0049).
 * Build and serialize both consume this — zero content keys, no dual projection drift.
 */
function projectAcceptedActivationFact(input: {
  readonly role: string;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly session: ActivationSessionPointer;
  readonly correlation: ActivationCorrelationIdentity;
}): AcceptedActivationFact {
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

/** Construct the closed fact from trusted typed inputs only (whitelist — no content keys). */
export function buildAcceptedActivationFact(input: AcceptedActivationFactInput): AcceptedActivationFact {
  return projectAcceptedActivationFact(input);
}

/** Serialize only the closed index fields (whitelist projection — no content keys). */
export function serializeAcceptedActivationFact(fact: AcceptedActivationFact): string {
  return `${JSON.stringify(projectAcceptedActivationFact(fact))}\n`;
}

/**
 * Append one complete JSONL record with O_APPEND and a single write of the full record.
 * Creates parent directories without destructive replacement, rejecting pre-existing
 * symlink component escapes via filesystem identity. Short writes fail closed.
 */
export function appendAcceptedActivationFact(
  ledgerPath: string,
  fact: AcceptedActivationFact,
  options: { ledgerHome: string },
): void {
  const line = Buffer.from(serializeAcceptedActivationFact(fact), "utf8");
  const resolvedLedger = resolve(ledgerPath);
  const resolvedHome = resolve(options.ledgerHome);
  const parent = dirname(resolvedLedger);
  ensureRealDirectoryTree(resolvedHome, parent);

  // Parent is proven under the real ledger home. Reject a pre-existing ledger
  // file symlink that escapes the home before O_APPEND follows it.
  try {
    if (lstatSync(resolvedLedger).isSymbolicLink()) {
      let realFile: string;
      try {
        realFile = realpathSync(resolvedLedger);
      } catch (error) {
        throw new Error(
          `activation ledger file symlink is not resolvable (${resolvedLedger}): ${errorText(error)}`,
          { cause: error },
        );
      }
      const realHome = realpathSync(resolvedHome);
      if (realFile !== realHome && !pathContainedIn(realHome, realFile)) {
        throw new Error(
          `activation ledger file escapes ledger home via symlink (${resolvedLedger} -> ${realFile})`,
        );
      }
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      if (error instanceof Error && error.message.startsWith("activation ledger")) throw error;
      throw new Error(
        `activation ledger failed to stat ledger file (${resolvedLedger}): ${errorText(error)}`,
        { cause: error },
      );
    }
  }

  const fd = openSync(
    resolvedLedger,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o644,
  );
  try {
    const written = writeSync(fd, line, 0, line.length, null);
    if (written !== line.length) {
      throw new Error(
        `activation ledger short write: wrote ${written} of ${line.length} bytes to ${resolvedLedger}`,
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
    { ledgerHome: options.ledgerHome },
  );
}
