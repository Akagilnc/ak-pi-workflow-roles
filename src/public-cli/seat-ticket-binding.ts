/**
 * Shared same-parent resume seam for gate / officer seats (#635 / #637 / #747 / #987 / #1253).
 * Contract is on tryResumeSameTicketSeatRun.
 */
import { join } from "node:path";

import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import type { PublicSummonResult } from "../public-role-summons.ts";
import { presentSeatVolume } from "./auto-resume.ts";
import { besideConclusion, retainPackageFault } from "./settlement.ts";
import { discardStdout, type CliIo } from "./cli-io.ts";
import {
  autopsyWriterLock,
  findLatestRunForSeatTicket,
  resolveLiveRunDirectoryPath,
  WRITER_LOCK_FILE,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

const SESSION_ID_MISSING = "session-id-missing";

/** Live or unverifiable holder: same fail-closed verdict as lease acquire. */
async function writerLockBlocksFreshSummons(runDirectory: string): Promise<boolean> {
  const autopsy = await autopsyWriterLock(join(runDirectory, WRITER_LOCK_FILE));
  return autopsy.verdict === "alive" || autopsy.verdict === "unknown";
}

/**
 * Sole same-seat → resume decision by parent run path (#637 / #724 / #747 / #987 / #1253).
 * A supplied typed ticket only narrows the prior-run search. When a prior run is
 * found, resume carries this summons' materials and the located runDirectory so
 * load does not re-walk every book for the bare runId (#1195). Typed
 * session-id-missing is already recorded on that run (失败照记，记完再起新);
 * return undefined so the caller mints once. Resume runs first; this seam does
 * not look up a session id. A held or unverifiable writer lock, and every other
 * result, returns as-is. Also returns undefined for explicit `ak-role new`, a
 * blank parent path, or no prior run. freshSummons is required so no seat can
 * drift back into its own skip branch.
 */
export async function tryResumeSameTicketSeatRun(input: {
  readonly home: string;
  readonly io: CliIo;
  readonly projectRoot: string;
  readonly role: RoleRunRecord["role"];
  readonly parentRunPath: string;
  readonly ticketNumber?: number;
  readonly freshSummons: true | undefined;
  readonly summons?: SameTicketSummonsMaterials;
  readonly resume: (
    runId: string,
    summons: SameTicketSummonsMaterials | undefined,
    runDirectory: string,
  ) => Promise<PublicSummonResult>;
}): Promise<PublicSummonResult | undefined> {
  if (input.freshSummons === true) return undefined;
  if (input.parentRunPath.trim() === "") return undefined;
  const bookKey = resolveBookKeyFromGit(input.projectRoot);
  const previous = await findLatestRunForSeatTicket({
    home: input.home,
    bookKey,
    role: input.role,
    parentRunPath: input.parentRunPath,
    ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
  });
  if (previous === undefined) return undefined;
  const resumed = await input.resume(previous.runId, input.summons, previous.runDirectory);
  const outcome = resumed.terminal?.roleOutcome;
  if (resumed.admitted?.runId !== previous.runId || outcome?.kind !== "failure"
    || outcome.decisiveFacts.errorCode !== SESSION_ID_MISSING) return resumed;
  // The resumed volume is in hand: a failed lock check keeps it (ADR 0080).
  const note = (diagnostic: string) => retainPackageFault({ runDirectory: resumed.admitted!.runDirectory, diagnostic, stderr: (text) => input.io.stderr(text) });
  const blocked = await besideConclusion(note, "fresh-summons lock check", async () => {
    const live = await resolveLiveRunDirectoryPath(previous.runDirectory, input.home, bookKey);
    return live !== undefined && await writerLockBlocksFreshSummons(live);
  });
  if (blocked !== false) return resumed;
  // Direct resume already presented this volume; a quiet summon never will.
  if (input.io.stdout === discardStdout) await presentSeatVolume(resumed, input.io, "discarded");
  return undefined;
}
