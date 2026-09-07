/**
 * Shared ticket identity seam for public court seats (#635 / #637 / #709 / #747 / #771).
 *
 * ADR 0075 `diarist-resolves-ticket-llm-layer`: the seat's LLM names the court
 * target as a typed assertion; the mechanical layer only verifies that assertion
 * (complete decimal of N appears in the summons; ticket exists). Code never
 * judges which ticket the summons is about — no prose harvest, no first-#N
 * position pick, no matching book-known numbers against instruction text
 * (锚定宪法; owner 2026-09-08: 代码不准做判断). Other seats reuse a typed
 * identity already handed over (起居郎 assertion / source-run / already-bound
 * resume) — they do not re-recognize from instruction. No CLI --ticket, no
 * attachment frontmatter. #747: officer same-parent resume also lives here.
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  instructionContainsTicketNumber,
  verifyAssertedTicketNumber,
  DiaristTicketVerificationError,
  createGhTicketExistenceChecker,
  type TicketExistenceChecker,
} from "../diarist.ts";
import {
  bindAdmittedTicketNumber,
  bindTicketNumberOnRunDirectory,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  findLatestRunIdForSeatTicket,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

export type SeatTicketBindingEnv = {
  readonly home: string;
};

export {
  instructionContainsTicketNumber,
  verifyAssertedTicketNumber,
  DiaristTicketVerificationError,
  createGhTicketExistenceChecker,
  bindTicketNumberOnRunDirectory,
  type TicketExistenceChecker,
};

/** Bind a typed ticket number onto an admission that is still unbound. */
export async function bindReusedTicketNumber(
  admitted: AdmittedRoleInvocation,
  ticketNumber: number | undefined,
): Promise<void> {
  if (ticketNumber === undefined) return;
  if (admitted.ticketNumber !== undefined) return;
  await bindAdmittedTicketNumber(admitted, ticketNumber);
}

/**
 * Already-bound admissions keep their identity; unbound admissions stay unbound.
 * Ticket recognition is the seat LLM's job (assert on output / 起居郎 handoff) —
 * this seam never matches instruction text against book records.
 */
export async function resolveSeatTicketBinding(
  admitted: AdmittedRoleInvocation,
  _env: SeatTicketBindingEnv,
): Promise<number | undefined> {
  return admitted.ticketNumber;
}

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
