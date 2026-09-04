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
  type AdmittedRoleInvocation,
} from "./invocation.ts";

export type SeatTicketBindingEnv = {
  readonly packageRoot?: string;
};

/**
 * Bind ticketNumber onto an unbound admitted seat via LLM instruction recognition.
 * Already-bound admissions are left untouched (no re-resolution).
 * true-unbound leaves the run unbound; failed verification throws.
 */
export async function resolveSeatTicketBinding(
  admitted: AdmittedRoleInvocation,
  env: SeatTicketBindingEnv = {},
): Promise<DiaristTicketResolution | undefined> {
  if (admitted.ticketNumber !== undefined) return undefined;

  const resolver = createHermesDiaristTicketResolver({
    ...(env.packageRoot === undefined ? {} : { packageRoot: env.packageRoot }),
    cwd: admitted.projectRoot,
  });
  const checkExistence = createGhTicketExistenceChecker();
  const origin = resolveDiaristGithubOrigin(admitted.projectRoot);
  const resolution = await resolveDiaristTicketFromInstruction({
    instruction: admitted.instruction,
    origin,
    resolver,
    checkExistence,
  });
  if (resolution.kind === "ticket") {
    await bindAdmittedTicketNumber(admitted, resolution.ticketNumber);
  }
  return resolution;
}
