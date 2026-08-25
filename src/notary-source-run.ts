/**
 * Resolve and validate the public Notary source-run locator.
 * Only machine-ledger retained runs are authoritative: no project-tree projection,
 * no attachment substitute. Caller supplies a run/case pointer; Notary self-fetches.
 */
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import type { NotarySourceRunLocator } from "./notary-contracts.ts";

/** Retained identity fields required to bind a source-run pointer (run-state.json). */
type RetainedSourceRunIdentity = {
  readonly runId: string;
  readonly role: string;
  readonly bookKey: string;
  readonly runDirectory: string;
};

async function readRetainedSourceRunIdentity(
  runDirectory: string,
): Promise<RetainedSourceRunIdentity | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDirectory, "run-state.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.trim() === "") return undefined;
  if (typeof record.role !== "string" || record.role.trim() === "") return undefined;
  if (typeof record.bookKey !== "string" || record.bookKey.trim() === "") return undefined;
  const retainedDirectory =
    typeof record.runDirectory === "string" && record.runDirectory.trim() !== ""
      ? record.runDirectory
      : runDirectory;
  return {
    runId: record.runId,
    role: record.role,
    bookKey: record.bookKey,
    runDirectory: retainedDirectory,
  };
}

const RUN_DIR_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([A-Za-z][A-Za-z0-9_-]*)$/i;

export class NotarySourceRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotarySourceRunError";
  }
}

function parseRunDirectoryName(name: string): { runId: string; role: string } | undefined {
  const match = RUN_DIR_NAME.exec(name);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
}

async function requireRunDirectory(candidate: string, display: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    throw new NotarySourceRunError(
      `notary --source-run is not a readable run directory: ${display}`,
      { cause: error },
    );
  }
  let stat;
  try {
    stat = await lstat(real);
  } catch (error) {
    throw new NotarySourceRunError(
      `notary --source-run is not a readable run directory: ${display}`,
      { cause: error },
    );
  }
  if (!stat.isDirectory()) {
    throw new NotarySourceRunError(
      `notary --source-run must be a run directory: ${display}`,
    );
  }
  const identity = parseRunDirectoryName(basename(real));
  if (identity === undefined) {
    throw new NotarySourceRunError(
      `notary --source-run must be named <runId>@<role>: ${basename(real)}`,
    );
  }
  return real;
}

/**
 * Resolve `--source-run` to a machine-ledger retained run directory and typed identity.
 * Accepts:
 * - bare `<runId>@<role>` under the project's book runs home
 * - absolute/relative path that realpath's to that same book runs slot
 *
 * Rejects project-tree projections and any path outside the project's ledger book runs.
 * Retained `run-state.json` must match basename identity and book binding.
 */
export async function resolveNotarySourceRunLocator(options: {
  readonly projectRoot: string;
  readonly sourceRun: string;
  readonly home?: string;
}): Promise<NotarySourceRunLocator> {
  const raw = options.sourceRun.trim();
  if (raw === "") {
    throw new NotarySourceRunError("notary --source-run requires a run locator");
  }

  const ledgerHome = resolveActivationLedgerHome(
    options.home === undefined ? undefined : () => options.home!,
  );
  const bookKey = resolveBookKeyFromGit(options.projectRoot);
  const bookRunsRoot = join(activationBookDirectory(ledgerHome, bookKey), "runs");

  let candidate: string;
  const bare = parseRunDirectoryName(raw);
  if (bare !== undefined && !raw.includes("/") && !raw.includes("\\")) {
    candidate = join(bookRunsRoot, `${bare.runId}@${bare.role}`);
  } else {
    candidate = isAbsolute(raw) ? raw : resolve(options.projectRoot, raw);
  }

  const real = await requireRunDirectory(candidate, raw);
  const identity = parseRunDirectoryName(basename(real))!;

  const runsRootIdentity = physicalPathIdentity(bookRunsRoot);
  const parentIdentity = physicalPathIdentity(dirname(real));
  if (parentIdentity !== runsRootIdentity) {
    throw new NotarySourceRunError(
      "notary --source-run must resolve to a retained run under the project machine-ledger book",
    );
  }

  const runState = await readRetainedSourceRunIdentity(real);
  if (runState === undefined) {
    throw new NotarySourceRunError(
      "notary --source-run lacks retained run-state identity",
    );
  }
  if (runState.runId !== identity.runId || runState.role !== identity.role) {
    throw new NotarySourceRunError(
      "notary --source-run retained identity does not match directory name",
    );
  }
  if (runState.bookKey !== bookKey) {
    throw new NotarySourceRunError(
      "notary --source-run retained book binding does not match project case",
    );
  }
  if (physicalPathIdentity(runState.runDirectory) !== physicalPathIdentity(real)) {
    throw new NotarySourceRunError(
      "notary --source-run retained runDirectory does not match locator path",
    );
  }

  return {
    runDirectory: real,
    runId: identity.runId,
    role: identity.role,
  };
}

/** Internal activation loader: path is the admitted absolute source run directory. */
export async function loadNotarySourceRunLocator(
  path: string,
): Promise<NotarySourceRunLocator> {
  const real = await requireRunDirectory(path, path);
  const identity = parseRunDirectoryName(basename(real))!;
  const runState = await readRetainedSourceRunIdentity(real);
  if (runState === undefined) {
    throw new NotarySourceRunError(
      "notary source-run lacks retained run-state identity",
    );
  }
  if (runState.runId !== identity.runId || runState.role !== identity.role) {
    throw new NotarySourceRunError(
      "notary source-run retained identity does not match directory name",
    );
  }
  return {
    runDirectory: real,
    runId: identity.runId,
    role: identity.role,
  };
}
