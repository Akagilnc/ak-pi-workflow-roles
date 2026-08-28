import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import {
  INSTITUTIONAL_RESOLUTION_FILE,
  type InstitutionalResolutionPage,
} from "../../src/institutional-resolution.ts";

/**
 * Shared seat table for institutional consumer tests (#518 S3).
 * Writes an institutional-resolution.json page into a run directory so real
 * evidence-child / auditor / gatekeeper consumers can read their seat via
 * readInstitutionalSeatSelection. Tests that drive these consumers must call
 * this before the consumer runs; the page is the explicit-selection contract
 * that replaced ambient parent Provider/context.model inheritance.
 */
export async function writeInstitutionalSeatTable(
  runDirectory: string,
  seats: InstitutionalResolutionPage["seats"],
): Promise<void> {
  await writeFile(
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
