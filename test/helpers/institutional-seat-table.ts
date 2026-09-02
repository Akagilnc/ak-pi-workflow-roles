import { join } from "node:path";
import { writeFileSync } from "node:fs";

import {
  INSTITUTIONAL_RESOLUTION_FILE,
  type InstitutionalResolutionPage,
} from "../../src/institutional-resolution.ts";

/**
 * Shared seat table for institutional consumer tests (#518 S3).
 * One page writer: writes an institutional-resolution.json page into a run
 * directory so real evidence-child / auditor / gatekeeper consumers can read
 * their seat via readInstitutionalSeatSelection. Tests that drive these
 * consumers install the page before the consumer runs (the page is the
 * explicit-selection contract that replaced ambient parent Provider /
 * context.model inheritance). Run directories and teardown are owned by each
 * test (pass runDirectory explicitly; clean up in a finally) — no global
 * install registry, no ambient AK_ROLE_RUN_DIR mutation here.
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
 * gate behavior: gate/officer/auditor/evidenceChild inherit the parent model).
 * Navigator is omitted: its model authority stays `navigator-model.json`
 * (#590 — institutional transport must not shadow that setting).
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
