import {
  lstatSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  errnoCode,
  errorText
} from "./activation-ledger-topology.js";
class ActivationSessionFileMissingError extends Error {
  code = "AK_ACTIVATION_SESSION_FILE_MISSING";
  path;
  constructor(path, options) {
    super(
      `Workflow role activation durable session file does not exist: ${path}`,
      options?.cause === void 0 ? void 0 : { cause: options.cause }
    );
    this.name = "ActivationSessionFileMissingError";
    this.path = path;
  }
}
function materializeDeferredSessionFile(sessionManager, resolvedFile) {
  const header = sessionManager.getHeader?.();
  if (header === null || header === void 0 || header.type !== "session") {
    throw new ActivationSessionFileMissingError(resolvedFile);
  }
  try {
    writeFileSync(resolvedFile, `${JSON.stringify(header)}
`, { flag: "wx" });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") {
      throw new Error(
        `Workflow role activation failed to materialize durable session file (${resolvedFile}): ${errorText(error)}`,
        { cause: error }
      );
    }
  }
  if (typeof sessionManager.setSessionFile === "function") {
    sessionManager.setSessionFile(resolvedFile);
  }
}
function durableSessionPointer(sessionManager) {
  const file = sessionManager.getSessionFile?.();
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(
      "Workflow role activation requires a durable Pi session file principal (getSessionFile); directory-only or --no-session invocations are rejected"
    );
  }
  if (!isAbsolute(file)) {
    throw new Error(
      `Workflow role activation requires an absolute durable session file path; got relative path: ${file}`
    );
  }
  const resolvedFile = resolve(file);
  try {
    lstatSync(resolvedFile);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw new Error(
        `Workflow role activation failed to stat durable session file (${resolvedFile}): ${errorText(error)}`,
        { cause: error }
      );
    }
    try {
      materializeDeferredSessionFile(sessionManager, resolvedFile);
    } catch (materializeError) {
      if (materializeError instanceof ActivationSessionFileMissingError) {
        throw new ActivationSessionFileMissingError(resolvedFile, { cause: error });
      }
      throw materializeError;
    }
  }
  let realFile;
  try {
    realFile = realpathSync(resolvedFile);
  } catch (error) {
    throw new ActivationSessionFileMissingError(resolvedFile, { cause: error });
  }
  let info;
  try {
    info = statSync(realFile);
  } catch (error) {
    throw new Error(
      `Workflow role activation failed to stat durable session file (${realFile}): ${errorText(error)}`,
      { cause: error }
    );
  }
  if (info.isDirectory()) {
    throw new Error(
      `Workflow role activation durable session principal must be a file, not a directory: ${realFile}`
    );
  }
  if (!info.isFile()) {
    throw new Error(
      `Workflow role activation durable session principal is not a regular file: ${realFile}`
    );
  }
  return { kind: "session-file", path: realFile };
}
export {
  ActivationSessionFileMissingError,
  durableSessionPointer
};
