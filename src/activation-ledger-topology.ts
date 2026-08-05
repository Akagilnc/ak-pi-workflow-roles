import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Typed activation-ledger path/fs failure. Callers discriminate with instanceof/code;
 * never by parsing message prose. Original filesystem causes are retained.
 */
export class ActivationLedgerError extends Error {
  readonly code = "AK_ACTIVATION_LEDGER" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ActivationLedgerError";
  }
}

/**
 * Sole package-owned machine home (ADR 0048 / #78): one enumerable family under
 * the process home directory. No env override — relative or invocation-varying
 * homes would split the family and can write into a consumer repository.
 * Process home must already be absolute; relative HOME is rejected before any write.
 */
export function resolveActivationLedgerHome(home: () => string = homedir): string {
  const processHome = home();
  if (typeof processHome !== "string" || processHome.length === 0 || !isAbsolute(processHome)) {
    throw new ActivationLedgerError(
      `activation ledger process home must be absolute, got ${JSON.stringify(processHome)}`,
    );
  }
  return resolve(processHome, ".ak-roles");
}

/** Enumerable book directory for one basename key. */
export function activationBookDirectory(ledgerHome: string, bookKey: string): string {
  return join(ledgerHome, "books", bookKey);
}

/** Append-only waiting ledger path for one book. */
export function activationWaitingLedgerPath(ledgerHome: string, bookKey: string): string {
  return join(activationBookDirectory(ledgerHome, bookKey), "waiting.jsonl");
}

/** True when candidate resolves strictly inside root (boundary-safe; not a string-prefix check). */
export function pathContainedIn(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function errnoCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message;
}

/**
 * Create `targetDir` (and missing parents) under `root` without following pre-existing
 * symlink components that escape the real root. Returns the real path of `targetDir`.
 * Original filesystem causes are retained.
 */
export function ensureRealDirectoryTree(root: string, targetDir: string): string {
  if (!isAbsolute(root)) {
    throw new ActivationLedgerError(`activation ledger home must be absolute: ${root}`);
  }
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(targetDir);
  if (absoluteTarget !== absoluteRoot && !pathContainedIn(absoluteRoot, absoluteTarget)) {
    throw new ActivationLedgerError(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`,
    );
  }

  try {
    mkdirSync(absoluteRoot, { recursive: true });
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger failed to create home (${absoluteRoot}): ${errorText(error)}`,
      { cause: error },
    );
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(absoluteRoot);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger home is not resolvable (${absoluteRoot}): ${errorText(error)}`,
      { cause: error },
    );
  }
  if (!statSync(realRoot).isDirectory()) {
    throw new ActivationLedgerError(`activation ledger home is not a directory: ${realRoot}`);
  }

  const rel = absoluteTarget === absoluteRoot ? "" : relative(absoluteRoot, absoluteTarget);
  if (rel === "") return realRoot;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ActivationLedgerError(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`,
    );
  }

  let lexicalCursor = absoluteRoot;
  for (const part of rel.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new ActivationLedgerError(`activation ledger path contains '..': ${absoluteTarget}`);
    }
    lexicalCursor = join(lexicalCursor, part);

    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(lexicalCursor);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw new ActivationLedgerError(
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
          throw new ActivationLedgerError(
            `activation ledger failed to create directory (${lexicalCursor}): ${errorText(mkdirError)}`,
            { cause: mkdirError },
          );
        }
      }
      try {
        st = lstatSync(lexicalCursor);
      } catch (statError) {
        throw new ActivationLedgerError(
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
        throw new ActivationLedgerError(
          `activation ledger symlink component is not resolvable (${lexicalCursor}): ${errorText(error)}`,
          { cause: error },
        );
      }
      if (realNext !== realRoot && !pathContainedIn(realRoot, realNext)) {
        throw new ActivationLedgerError(
          `activation ledger path component escapes ledger home via symlink (${lexicalCursor} -> ${realNext})`,
        );
      }
      if (!statSync(realNext).isDirectory()) {
        throw new ActivationLedgerError(`activation ledger path component is not a directory: ${realNext}`);
      }
      continue;
    }

    if (!st.isDirectory()) {
      throw new ActivationLedgerError(`activation ledger path component is not a directory: ${lexicalCursor}`);
    }

    let realCursor: string;
    try {
      realCursor = realpathSync(lexicalCursor);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger path component is not resolvable (${lexicalCursor}): ${errorText(error)}`,
        { cause: error },
      );
    }
    if (realCursor !== realRoot && !pathContainedIn(realRoot, realCursor)) {
      throw new ActivationLedgerError(
        `activation ledger path component escapes ledger home (${lexicalCursor} -> ${realCursor})`,
      );
    }
  }

  try {
    return realpathSync(absoluteTarget);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger directory is not resolvable (${absoluteTarget}): ${errorText(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reject a pre-existing ledger-file symlink that escapes the real ledger home
 * before open/write follows it.
 */
export function assertLedgerFileInsideHome(ledgerPath: string, ledgerHome: string): void {
  if (!isAbsolute(ledgerHome)) {
    throw new ActivationLedgerError(`activation ledger home must be absolute: ${ledgerHome}`);
  }
  const resolvedLedger = resolve(ledgerPath);
  const resolvedHome = resolve(ledgerHome);
  try {
    if (!lstatSync(resolvedLedger).isSymbolicLink()) return;
    let realFile: string;
    try {
      realFile = realpathSync(resolvedLedger);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger file symlink is not resolvable (${resolvedLedger}): ${errorText(error)}`,
        { cause: error },
      );
    }
    const realHome = realpathSync(resolvedHome);
    if (realFile !== realHome && !pathContainedIn(realHome, realFile)) {
      throw new ActivationLedgerError(
        `activation ledger file escapes ledger home via symlink (${resolvedLedger} -> ${realFile})`,
      );
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      if (error instanceof ActivationLedgerError) throw error;
      throw new ActivationLedgerError(
        `activation ledger failed to stat ledger file (${resolvedLedger}): ${errorText(error)}`,
        { cause: error },
      );
    }
  }
}
