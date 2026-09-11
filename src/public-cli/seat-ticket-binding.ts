/**
 * Shared ticket identity seam for public court seats (#635 / #637 / #709 / #747 / #771).
 *
 * ADR 0075 `diarist-resolves-ticket-llm-layer`: the diarist LLM recognizes the
 * court target; recognized ticket → provenance, truly unbound → no provenance,
 * or escalate when it cannot recognize one. Code does not re-judge the ticket
 * (锚定宪法; owner 2026-09-08: 代码不准做判断). Other seats reuse a typed
 * identity already handed over (起居郎 assertion / source-run / already-bound
 * resume) — they do not re-recognize from instruction. No CLI --ticket, no
 * attachment frontmatter. #747: officer same-parent resume also lives here.
 *
 * This module owns same-ticket / same-parent resume only.
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  findLatestRunIdForSeatTicket,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

/**
 * Sole same-seat → resume decision (#637 / #724 / #747).
 * Officer seats (notary/inspector/auditor) look up by parent run path; countersign
 * / diarist keep ticket-number principal. When found, runs resume with this
 * summons' materials. Lookup/resume failures propagate (失败诚实) — never wash
 * into a fresh mint. Returns undefined when the caller declared an explicit
 * fresh summons (`ak-role new`) or when no prior run exists; both mint new.
 * freshSummons is required so no seat can drift back into its own skip branch.
 */
export async function tryResumeSameTicketSeatRun<T>(input: {
  readonly home: string;
  readonly projectRoot: string;
  readonly role: RoleRunRecord["role"];
  readonly ticketNumber?: number;
  readonly parentRunPath?: string;
  readonly freshSummons: true | undefined;
  readonly summons?: SameTicketSummonsMaterials;
  readonly resume: (
    runId: string,
    summons: SameTicketSummonsMaterials | undefined,
  ) => Promise<T>;
}): Promise<T | undefined> {
  if (input.freshSummons === true) return undefined;
  if (input.parentRunPath === undefined && input.ticketNumber === undefined) {
    return undefined;
  }
  const previousRunId = await findLatestRunIdForSeatTicket({
    home: input.home,
    bookKey: resolveBookKeyFromGit(input.projectRoot),
    role: input.role,
    ...(input.parentRunPath === undefined
      ? {}
      : { parentRunPath: input.parentRunPath }),
    ...(input.ticketNumber === undefined
      ? {}
      : { ticketNumber: input.ticketNumber }),
  });
  if (previousRunId === undefined) return undefined;
  return await input.resume(previousRunId, input.summons);
}
