/**
 * Shared Notary test fixtures — a canonical retained source run under the
 * machine ledger book (authoritative locator path). One authority: notary
 * behavior tests and the #633 resume tracers both seed from here.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  issuePiDurablePrincipalCoordinates,
} from "../../src/pi/durable-principal.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";

export const CANONICAL_SOURCE_RUN_ID = "01a034f1-75bf-71a6-bcf5-d1299145b1a5";
export const CANONICAL_SOURCE_ROLE = "judge" as const;

/** Seed a retained source run under the machine ledger book (authoritative path). */
export async function seedCanonicalSourceRun(
  home: string,
  project: string,
): Promise<string> {
  const coords = issuePiDurablePrincipalCoordinates({
    cwd: project,
    runId: CANONICAL_SOURCE_RUN_ID,
    role: CANONICAL_SOURCE_ROLE,
    home,
  });
  await mkdir(coords.sessionDirectory, { recursive: true });
  const admittedRequestPath = join(coords.runDirectory, "admitted-request.json");
  await writeFile(
    coords.sessionFile,
    `${JSON.stringify({ type: "message", message: { role: "user", content: "draft" } })}\n`,
    "utf8",
  );
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify({ role: CANONICAL_SOURCE_ROLE, runId: CANONICAL_SOURCE_RUN_ID })}\n`,
    "utf8",
  );
  await writeRoleRunState(coords.runDirectory, {
    runId: CANONICAL_SOURCE_RUN_ID,
    role: CANONICAL_SOURCE_ROLE,
    state: "terminal",
    bookKey: coords.bookKey,
    projectRoot: project,
    sessionDirectory: coords.sessionDirectory,
    sessionFile: coords.sessionFile,
    admittedRequestPath,
  });
  return await realpath(coords.runDirectory);
}
