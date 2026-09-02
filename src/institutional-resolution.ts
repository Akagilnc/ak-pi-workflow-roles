import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoleTurnModelConfig } from "./host-contracts.ts";
import {
  resolveConfiguredProvinceOfficerModel,
  seatModelOnly,
  type PublicCliConfig,
} from "./public-cli/config.ts";

export const INSTITUTIONAL_RESOLUTION_FILE = "institutional-resolution.json" as const;

/** Non-secret per-seat model selection — alias of the single host-neutral RoleTurnModelConfig. */
export type InstitutionalSeatSelection = RoleTurnModelConfig;

export type InstitutionalResolutionPage = {
  readonly version: 1;
  readonly seats: {
    readonly gatekeeper?: InstitutionalSeatSelection;
    readonly inspector?: InstitutionalSeatSelection;
    readonly notary?: InstitutionalSeatSelection;
    readonly auditor?: InstitutionalSeatSelection;
    readonly evidenceChild?: InstitutionalSeatSelection;
    readonly [seat: string]: InstitutionalSeatSelection | undefined;
  };
};

/** Why institutional seat read failed — structured, not free-text. */
export type InstitutionalResolutionFailureReason =
  | "missing-page"
  | "missing-seat"
  | "corrupted"
  | "invalid-format";

export class InstitutionalResolutionError extends Error {
  readonly reason: InstitutionalResolutionFailureReason;
  constructor(
    message: string,
    reason: InstitutionalResolutionFailureReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InstitutionalResolutionError";
    this.reason = reason;
  }
}

function cleanSelection(model?: { provider?: string; model?: string; thinking?: string }): InstitutionalSeatSelection | undefined {
  if (model === undefined) return undefined;
  if (typeof model.provider !== "string" || typeof model.model !== "string") return undefined;
  return {
    provider: model.provider,
    model: model.model,
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
  };
}

/**
 * Resolve effective per-seat institutional selections (#518 §2 Hop 1; #620):
 * - gatekeeper / inspector / notary: resolveConfiguredProvinceOfficerModel (sole
 *   configured rule) then parent effective on the province path only
 * - auditor / evidenceChild: parent effective
 * - navigator: explicit config seat only. Navigator model authority stays
 *   `navigator-model.json`; the page never carries a parent-inherited navigator
 *   seat, so host-neutral transport cannot shadow that setting (#590 Out of Scope:
 *   席位表／模型路由变更归 owner 域).
 */
export function resolveInstitutionalSeatSelections(
  config: PublicCliConfig,
  parentEffectiveModel?: { provider: string; model: string; thinking?: string },
): InstitutionalResolutionPage {
  const parentSelection = cleanSelection(parentEffectiveModel);

  const gatekeeper =
    resolveConfiguredProvinceOfficerModel(config, "gatekeeper") ?? parentSelection;
  const inspector =
    resolveConfiguredProvinceOfficerModel(config, "inspector") ?? parentSelection;
  const notary =
    resolveConfiguredProvinceOfficerModel(config, "notary") ?? parentSelection;
  const auditor = parentSelection;
  const evidenceChild = parentSelection;
  const navigator = cleanSelection(seatModelOnly(config.seats?.navigator));

  return {
    version: 1,
    seats: {
      ...(gatekeeper === undefined ? {} : { gatekeeper }),
      ...(inspector === undefined ? {} : { inspector }),
      ...(notary === undefined ? {} : { notary }),
      ...(auditor === undefined ? {} : { auditor }),
      ...(evidenceChild === undefined ? {} : { evidenceChild }),
      ...(navigator === undefined ? {} : { navigator }),
    },
  };
}

/**
 * Persist institutional resolution page to run directory (#518 §2 Hop 2).
 * Rewritten on each dispatch and resume. Zero secrets inside page.
 */
export async function writeInstitutionalResolutionPage(
  runDirectory: string,
  page: InstitutionalResolutionPage,
): Promise<void> {
  const filePath = join(runDirectory, INSTITUTIONAL_RESOLUTION_FILE);
  await writeFile(filePath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
}

/**
 * Read institutional seat selection from run directory (#518 §2 Hop 3).
 * Fails loud if page is missing, corrupted, or does not contain a resolution for the seat.
 */
export async function readInstitutionalSeatSelection(
  runDirectory: string,
  seat: string,
): Promise<InstitutionalSeatSelection> {
  const filePath = join(runDirectory, INSTITUTIONAL_RESOLUTION_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new InstitutionalResolutionError(
      `institutional resolution page is missing at ${filePath}`,
      "missing-page",
      { cause: error },
    );
  }

  let page: unknown;
  try {
    page = JSON.parse(raw);
  } catch (error) {
    throw new InstitutionalResolutionError(
      `institutional resolution page is corrupted at ${filePath}`,
      "corrupted",
      { cause: error },
    );
  }

  if (typeof page !== "object" || page === null || (page as { version?: unknown }).version !== 1) {
    throw new InstitutionalResolutionError(
      `institutional resolution page format is invalid at ${filePath}`,
      "invalid-format",
    );
  }

  const seats = (page as { seats?: Record<string, unknown> }).seats;
  if (typeof seats !== "object" || seats === null) {
    throw new InstitutionalResolutionError(
      `institutional resolution page missing seats object at ${filePath}`,
      "invalid-format",
    );
  }

  const selection = cleanSelection(seats[seat] as InstitutionalSeatSelection | undefined);
  if (selection === undefined) {
    throw new InstitutionalResolutionError(
      `institutional resolution page has no resolution for seat "${seat}" at ${filePath}`,
      "missing-seat",
    );
  }

  return selection;
}
