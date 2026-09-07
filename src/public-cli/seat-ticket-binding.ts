/**
 * Shared ticket identity seam for public court seats (#635 / #637 / #709 / #747 / #771).
 * Court target = first `#N` in the summons instruction. Other seats reuse that
 * number only when this book already records it (retained run pages + 起居录
 * volumes); 起居郎 takes it as the caller-supplied identity on a first summons
 * (ADR 0081 `initial-court-ticket-supplied`). No seat-side model call, no second
 * ticket-number source of truth, no minting from human titles. No `#N` leaves
 * the run unbound (真无票), which is lawful. No CLI --ticket and no attachment
 * frontmatter binding. #747: officer same-parent resume also lives here.
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
 * Hash-marked ticket references in an instruction, in order of first appearance.
 * `#582` is one token; a leading-zero run is not a ticket literal; bare digit
 * runs (`r1`, `D2`, sha islands, counts) are not ticket references. Callers name
 * the court target as the first `#N` (ADR 0081 `initial-court-ticket-supplied`).
 */
export function instructionTicketTokens(
  instruction: string,
): readonly number[] {
  const tokens: number[] = [];
  const seen = new Set<number>();
  for (const match of instruction.matchAll(/#([1-9]\d*)/g)) {
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed)) continue;
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    tokens.push(parsed);
  }
  return tokens;
}

/**
 * Ticket identity this summons reuses, or undefined when the court target is not
 * already on this book. The first `#N` is the court target; later `#N` are
 * neighbors/PRs and never steal the bind. Known identities come only from
 * records this book already holds: 起居录 volume partitions and ticket numbers
 * on retained run pages. Nothing matched leaves the run unbound — never guess.
 */
export async function resolveKnownTicketNumber(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly bookKey?: string;
}): Promise<number | undefined> {
  const tokens = instructionTicketTokens(input.instruction);
  if (tokens.length === 0) return undefined;
  const target = tokens[0]!;
  const volume = resolveTicketProvenanceVolume(
    target,
    input.projectRoot,
    input.home,
  );
  if (existsSync(volume.volumeDir)) return target;
  const runTickets = await readBookRunTickets(input);
  return runTickets.has(target) ? target : undefined;
}

/**
 * Diarist summons identity (ADR 0081 `initial-court-ticket-supplied`).
 * The first `#N` in the caller's dispatch is the supplied court target — the
 * working 起居郎 round establishes the volume on a first summons; later `#N`
 * (neighbors, PR numbers) do not unbind it. No `#N` stays unbound (真无票).
 * Not a second ticket-number source of truth and not an extra recognizer call.
 */
export async function resolveDiaristSummonsTicketNumber(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly bookKey?: string;
}): Promise<number | undefined> {
  const tokens = instructionTicketTokens(input.instruction);
  return tokens[0];
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
