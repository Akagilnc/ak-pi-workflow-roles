/**
 * Shared LLM ticket binding for public court seats (#635).
 * One path: unbound admission → diarist instruction assertion → bindAdmittedTicketNumber.
 * No CLI --ticket and no attachment frontmatter binding.
 * #637: same-ticket prior-run lookup → resume decision also lives here (shared seam).
 */
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  createGhTicketExistenceChecker,
  createHermesDiaristTicketResolver,
  DiaristTicketResolutionError,
  resolveDiaristTicketFromInstruction,
  type DiaristTicketResolution,
} from "../diarist-ticket-resolution.ts";
import { resolveDiaristGithubOrigin } from "../diarist.ts";
import {
  bindAdmittedTicketNumber,
  recordTrueUnboundTicketResolution,
  type AdmittedRoleInvocation,
} from "./invocation.ts";
import {
  findLatestRunIdForSeatTicket,
  type RoleRunRecord,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";

export type SeatTicketBindingEnv = {
  readonly packageRoot?: string;
};

/**
 * Pre-admit instruction ticket probe (#635 / #637).
 * Success carries the resolution for same-ticket resume + post-admit bind.
 * DiaristTicketResolutionError is captured (not thrown) so the seat can still
 * admit and settle the failure inside the post-admission controlled path —
 * bare throw before admit would skip terminal settlement (失败诚实, no wash).
 */
export type InstructionTicketProbe =
  | { readonly kind: "resolved"; readonly resolution: DiaristTicketResolution }
  | { readonly kind: "failed"; readonly error: DiaristTicketResolutionError };

/**
 * Instruction → ticket resolution without admission (#635 / #637).
 * Used to locate a prior same-ticket run before minting a new one.
 * Throws on resolution failure — prefer probeInstructionTicket at seat entry.
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
 * Pre-admit probe: resolution success or captured DiaristTicketResolutionError.
 * Other errors still propagate (launch/infrastructure outside this class).
 */
export async function probeInstructionTicket(
  instruction: string,
  projectRoot: string,
  env: SeatTicketBindingEnv = {},
): Promise<InstructionTicketProbe> {
  try {
    const resolution = await resolveInstructionTicket(
      instruction,
      projectRoot,
      env,
    );
    return { kind: "resolved", resolution };
  } catch (error) {
    if (error instanceof DiaristTicketResolutionError) {
      return { kind: "failed", error };
    }
    throw error;
  }
}

/** Ticket number from a successful ticket probe; undefined for unbound/failed. */
export function ticketNumberFromProbe(
  probe: InstructionTicketProbe,
): number | undefined {
  if (probe.kind !== "resolved") return undefined;
  if (probe.resolution.kind !== "ticket") return undefined;
  return probe.resolution.ticketNumber;
}

/**
 * Sole disposition of a resolved ticket onto an unbound admission (#635 / #637).
 * Countersign / inspector / resolveSeatTicketBinding share this — no parallel branches.
 */
export async function applyTicketResolution(
  admitted: AdmittedRoleInvocation,
  resolution: DiaristTicketResolution,
): Promise<void> {
  if (resolution.kind === "ticket") {
    await bindAdmittedTicketNumber(admitted, resolution.ticketNumber);
  } else {
    await recordTrueUnboundTicketResolution(admitted);
  }
}

/**
 * Apply a pre-admit probe onto an unbound admission.
 * Failed probes rethrow — caller must be inside the controlled-failure boundary
 * (post-admission beforeDispatch), never before admit/markRunning.
 */
export async function applyInstructionTicketProbe(
  admitted: AdmittedRoleInvocation,
  probe: InstructionTicketProbe,
): Promise<void> {
  if (probe.kind === "failed") throw probe.error;
  await applyTicketResolution(admitted, probe.resolution);
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
  await applyTicketResolution(admitted, resolution);
  return resolution;
}

/**
 * Shared same-ticket → resume decision (#637).
 * Looks up the latest retained run for seat+ticket; when found, runs resume with
 * this summons' materials. Lookup/resume failures propagate (失败诚实) — never
 * wash into a fresh mint. Returns undefined only when no prior run exists.
 */
export async function tryResumeSameTicketSeatRun<T>(input: {
  readonly home: string;
  readonly projectRoot: string;
  readonly role: RoleRunRecord["role"];
  readonly ticketNumber: number;
  readonly summons?: SameTicketSummonsMaterials;
  readonly resume: (
    runId: string,
    summons: SameTicketSummonsMaterials | undefined,
  ) => Promise<T>;
}): Promise<T | undefined> {
  const previousRunId = await findLatestRunIdForSeatTicket({
    home: input.home,
    bookKey: resolveBookKeyFromGit(input.projectRoot),
    role: input.role,
    ticketNumber: input.ticketNumber,
  });
  if (previousRunId === undefined) return undefined;
  return await input.resume(previousRunId, input.summons);
}
