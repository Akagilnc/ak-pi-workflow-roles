/**
 * Shared ticket identity seam for public court seats (#635 / #637 / #709 / #747 / #771).
 *
 * ADR 0075 `diarist-resolves-ticket-llm-layer`: 起居郎 (LLM layer) names the court
 * target as a typed assertion; the mechanical layer only verifies that assertion
 * (complete decimal of N appears in the summons; ticket exists). Other seats
 * reuse a ticket this book already records whose complete decimal appears in the
 * summons — they never harvest ticket tokens from prose and never pick a
 * position-based "first #N" (锚定宪法). No CLI --ticket, no attachment frontmatter.
 * #747: officer same-parent resume also lives here.
 */
import {
  ActivationGitRepositoryRequiredError,
  resolveBookKeyFromGit,
} from "../activation-ledger-git.ts";
import {
  instructionContainsTicketNumber,
  verifyAssertedTicketNumber,
  DiaristTicketVerificationError,
  createGhTicketExistenceChecker,
  type TicketExistenceChecker,
} from "../diarist.ts";
import { listTicketProvenanceVolumeNumbers } from "../ticket-provenance.ts";
import {
  bindAdmittedTicketNumber,
  bindTicketNumberOnRunDirectory,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  collectBookRunTicketNumbers,
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

/**
 * Ticket identity this summons reuses, or undefined when none is unambiguous.
 * Only tickets this book already records (起居录 volume typed identity or retained
 * run page) are candidates; the summons must contain that ticket's complete
 * decimal (verification of a book-known claim — not prose harvest, not first #N).
 * Zero or several matches leave the run unbound — never guess. 真无票 stays lawful.
 */
export async function resolveKnownTicketNumber(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly bookKey?: string;
}): Promise<number | undefined> {
  const known = new Set<number>();
  for (const n of listTicketProvenanceVolumeNumbers(
    input.projectRoot,
    input.home,
  )) {
    known.add(n);
  }
  for (const n of await readBookRunTickets(input)) {
    known.add(n);
  }
  const matches: number[] = [];
  for (const n of known) {
    if (instructionContainsTicketNumber(input.instruction, n)) {
      matches.push(n);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Ticket numbers on this book's retained runs.
 * A directory with no book (not a git repository) simply holds no run history —
 * admission owns that rejection face, this lookup does not pre-empt it.
 */
async function readBookRunTickets(input: {
  readonly projectRoot: string;
  readonly home: string;
  readonly bookKey?: string;
}): Promise<ReadonlySet<number>> {
  let bookKey: string;
  try {
    bookKey = input.bookKey ?? resolveBookKeyFromGit(input.projectRoot);
  } catch (error) {
    if (error instanceof ActivationGitRepositoryRequiredError) return new Set();
    throw error;
  }
  return await collectBookRunTicketNumbers({ home: input.home, bookKey });
}

/** Bind a reused ticket number onto an admission that is still unbound. */
export async function bindReusedTicketNumber(
  admitted: AdmittedRoleInvocation,
  ticketNumber: number | undefined,
): Promise<void> {
  if (ticketNumber === undefined) return;
  if (admitted.ticketNumber !== undefined) return;
  await bindAdmittedTicketNumber(admitted, ticketNumber);
}

/**
 * Sole seat disposition for an unbound admission (#635 / #709).
 * Already-bound admissions short-circuit — resume keeps the identity it has.
 * Used by seats that do not pre-resolve for same-ticket resume; the seats that
 * do (countersign / inspector / diarist) reuse the number they already resolved.
 */
export async function resolveSeatTicketBinding(
  admitted: AdmittedRoleInvocation,
  env: SeatTicketBindingEnv,
): Promise<number | undefined> {
  if (admitted.ticketNumber !== undefined) return admitted.ticketNumber;
  const ticketNumber = await resolveKnownTicketNumber({
    instruction: admitted.instruction,
    projectRoot: admitted.projectRoot,
    home: env.home,
    bookKey: admitted.bookKey,
  });
  await bindReusedTicketNumber(admitted, ticketNumber);
  return ticketNumber;
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
