/**
 * Resolve and validate the public Notary source-run locator.
 * Only machine-ledger retained runs are authoritative: no project-tree projection,
 * no attachment substitute. Caller supplies a run/case pointer; Notary self-fetches.
 */
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { lstat, realpath } from "node:fs/promises";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import type { NotarySourceRunLocator } from "./notary-contracts.ts";
import { findRunDirectoryById, readRoleRunIdentity } from "./public-cli/run-lifecycle.ts";
import { formatRunLeaf, parseRunLeaf } from "./role-run-placement.ts";

async function readRetainedIdentity(runDirectory: string) {
  try {
    return await readRoleRunIdentity(runDirectory);
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
    throw new NotarySourceRunError("notary --source-run has invalid retained run-state identity", {
      cause: error,
    });
  }
}

export class NotarySourceRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotarySourceRunError";
  }
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
  const identity = parseRunLeaf(basename(real));
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
 * Retained state.jsonl run-state must match basename identity and book binding.
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

  const ledgerHome = resolveActivationLedgerHome(options.home);
  const bookKey = resolveBookKeyFromGit(options.projectRoot);
  const bookDirectory = activationBookDirectory(ledgerHome, bookKey);
  const bookRunsRoot = join(bookDirectory, "runs");

  let candidate: string;
  const bare = parseRunLeaf(raw);
  if (bare !== undefined && !raw.includes("/") && !raw.includes("\\")) {
    candidate = (await findRunDirectoryById(options.home, bare.runId, bookKey, bare.role))
      ?? join(bookRunsRoot, formatRunLeaf(bare.runId, bare.role));
  } else {
    candidate = isAbsolute(raw) ? raw : resolve(options.projectRoot, raw);
    const identity = parseRunLeaf(basename(candidate));
    const subjectDirectory = dirname(dirname(candidate));
    const isLegacyUnboundLocator =
      identity !== undefined &&
      basename(dirname(candidate)) === "runs" &&
      basename(subjectDirectory) === "unbound" &&
      resolve(dirname(subjectDirectory)) === resolve(bookDirectory);
    if (isLegacyUnboundLocator) {
      candidate = (await findRunDirectoryById(
        options.home,
        identity.runId,
        bookKey,
        identity.role,
      )) ?? candidate;
    }
  }

  const real = await requireRunDirectory(candidate, raw);
  const identity = parseRunLeaf(basename(real))!;

  const bookIdentity = physicalPathIdentity(bookDirectory);
  const parentIdentity = physicalPathIdentity(dirname(real));
  const subjectBookIdentity = physicalPathIdentity(dirname(dirname(dirname(real))));
  if (
    parentIdentity !== physicalPathIdentity(bookRunsRoot) &&
    !(basename(dirname(real)) === "runs" && subjectBookIdentity === bookIdentity)
  ) {
    throw new NotarySourceRunError(
      "notary --source-run must resolve to a retained run under the project machine-ledger book",
    );
  }

  // Authoritative retained record only — legal role/state via shared reader (DRY #14).
  // Identity envelope only: principal payload is not interpreted here.
  const runState = await readRetainedIdentity(real);
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
  const identity = parseRunLeaf(basename(real))!;
  const runState = await readRetainedIdentity(real);
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
  if (physicalPathIdentity(runState.runDirectory) !== physicalPathIdentity(real)) {
    throw new NotarySourceRunError(
      "notary source-run retained runDirectory does not match locator path",
    );
  }
  return {
    runDirectory: real,
    runId: identity.runId,
    role: identity.role,
  };
}
