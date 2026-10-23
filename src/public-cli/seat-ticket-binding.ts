/**
 * Shared same-parent resume seam for gate / officer seats (#635 / #637 / #747 / #987 / #1253).
 * Contract is on tryResumeSameTicketSeatRun.
 */
import { join } from "node:path";

import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  autopsyWriterLock,
  findLatestRunForSeatTicket,
  findRunDirectoryById,
  resolveLiveRunDirectoryPath,
  WRITER_LOCK_FILE,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

const SESSION_ID_MISSING = "session-id-missing";

function resumedSessionIdMissing(result: unknown, runId: string): boolean {
  if (typeof result !== "object" || result === null) return false;
  const terminal = (result as { terminal?: unknown }).terminal;
  if (typeof terminal !== "object" || terminal === null) return false;
  if ((terminal as { runId?: unknown }).runId !== runId) return false;
  const outcome = (terminal as { roleOutcome?: unknown }).roleOutcome;
  if (typeof outcome !== "object" || outcome === null) return false;
  if ((outcome as { kind?: unknown }).kind !== "failure") return false;
  const facts = (outcome as { decisiveFacts?: unknown }).decisiveFacts;
  if (typeof facts !== "object" || facts === null) return false;
  return (facts as { errorCode?: unknown }).errorCode === SESSION_ID_MISSING;
}

/** Live or unverifiable holder: same fail-closed verdict as lease acquire. */
async function writerLockBlocksFreshSummons(runDirectory: string): Promise<boolean> {
  const autopsy = await autopsyWriterLock(join(runDirectory, WRITER_LOCK_FILE));
  return autopsy.verdict === "alive" || autopsy.verdict === "unknown";
}

/**
 * Directory the resume just settled. Load may have renamed the run; follow a
 * vanished recorded path with the existing runId locator. Never the pre-resume
 * snapshot.
 */
async function liveRunDirectoryAfterResume(
  result: unknown,
  home: string,
  runId: string,
  bookKey: string,
  role: RoleRunRecord["role"],
): Promise<string | undefined> {
  const admitted = typeof result === "object" && result !== null
    ? (result as { admitted?: unknown }).admitted
    : undefined;
  const recorded = typeof admitted === "object" && admitted !== null
    ? (admitted as { runDirectory?: unknown }).runDirectory
    : undefined;
  if (typeof recorded === "string" && recorded.trim() !== "") {
    return resolveLiveRunDirectoryPath(recorded, home, bookKey);
  }
  return findRunDirectoryById(home, runId, bookKey, role);
}

/**
 * Sole same-seat → resume decision by parent run path (#637 / #724 / #747 / #987 / #1253).
 * A supplied typed ticket only narrows the prior-run search. When a prior run is
 * found, resume carries this summons' materials and the located runDirectory so
 * load does not re-walk every book for the bare runId (#1195). Typed
 * session-id-missing is already recorded on that run (失败照记，记完再起新);
 * return undefined so the caller mints once. Resume runs first; this seam does
 * not look up a session id. A held or unverifiable writer lock on the
 * post-resume directory, and every other result, returns as-is. Load may have
 * relocated the run; the check reads that live directory, not the pre-resume
 * snapshot. Also returns undefined for explicit `ak-role new`, a blank parent
 * path, or no prior run. freshSummons is required so no seat can drift back
 * into its own skip branch.
 */
export async function tryResumeSameTicketSeatRun<T>(input: {
  readonly home: string;
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
  ) => Promise<T>;
}): Promise<T | undefined> {
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
  if (!resumedSessionIdMissing(resumed, previous.runId)) return resumed;
  const live = await liveRunDirectoryAfterResume(
    resumed,
    input.home,
    previous.runId,
    bookKey,
    input.role,
  );
  if (live !== undefined && await writerLockBlocksFreshSummons(live)) return resumed;
  return undefined;
}
