import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
class ActivationLedgerError extends Error {
  code = "AK_ACTIVATION_LEDGER";
  constructor(message, options) {
    super(
      message,
      options?.cause === void 0 ? void 0 : { cause: options.cause }
    );
    this.name = "ActivationLedgerError";
  }
}
function resolveActivationLedgerHome(home = homedir) {
  const processHome = home();
  if (typeof processHome !== "string" || processHome.length === 0 || !isAbsolute(processHome)) {
    throw new ActivationLedgerError(
      `activation ledger process home must be absolute, got ${JSON.stringify(processHome)}`
    );
  }
  return resolve(processHome, ".ak-roles");
}
function activationBookDirectory(ledgerHome, bookKey) {
  return join(ledgerHome, "books", bookKey);
}
function activationWaitingLedgerPath(ledgerHome, bookKey) {
  return join(activationBookDirectory(ledgerHome, bookKey), "waiting.jsonl");
}
function pathContainedIn(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function physicalPathIdentity(path) {
  const absolute = resolve(path);
  const missing = [];
  let cursor = absolute;
  while (true) {
    try {
      const real = realpathSync(cursor);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        return absolute;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
function physicallyContainedIn(root, candidate) {
  return pathContainedIn(physicalPathIdentity(root), physicalPathIdentity(candidate));
}
function errnoCode(error) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : void 0;
}
function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  return error.message;
}
function assertPhysicalLedgerRoot(absoluteRoot) {
  let st;
  try {
    st = lstatSync(absoluteRoot);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw new ActivationLedgerError(
        `activation ledger failed to stat home (${absoluteRoot}): ${errorText(error)}`,
        { cause: error }
      );
    }
  }
  if (st === void 0) {
    try {
      mkdirSync(absoluteRoot, { recursive: true });
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") {
        throw new ActivationLedgerError(
          `activation ledger failed to create home (${absoluteRoot}): ${errorText(error)}`,
          { cause: error }
        );
      }
    }
    try {
      st = lstatSync(absoluteRoot);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger failed to stat home (${absoluteRoot}): ${errorText(error)}`,
        { cause: error }
      );
    }
  }
  if (st.isSymbolicLink()) {
    throw new ActivationLedgerError(
      `activation ledger home is a symbolic link: ${absoluteRoot}`
    );
  }
  if (!st.isDirectory()) {
    throw new ActivationLedgerError(`activation ledger home is not a directory: ${absoluteRoot}`);
  }
}
function ensureRealDirectoryTree(root, targetDir) {
  if (!isAbsolute(root)) {
    throw new ActivationLedgerError(`activation ledger home must be absolute: ${root}`);
  }
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(targetDir);
  if (absoluteTarget !== absoluteRoot && !pathContainedIn(absoluteRoot, absoluteTarget)) {
    throw new ActivationLedgerError(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`
    );
  }
  assertPhysicalLedgerRoot(absoluteRoot);
  let realRoot;
  try {
    realRoot = realpathSync(absoluteRoot);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger home is not resolvable (${absoluteRoot}): ${errorText(error)}`,
      { cause: error }
    );
  }
  if (!statSync(realRoot).isDirectory()) {
    throw new ActivationLedgerError(`activation ledger home is not a directory: ${realRoot}`);
  }
  const rel = absoluteTarget === absoluteRoot ? "" : relative(absoluteRoot, absoluteTarget);
  if (rel === "") return realRoot;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ActivationLedgerError(
      `activation ledger path escapes ledger home (${absoluteRoot}): ${absoluteTarget}`
    );
  }
  let lexicalCursor = absoluteRoot;
  for (const part of rel.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new ActivationLedgerError(`activation ledger path contains '..': ${absoluteTarget}`);
    }
    lexicalCursor = join(lexicalCursor, part);
    let st;
    try {
      st = lstatSync(lexicalCursor);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw new ActivationLedgerError(
          `activation ledger failed to stat path component (${lexicalCursor}): ${errorText(error)}`,
          { cause: error }
        );
      }
      try {
        mkdirSync(lexicalCursor);
      } catch (mkdirError) {
        if (errnoCode(mkdirError) !== "EEXIST") {
          throw new ActivationLedgerError(
            `activation ledger failed to create directory (${lexicalCursor}): ${errorText(mkdirError)}`,
            { cause: mkdirError }
          );
        }
      }
      try {
        st = lstatSync(lexicalCursor);
      } catch (statError) {
        throw new ActivationLedgerError(
          `activation ledger failed to stat path component (${lexicalCursor}): ${errorText(statError)}`,
          { cause: statError }
        );
      }
    }
    if (st.isSymbolicLink()) {
      throw new ActivationLedgerError(
        `activation ledger path component is a symbolic link: ${lexicalCursor}`
      );
    }
    if (!st.isDirectory()) {
      throw new ActivationLedgerError(`activation ledger path component is not a directory: ${lexicalCursor}`);
    }
    let realCursor;
    try {
      realCursor = realpathSync(lexicalCursor);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger path component is not resolvable (${lexicalCursor}): ${errorText(error)}`,
        { cause: error }
      );
    }
    if (realCursor !== realRoot && !pathContainedIn(realRoot, realCursor)) {
      throw new ActivationLedgerError(
        `activation ledger path component escapes ledger home (${lexicalCursor} -> ${realCursor})`
      );
    }
  }
  try {
    return realpathSync(absoluteTarget);
  } catch (error) {
    throw new ActivationLedgerError(
      `activation ledger directory is not resolvable (${absoluteTarget}): ${errorText(error)}`,
      { cause: error }
    );
  }
}
function assertLedgerFileInsideHome(ledgerPath, ledgerHome) {
  if (!isAbsolute(ledgerHome)) {
    throw new ActivationLedgerError(`activation ledger home must be absolute: ${ledgerHome}`);
  }
  const resolvedLedger = resolve(ledgerPath);
  try {
    if (!lstatSync(resolvedLedger).isSymbolicLink()) return;
    throw new ActivationLedgerError(
      `activation ledger file is a symbolic link: ${resolvedLedger}`
    );
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      if (error instanceof ActivationLedgerError) throw error;
      throw new ActivationLedgerError(
        `activation ledger failed to stat ledger file (${resolvedLedger}): ${errorText(error)}`,
        { cause: error }
      );
    }
  }
}
export {
  ActivationLedgerError,
  activationBookDirectory,
  activationWaitingLedgerPath,
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  errnoCode,
  errorText,
  pathContainedIn,
  physicalPathIdentity,
  physicallyContainedIn,
  resolveActivationLedgerHome
};
