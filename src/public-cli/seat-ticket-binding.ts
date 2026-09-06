/**
 * Shared ticket identity seam for public court seats (#635 / #637 / #709).
 * One path: unbound summons → the working 起居郎 round reads the caller's
 * instruction and hands back a typed ticketNumber → bindAdmittedTicketNumber.
 * ADR 0081 `initial-court-ticket-supplied` / `reuse-case-ticket-without-extra-llm`:
 * identity rides the round already doing the case work — no second ticket-number
 * source of truth, no extra recognizer call, and no seat-side scan of instruction
 * prose (锚定宪法: machines consume typed keys, never free text).
 * A round that names no ticket leaves the run lawfully unbound — never a fake one.
 * No CLI --ticket and no attachment frontmatter binding.
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import { runDiarist, type DiaristIssueFace } from "../diarist.ts";
import {
  bindAdmittedTicketNumber,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  findLatestRunIdForSeatTicket,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

export type SeatTicketBindingEnv = {
  readonly home: string;
  readonly cwd: string;
  readonly packageRoot: string;
};

/**
 * Ticket identity for this summons, from the 起居郎 round that collects the case
 * material. The round mints the ticket's 起居录 volume when it names one, so a
 * first summons with neither a volume nor a retained run still bootstraps its own
 * identity and dossier. Undefined means this summons named no ticket the round
 * could establish; the seat proceeds unbound, which is lawful.
 */
export async function resolveSummonsTicketIdentity(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly env: SeatTicketBindingEnv;
  /** Countersign court round loads the issue face in this same invocation. */
  readonly loadIssueFace?: (
    ticketNumber: number,
  ) => Promise<DiaristIssueFace>;
}): Promise<number | undefined> {
  const result = await runDiarist({
    instruction: input.instruction,
    cwd: input.projectRoot,
    home: input.env.home,
    sessionCwds: [input.projectRoot, input.env.cwd],
    packageRoot: input.env.packageRoot,
    ...(input.loadIssueFace === undefined
      ? {}
      : { loadIssueFace: input.loadIssueFace }),
  });
  return result.ticketNumber;
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
  const ticketNumber = await resolveSummonsTicketIdentity({
    instruction: admitted.instruction,
    projectRoot: admitted.projectRoot,
    env,
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
