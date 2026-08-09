import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * Physical path identity: realpath the longest existing prefix, then rejoin any
 * not-yet-created suffix. Collapses macOS `/var` ↔ `/private/var` so containment
 * checks do not depend on which side was realpath'd first.
 */
export function physicalPathIdentity(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const real = realpathSync(cursor);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        // Non-absence failures keep lexical resolve — callers still get a path.
        return absolute;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Containment under physical path identity (symlink-stable). */
export function physicallyContainedIn(root: string, candidate: string): boolean {
  return pathContainedIn(physicalPathIdentity(root), physicalPathIdentity(candidate));
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
 * Ensure the configured ledger root is a physical directory identity.
 * lstat before create/realpath: a root symlink is never admitted, even when its
 * target is a directory. Missing roots are created; post-create re-lstat covers
 * a concurrent symlink swap. Native stat/mkdir causes are retained.
 */
function assertPhysicalLedgerRoot(absoluteRoot: string): void {
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(absoluteRoot);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw new ActivationLedgerError(
        `activation ledger failed to stat home (${absoluteRoot}): ${errorText(error)}`,
        { cause: error },
      );
    }
  }

  if (st === undefined) {
    try {
      mkdirSync(absoluteRoot, { recursive: true });
    } catch (error) {
      // The configured root has the same first-creator race as nested components:
      // another process may win after our ENOENT observation. Admit only EEXIST,
      // then type-check the winner below; every other native failure remains fatal.
      if (errnoCode(error) !== "EEXIST") {
        throw new ActivationLedgerError(
          `activation ledger failed to create home (${absoluteRoot}): ${errorText(error)}`,
          { cause: error },
        );
      }
    }
    try {
      st = lstatSync(absoluteRoot);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger failed to stat home (${absoluteRoot}): ${errorText(error)}`,
        { cause: error },
      );
    }
  }

  if (st.isSymbolicLink()) {
    throw new ActivationLedgerError(
      `activation ledger home is a symbolic link: ${absoluteRoot}`,
    );
  }
  if (!st.isDirectory()) {
    throw new ActivationLedgerError(`activation ledger home is not a directory: ${absoluteRoot}`);
  }
}

/**
 * Create `targetDir` (and missing parents) under `root` as a physical directory chain.
 * Every path component under the configured root is type-identified with lstat: a
 * pre-existing symlink is never admitted — even when its target remains inside the
 * machine home — so basename book partitions cannot alias across books (ADR 0048).
 * The configured root itself must be a physical directory. Physical realpath
 * containment and native filesystem causes are retained.
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

  // Type-identity the configured root before realpath/creation. Nested component
  // physical identity and containment below still apply once the root is physical.
  assertPhysicalLedgerRoot(absoluteRoot);

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

    // Book partitions and every parent under the machine home must be physical
    // owned directories — in-home directory symlinks alias partitions (cross-book).
    if (st.isSymbolicLink()) {
      throw new ActivationLedgerError(
        `activation ledger path component is a symbolic link: ${lexicalCursor}`,
      );
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
 * Reject a pre-existing ledger-file symlink before open/write follows it.
 * A computed book may only append to its own regular waiting.jsonl — any symlink,
 * including a target still inside the machine ledger home (cross-book redirect),
 * violates ADR 0048 partition identity. Missing paths are admitted (O_CREAT).
 */
export function assertLedgerFileInsideHome(ledgerPath: string, ledgerHome: string): void {
  if (!isAbsolute(ledgerHome)) {
    throw new ActivationLedgerError(`activation ledger home must be absolute: ${ledgerHome}`);
  }
  const resolvedLedger = resolve(ledgerPath);
  try {
    if (!lstatSync(resolvedLedger).isSymbolicLink()) return;
    throw new ActivationLedgerError(
      `activation ledger file is a symbolic link: ${resolvedLedger}`,
    );
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
