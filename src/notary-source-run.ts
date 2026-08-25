/**
 * Resolve and validate the public Notary source-run locator.
 * Callers pass a typed path (or book-relative run id@role); Notary never accepts
 * instruction/attachment projection of the subject.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  pathContainedIn,
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import type { NotarySourceRunLocator } from "./notary-contracts.ts";

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
 * Resolve `--source-run` to an absolute existing run directory and typed identity.
 * Accepts:
 * - absolute/relative path to `.../runs/<runId>@<role>`
 * - bare `<runId>@<role>` under the project's book runs home
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

  let candidate: string;
  const bare = parseRunDirectoryName(raw);
  if (bare !== undefined && !raw.includes("/") && !raw.includes("\\")) {
    const ledgerHome = resolveActivationLedgerHome(
      options.home === undefined ? undefined : () => options.home!,
    );
    const bookKey = resolveBookKeyFromGit(options.projectRoot);
    candidate = join(
      activationBookDirectory(ledgerHome, bookKey),
      "runs",
      `${bare.runId}@${bare.role}`,
    );
  } else {
    candidate = isAbsolute(raw) ? raw : resolve(options.projectRoot, raw);
  }

  const real = await requireRunDirectory(candidate, raw);
  const identity = parseRunDirectoryName(basename(real))!;

  const ledgerHome = resolveActivationLedgerHome(
    options.home === undefined ? undefined : () => options.home!,
  );
  const projectRoot = physicalPathIdentity(options.projectRoot);
  const homeRoot = physicalPathIdentity(ledgerHome);
  if (!pathContainedIn(homeRoot, real) && !pathContainedIn(projectRoot, real)) {
    throw new NotarySourceRunError(
      "notary --source-run escapes ledger home and project root",
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
  return {
    runDirectory: real,
    runId: identity.runId,
    role: identity.role,
  };
}
