/**
 * Shared LLM ticket binding for public court seats (#635).
 * One path: unbound admission → diarist instruction assertion → bindAdmittedTicketNumber.
 * No CLI --ticket and no attachment frontmatter binding.
 */
import {
  createGhTicketExistenceChecker,
  createHermesDiaristTicketResolver,
  resolveDiaristTicketFromInstruction,
  type DiaristTicketResolution,
} from "../diarist-ticket-resolution.ts";
import { resolveDiaristGithubOrigin } from "../diarist.ts";
import {
  bindAdmittedTicketNumber,
  recordTrueUnboundTicketResolution,
  type AdmittedRoleInvocation,
} from "./invocation.ts";

export type SeatTicketBindingEnv = {
  readonly packageRoot?: string;
};

/**
 * Instruction → ticket resolution without admission (#635 / #637).
 * Used to locate a prior same-ticket run before minting a new one.
 */
export async function resolveInstructionTicket(
  instruction: string,
  projectRoot: string,
  env: SeatTicketBindingEnv = {},
): Promise<DiaristTicketResolution> {
  const resolver = createHermesDiaristTicketResolver({
    ...(env.packageRoot === undefined ? {} : { packageRoot: env.packageRoot }),
    cwd: projectRoot,
  });
  const checkExistence = createGhTicketExistenceChecker();
  const origin = resolveDiaristGithubOrigin(projectRoot);
  return resolveDiaristTicketFromInstruction({
    instruction,
    origin,
    resolver,
    checkExistence,
  });
}

/**
 * Bind ticketNumber onto an unbound admitted seat via LLM instruction recognition.
 * Already-settled admissions (ticketNumber or durable true-unbound) short-circuit —
 * no re-entry into hermes on auto-resume attempts or manual resume (#635).
 * true-unbound is persisted once; failed verification throws.
 */
export async function resolveSeatTicketBinding(
  admitted: AdmittedRoleInvocation,
  env: SeatTicketBindingEnv = {},
): Promise<DiaristTicketResolution | undefined> {
  if (admitted.ticketNumber !== undefined) return undefined;
  if (admitted.ticketResolution === "true-unbound") {
    return { kind: "true-unbound" };
  }

  const resolution = await resolveInstructionTicket(
    admitted.instruction,
    admitted.projectRoot,
    env,
  );
  if (resolution.kind === "ticket") {
    await bindAdmittedTicketNumber(admitted, resolution.ticketNumber);
  } else {
    await recordTrueUnboundTicketResolution(admitted);
  }
  return resolution;
}
