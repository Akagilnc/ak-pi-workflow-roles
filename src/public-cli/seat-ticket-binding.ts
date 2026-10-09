/**
 * Shared same-parent resume seam for gate / officer seats (#635 / #637 / #747 / #987).
 *
 * Lookup uses the parent run path; a typed ticket narrows same-ticket gate
 * re-summons, never creates an issue identity. Callers can also use explicit
 * `ak-role resume <runId>`. Lookup/resume failures propagate (失败诚实) — never wash into
 * a fresh mint. Returns undefined when the caller declared an explicit fresh
 * summons (`ak-role new`) or when no prior run exists; both mint new.
 * freshSummons is required so no seat can drift back into its own skip branch.
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  findLatestRunForSeatTicket,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

/**
 * Sole same-seat → resume decision by parent run path (#637 / #724 / #747 / #987).
 * A supplied typed ticket only narrows the prior-run search. When a prior run is
 * found, resume carries this summons' materials and the located runDirectory so
 * load does not re-walk every book for the bare runId (#1195). Lookup/resume
 * failures propagate (失败诚实) — never wash into a fresh mint. Returns undefined
 * when the caller declared an explicit fresh summons (`ak-role new`), the parent
 * path is blank, or no prior run exists; those mint new. freshSummons is
 * required so no seat can drift back into its own skip branch.
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
  const previous = await findLatestRunForSeatTicket({
    home: input.home,
    bookKey: resolveBookKeyFromGit(input.projectRoot),
    role: input.role,
    parentRunPath: input.parentRunPath,
    ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
  });
  if (previous === undefined) return undefined;
  return await input.resume(previous.runId, input.summons, previous.runDirectory);
}
