/**
 * Shared ticket identity seam for public court seats (#635 / #637 / #709).
 * One path: unbound admission → reuse a ticket number this book already records
 * (retained run pages + 起居录 volumes) → bindAdmittedTicketNumber.
 * ADR 0081 `reuse-case-ticket-without-extra-llm`: no seat-side model call, no
 * second ticket-number source of truth, no minting a number from human titles.
 * Nothing matched is not 真无票 — the run simply stays unbound, which is lawful.
 * No CLI --ticket and no attachment frontmatter binding.
 */
import { existsSync } from "node:fs";

import {
  ActivationGitRepositoryRequiredError,
  resolveBookKeyFromGit,
} from "../activation-ledger-git.ts";
import { resolveTicketProvenanceVolume } from "../ticket-provenance.ts";
import {
  bindAdmittedTicketNumber,
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

/**
 * Complete decimal ticket tokens in an instruction.
 * A digit run is one token: `82` inside `#582` is not 82, and a leading zero
 * makes the run a different literal than the ticket number it would parse to.
 */
export function instructionTicketTokens(
  instruction: string,
): readonly number[] {
  const tokens = new Set<number>();
  for (const run of instruction.match(/\d+/g) ?? []) {
    if (run.startsWith("0")) continue;
    const parsed = Number(run);
    if (!Number.isSafeInteger(parsed) || parsed < 1) continue;
    tokens.add(parsed);
  }
  return [...tokens];
}

/**
 * Ticket identity this summons reuses, or undefined when none is unambiguous.
 * Known identities come only from records this book already holds: 起居录 volume
 * partitions and ticket numbers on retained run pages. Zero or several known
 * tokens in the instruction leave the run unbound — never guess, never fail.
 */
export async function resolveKnownTicketNumber(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly bookKey?: string;
}): Promise<number | undefined> {
  const tokens = instructionTicketTokens(input.instruction);
  if (tokens.length === 0) return undefined;
  const known: number[] = [];
  let runTickets: ReadonlySet<number> | undefined;
  for (const token of tokens) {
    const volume = resolveTicketProvenanceVolume(
      token,
      input.projectRoot,
      input.home,
    );
    if (existsSync(volume.volumeDir)) {
      known.push(token);
      continue;
    }
    if (runTickets === undefined) {
      runTickets = await readBookRunTickets(input);
    }
    if (runTickets.has(token)) known.push(token);
  }
  return known.length === 1 ? known[0] : undefined;
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
 * do (countersign / inspector) reuse the number they already resolved.
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
 * Sole same-ticket → resume decision (#637 / #724).
 * Looks up the latest retained run for seat+ticket; when found, runs resume with
 * this summons' materials. Lookup/resume failures propagate (失败诚实) — never
 * wash into a fresh mint. Returns undefined when the caller declared an explicit
 * fresh summons (`ak-role new`) or when no prior run exists; both mint new.
 * freshSummons is required so no seat can drift back into its own skip branch.
 */
export async function tryResumeSameTicketSeatRun<T>(input: {
  readonly home: string;
  readonly projectRoot: string;
  readonly role: RoleRunRecord["role"];
  readonly ticketNumber: number;
  readonly freshSummons: true | undefined;
  readonly summons?: SameTicketSummonsMaterials;
  readonly resume: (
    runId: string,
    summons: SameTicketSummonsMaterials | undefined,
  ) => Promise<T>;
}): Promise<T | undefined> {
  if (input.freshSummons === true) return undefined;
  const previousRunId = await findLatestRunIdForSeatTicket({
    home: input.home,
    bookKey: resolveBookKeyFromGit(input.projectRoot),
    role: input.role,
    ticketNumber: input.ticketNumber,
  });
  if (previousRunId === undefined) return undefined;
  return await input.resume(previousRunId, input.summons);
}
