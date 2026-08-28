import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  INSTITUTIONAL_RESOLUTION_FILE,
  resolveInstitutionalSeatSelections,
  type InstitutionalResolutionPage,
} from "../../src/institutional-resolution.ts";
import {
  publicCliConfigPath,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";

/**
 * Shared seat table for institutional consumer tests (#518 S3).
 * Writes an institutional-resolution.json page into a run directory so real
 * evidence-child / auditor / gatekeeper consumers can read their seat via
 * readInstitutionalSeatSelection. Tests that drive these consumers must install
 * the page before the consumer runs; the page is the explicit-selection contract
 * that replaced ambient parent Provider/context.model inheritance.
 */
export async function writeInstitutionalSeatTable(
  runDirectory: string,
  seats: InstitutionalResolutionPage["seats"],
): Promise<void> {
  writeFileSync(
    join(runDirectory, INSTITUTIONAL_RESOLUTION_FILE),
    `${JSON.stringify({ version: 1 as const, seats }, null, 2)}\n`,
    "utf8",
  );
}

/** Minimal per-seat selection used by most consumer tests (single provider/model). */
export function seatSelection(
  provider: string,
  model: string,
  thinking?: string,
): { provider: string; model: string; thinking?: string } {
  return thinking === undefined
    ? { provider, model }
    : { provider, model, thinking };
}

/** Parent model shape accepted by the seat-table fixtures. */
export type ParentModel = {
  provider: string;
  model?: string;
  id?: string;
  thinking?: string;
};

function normalizeParentSelection(parentModel: ParentModel): { provider: string; model: string; thinking?: string } {
  return {
    provider: parentModel.provider,
    model: (parentModel.model ?? parentModel.id ?? "") as string,
    ...(parentModel.thinking === undefined ? {} : { thinking: parentModel.thinking }),
  };
}

/**
 * Parent-inherited seats for every institutional consumer (the "unconfigured"
 * gate behavior: gate/officer/auditor all inherit the parent model). Thin
 * adaptation used by harnesses with no persistent config overrides.
 */
export function parentInheritedSeats(parentModel: ParentModel): InstitutionalResolutionPage["seats"] {
  const selection = normalizeParentSelection(parentModel);
  return {
    gatekeeper: selection,
    inspector: selection,
    notary: selection,
    auditor: selection,
    evidenceChild: selection,
  };
}

export type SeatTableInstall = {
  readonly runDirectory: string;
  /** Restore the previous AK_ROLE_RUN_DIR and remove the temp run directory. */
  dispose(): void;
};

/**
 * Outstanding installs awaiting disposal, tracked so a node:test afterEach can
 * guarantee teardown for context-transformer harnesses (which have no natural
 * inline finally scope around the consumer execute). Disposed in reverse
 * insertion order so nested env overrides cascade back to the original value.
 */
const activeInstalls: SeatTableInstall[] = [];

/** Dispose every tracked install (reverse order), restoring env + removing temp dirs. */
export function disposeAllInstitutionalSeatTables(): void {
  while (activeInstalls.length > 0) {
    const install = activeInstalls.pop()!;
    install.dispose();
  }
}

/**
 * Install an institutional resolution page into a unique temp run directory and
 * point AK_ROLE_RUN_DIR at it. Caller should dispose() (ideally in a finally);
 * installs are also tracked so disposeAllInstitutionalSeatTables() can guarantee
 * teardown. Unique per-install, so overlapping tests never share a fixed dir.
 */
export function installInstitutionalSeatTable(
  seats: InstitutionalResolutionPage["seats"],
): SeatTableInstall {
  const runDirectory = mkdtempSync(join(tmpdir(), "ak-seat-table-"));
  writeFileSync(
    join(runDirectory, INSTITUTIONAL_RESOLUTION_FILE),
    `${JSON.stringify({ version: 1 as const, seats }, null, 2)}\n`,
    "utf8",
  );
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  const install: SeatTableInstall = {
    runDirectory,
    dispose() {
      if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previous;
      rmSync(runDirectory, { recursive: true, force: true });
    },
  };
  activeInstalls.push(install);
  return install;
}

/** Scope a seat table install to run(); dispose runs in finally. */
export async function withInstitutionalSeatTable<T>(
  seats: InstitutionalResolutionPage["seats"],
  run: () => Promise<T>,
): Promise<T> {
  const install = installInstitutionalSeatTable(seats);
  try {
    return await run();
  } finally {
    const index = activeInstalls.indexOf(install);
    if (index !== -1) activeInstalls.splice(index, 1);
    install.dispose();
  }
}

/**
 * Config-derived institutional page — the single config-adaptive seat fixture.
 * Reads the persistent public-cli seat config at `home` and resolves each
 * seat's effective selection; only this config read is the "adaptation" over
 * the otherwise plain seat table.
 */
export function configDerivedSeatPage(
  home: string,
  parentModel: ParentModel,
): InstitutionalResolutionPage {
  const parentSelection = normalizeParentSelection(parentModel);
  const configPath = publicCliConfigPath(home);
  let seats: PublicCliConfig["seats"];
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { seats?: PublicCliConfig["seats"] };
    seats = parsed?.seats ?? {};
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
    ) {
      seats = {};
    } else {
      throw error;
    }
  }
  return resolveInstitutionalSeatSelections({ seats } as PublicCliConfig, parentSelection);
}

/** Scope a config-derived seat table install to run(); dispose runs in finally. */
export async function withConfigDerivedSeatTable<T>(
  home: string,
  parentModel: ParentModel,
  run: () => Promise<T>,
): Promise<T> {
  return withInstitutionalSeatTable(configDerivedSeatPage(home, parentModel).seats, run);
}
