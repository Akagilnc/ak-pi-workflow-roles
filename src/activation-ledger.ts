import { constants, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Caller-preassigned correlation id, or an explicit absent identity (never empty string). */
export type ActivationCorrelationIdentity =
  | { readonly kind: "caller"; readonly id: string }
  | { readonly kind: "absent" };

/** Durable pointer to the Pi session principal — file when persisted, else directory. */
export type ActivationSessionPointer =
  | { readonly kind: "session-file"; readonly path: string }
  | { readonly kind: "session-directory"; readonly path: string };

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

const CONTENT_LIKE_KEYS = [
  "prompt",
  "transcript",
  "argv",
  "excerpt",
  "excerpts",
  "content",
  "body",
  "message",
  "messages",
] as const;

/** Package-owned machine home (ADR 0048). Host may override via AK_ROLES_HOME. */
export function resolveActivationLedgerHome(
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  const override = env.AK_ROLES_HOME;
  if (typeof override === "string" && override.length > 0) return override;
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

export function durableSessionPointer(sessionManager: {
  getSessionFile?(): string | undefined;
  getSessionDir(): string;
}): ActivationSessionPointer {
  const file = sessionManager.getSessionFile?.();
  if (typeof file === "string" && file.length > 0) {
    return { kind: "session-file", path: file };
  }
  return { kind: "session-directory", path: sessionManager.getSessionDir() };
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
    session: input.session.kind === "session-file"
      ? { kind: "session-file", path: input.session.path }
      : { kind: "session-directory", path: input.session.path },
    correlation: input.correlation.kind === "caller"
      ? { kind: "caller", id: input.correlation.id }
      : { kind: "absent" },
  };
}

/** Serialize only the closed index fields. Extra content-like keys are never emitted. */
export function serializeAcceptedActivationFact(fact: AcceptedActivationFact): string {
  const record: Record<string, unknown> = {
    event: fact.event,
    role: fact.role,
    observedAt: fact.observedAt,
    bookKey: fact.bookKey,
    session: fact.session.kind === "session-file"
      ? { kind: "session-file", path: fact.session.path }
      : { kind: "session-directory", path: fact.session.path },
    correlation: fact.correlation.kind === "caller"
      ? { kind: "caller", id: fact.correlation.id }
      : { kind: "absent" },
  };
  for (const key of CONTENT_LIKE_KEYS) {
    delete record[key];
  }
  return `${JSON.stringify(record)}\n`;
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
