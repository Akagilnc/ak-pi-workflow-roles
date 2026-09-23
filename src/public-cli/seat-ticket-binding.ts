/**
 * Shared same-parent resume seam for gate / officer seats (#635 / #637 / #747 / #987).
 *
 * Lookup key is parent run path only (#747 / #987 Result 7). Public seats no
 * longer select a prior run by ticket number — callers use explicit
 * `ak-role resume <runId>`. Officer and gate countersign same-parent re-summons
 * keep this seam. Lookup/resume failures propagate (失败诚实) — never wash into
 * a fresh mint. Returns undefined when the caller declared an explicit fresh
 * summons (`ak-role new`) or when no prior run exists; both mint new.
 * freshSummons is required so no seat can drift back into its own skip branch.
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  findLatestRunIdForSeatTicket,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

/**
 * Sole same-seat → resume decision by parent run path (#637 / #724 / #747 / #987).
 * A typed ticket number is a bind key, not a resume key. When a prior run is
 * found, resume carries this summons' materials. Lookup/resume failures
 * propagate (失败诚实) — never wash into a fresh mint. Returns undefined when
 * the caller declared an explicit fresh summons (`ak-role new`), the parent
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
  ) => Promise<T>;
}): Promise<T | undefined> {
  if (input.freshSummons === true) return undefined;
  if (input.parentRunPath.trim() === "") return undefined;
  const previousRunId = await findLatestRunIdForSeatTicket({
    home: input.home,
    bookKey: resolveBookKeyFromGit(input.projectRoot),
    role: input.role,
    parentRunPath: input.parentRunPath,
    ...(input.ticketNumber === undefined
      ? {}
      : { ticketNumber: input.ticketNumber }),
  });
  if (previousRunId === undefined) return undefined;
  return await input.resume(previousRunId, input.summons);
}
