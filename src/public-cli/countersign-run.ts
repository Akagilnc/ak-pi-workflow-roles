/**
 * Public Countersign Role run: admit ticket materials → court-pipeline prior
 * station (起居郎) → shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075 / #742 / #771). #599: manual resume continues the
 * exact session. ADR 0079: same-ticket re-summons resume the seat's previous run
 * (`ticket-seat-memory-countersign-principal`); explicit `ak-role new` mints fresh
 * (`explicit-fresh-summons`).
 *
 * Court admission auto-runs 起居郎 so the 起居郎 LLM asserts the court target;
 * mechanical layer only verifies; countersign reuses that typed identity for bind
 * and same-ticket resume lookup (ADR 0075 / 0081 / 0079). Code never matches
 * instruction text against book-known numbers. Who may call 起居郎 and in what
 * order is not written into law (ADR 0075 `no-call-rule`); the present admission
 * effect is what this seat currently does. 起居录 path delivery is owned once by
 * post-admission (#709 / ADR 0081).
 *
 * Wiring (#771): admit first so the countersign run exists; resolve typed identity
 * from 起居郎 after admit; same-ticket resume uses that typed key (abandon the
 * unused mint when resuming). 起居郎 escalate (认不出) and typed failure terminals
 * (incl. verification failure) settle as countersign controlled failure — never
 * wash into 真无票. Only a true missing lawful typed terminal stays unbound and
 * continues the body (r5 unbound-continue). Bound refresh hands the typed key to
 * 起居郎 so freeze loads issue face (`refresh-every-court` / typed handoff).
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../host-contracts.ts";
import { engineSessionMaterialFromOptions, pickEngineAxis } from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  projectCourtTicketNumbers,
} from "../diarist-contracts.ts";
import {
  admitCountersignInvocation,
  bindAdmittedTicketNumber,
  bindCourtTicketNumbersOnAdmitted,
  buildCountersignTransportPrompt,
  relocateAdmittedRunToTicket,
  type AdmittedCountersignInvocation,
  type ParseCountersignArgvResult,
} from "./invocation.ts";
import {
  prepareSummonsResumeMaterials,
  presentControlledFailure,
  runPostAdmissionOneShot,
  type PostAdmissionEnv,
  runPostAdmissionSeatResume,
  resumeTurnRequestProjectionOptions,
  StationChildExhaustedError,
} from "./post-admission.ts";
import {
  loadResumableCountersignRun,
  markRunAdmitted,
  markRunTerminal,
  type PublicResumeRequest,
  type RunWriterLease,
  type SameTicketSummonsMaterials,
} from "./run-lifecycle.ts";
import { tryResumeSameTicketSeatRun } from "./seat-ticket-binding.ts";
import {
  presentStructuralRejection,
  trySettleCountersignTerminalResult,
} from "./settlement.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalResult, TerminalRoleOutcome } from "./terminal.ts";
import {
  projectRoleTurnRequest,
  type RoleTurnRequestProjectionOptions,
} from "./turn-request.ts";

export type CountersignRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
  /**
   * Test seam: replace the court-pipeline 起居郎 station.
   * Production leaves this unset and runs the public diarist seat.
   */
  runCourtDiaristStation?: (
    admitted: AdmittedCountersignInvocation,
  ) => Promise<void>;
  /**
   * #871: typed co-review set from the identity 起居郎 turn, applied onto the
   * resumed run before bound refresh (same-ticket re-summons path). Whole-set
   * replace — never union. Production leaves unset outside that handoff.
   */
  pendingCourtTicketNumbers?: readonly number[];
};

/** Project admitted invocation onto the host-neutral turn request. */
export function buildCountersignTurnRequest(
  admitted: AdmittedCountersignInvocation,
  options: RoleTurnRequestProjectionOptions,
): RoleTurnRequest {
  return projectRoleTurnRequest(
    admitted,
    {
      activation: {
        role: "countersign" as const,
        // Admitted typed binding rides the turn activation seam to the Notary gate.
        ...(admitted.ticketNumber === undefined
          ? {}
          : { ticketNumber: admitted.ticketNumber }),
      },
    },
    options,
  );
}

/** 起居郎 identity outcome — escalate stays distinct from missing terminal. */
type CourtDiaristIdentity =
  | {
      readonly kind: "ticket";
      readonly ticketNumber: number;
      /**
       * #871 typed co-review set when the LLM explicitly submitted one.
       * Absent means "no new set this turn" — resume must keep the stored run fact
       * (never silently degrade a multi-ticket set to [main]).
       */
      readonly courtTicketNumbers?: readonly number[];
    }
  | { readonly kind: "unbound" }
  | { readonly kind: "escalate" };

type CourtDiaristInvocationResult = {
  readonly identity: CourtDiaristIdentity;
  readonly failedWithoutEscalate?: { readonly diagnostic: string };
};

/** Read #871 set from preserved diarist payloads; undefined when the field was not submitted. */
function courtTicketNumbersFromOutcome(
  roleOutcome: TerminalRoleOutcome | undefined,
): readonly number[] | undefined {
  if (roleOutcome === undefined) return undefined;
  const payloads =
    roleOutcome.kind === "accepted" ||
    roleOutcome.kind === "audit_escalation" ||
    roleOutcome.kind === "failure"
      ? roleOutcome.payloads ?? []
      : [];
  for (const payload of payloads) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      continue;
    }
    const projected = projectCourtTicketNumbers(
      (payload as Record<string, unknown>).courtTicketNumbers,
    );
    if (projected !== undefined) return projected;
  }
  return undefined;
}

/** Routing boolean over the child's own typed sequence — does not pick or rewrite a sole row. */
function courtDiaristEscalated(roleOutcome: TerminalRoleOutcome | undefined): boolean {
  if (roleOutcome === undefined) return false;
  if (roleOutcome.kind === "audit_escalation") return true;
  if (roleOutcome.kind !== "accepted") return false;
  return (roleOutcome.payloads ?? []).some((payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    return record.status === "escalate" || record.countersignStatus === "escalate";
  });
}

/**
 * Invoke public 起居郎 under the court-pipeline quiet face.
 * Returns typed identity: ticket assertion, true-unbound, or escalate.
 * Non-zero exit without escalate status is not rethrown here — caller decides
 * whether refresh must fail or first-entry settles controlled failure.
 * When `boundTicketNumber` is set (typed handoff from countersign), diarist
 * binds under that key before the turn — never mechanical recognition from prose.
 */
async function invokeCourtDiarist(input: {
  readonly instruction: string;
  readonly projectRoot: string;
  readonly failureLabel: string;
  /** Already-verified typed key from countersign (refresh / post-assert handoff). */
  readonly boundTicketNumber?: number;
}, env: CountersignRunEnv, io: CliIo): Promise<CourtDiaristInvocationResult> {
  // Quiet face: the countersign caller must not see diarist CLI chatter.
  const quietIo: CliIo = {
    stdout() {},
    stderr(text: string) {
      // Surface nested failures onto the parent stderr only; no success noise.
      if (text.trim() !== "") io.stderr(text);
    },
  };

  const { summonPublicRole } = await import("../public-role-summons.ts");
  const result = await summonPublicRole({
    role: "diarist",
    argv: ["--project", input.projectRoot, input.instruction],
    cwd: env.cwd,
    home: env.home,
    agentDir: env.agentDir,
    packageRoot: env.packageRoot,
    io: quietIo,
    ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
    ...(env.signal === undefined ? {} : { signal: env.signal }),
    ...(input.boundTicketNumber === undefined
      ? {}
      : { boundTicketNumber: input.boundTicketNumber }),
    // Child seat selects from the composition-root table. Do not pass the
    // already-selected parent adapter (#840 / ADR 0082 host-flag-two-channels).
    ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
  });

  const roleOutcome = result.terminal?.roleOutcome;
  // Escalate routing is a boolean over the preserved sequence (#881). Reasons and
  // payload bodies stay on roleOutcome — never rewritten into a sole identity reason.
  if (courtDiaristEscalated(roleOutcome)) {
    return {
      identity: { kind: "escalate" },
    };
  }

  if (result.exitCode !== 0) {
    const diagnostic =
      roleOutcome?.kind === "failure"
        ? roleOutcome.diagnostic
        : result.stderr?.trim() || `exit ${result.exitCode}`;
    return {
      identity: { kind: "unbound" },
      failedWithoutEscalate: {
        diagnostic: `court diarist station failed for ${input.failureLabel}: ${diagnostic}`,
      },
    };
  }

  const asserted = (result.admitted as { ticketNumber?: number } | undefined)?.ticketNumber;
  if (
    typeof asserted === "number" &&
    Number.isSafeInteger(asserted) &&
    asserted >= 1
  ) {
    const courtTicketNumbers = courtTicketNumbersFromOutcome(roleOutcome);
    return {
      identity: {
        kind: "ticket",
        ticketNumber: asserted,
        ...(courtTicketNumbers === undefined ? {} : { courtTicketNumbers }),
      },
    };
  }
  return {
    identity: { kind: "unbound" },
  };
}

/**
 * Court-pipeline prior station: refresh this ticket's 起居录 before the
 * countersign body turn when already bound (ADR 0075 `refresh-every-court`).
 * Caller-invisible — no diarist argv on the countersign command line.
 *
 * Missing ticketNumber (true-unbound / identity deferred) skips the refresh
 * station — no diary is minted for a true-unbound run. First-entry identity
 * lives on `runPublicCountersign` (typed 起居郎 key for bind + same-ticket
 * resume). Bound refresh: 起居郎 failure propagates (失败诚实).
 * Path delivery onto materials is not this station's job — post-admission owns it.
 */
export async function runCountersignCourtDiaristStation(
  admitted: AdmittedCountersignInvocation,
  env: CountersignRunEnv,
  io: CliIo,
): Promise<void> {
  if (env.runCourtDiaristStation !== undefined) {
    await env.runCourtDiaristStation(admitted);
    return;
  }
  // Production refresh-every-court only under a known ticket identity.
  // First-entry unbound identity is owned by runPublicCountersign.
  if (admitted.ticketNumber === undefined) return;

  // #871: refresh every member of the typed co-review set; single-ticket face
  // is just the set [main]. Never silently fall back to main-only after a set.
  const refreshTickets =
    admitted.courtTicketNumbers !== undefined && admitted.courtTicketNumbers.length > 0
      ? admitted.courtTicketNumbers
      : [admitted.ticketNumber];

  for (const ticketNumber of refreshTickets) {
    const outcome = await invokeCourtDiarist(
      {
        instruction: `整理 #${ticketNumber} 的本案依据。`,
        projectRoot: admitted.projectRoot,
        failureLabel: `ticket #${ticketNumber}`,
        // Refresh holds a typed key — hand it off so identity is bound before turn.
        boundTicketNumber: ticketNumber,
      },
      env,
      io,
    );

    if (outcome.identity.kind === "escalate") {
      throw new StationChildExhaustedError(
        "court diarist station escalated (cannot identify court target)",
      );
    }
    if (outcome.failedWithoutEscalate !== undefined) {
      throw new StationChildExhaustedError(outcome.failedWithoutEscalate.diagnostic);
    }
  }
}

export async function runPublicCountersign(
  argv: readonly string[],
  env: CountersignRunEnv,
  io: CliIo,
  parseCountersignArgv: (args: readonly string[]) => ParseCountersignArgvResult,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCountersignInvocation;
  terminal?: TerminalResult;
}> {
  let parsed: ParseCountersignArgvResult;
  try {
    parsed = parseCountersignArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  let admitted: AdmittedCountersignInvocation;
  try {
    admitted = await admitCountersignInvocation({
      home: env.home,
      principalAuthority: env.principalAuthority,
      cwd: env.cwd,
      instruction: parsed.instruction,
      attachmentPaths: parsed.attachmentPaths,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  await markRunAdmitted(admitted, env.principalAuthority);

  // #637 / #771 / ADR 0079: ticket identity is the 起居郎 LLM typed assertion
  // (never mechanical matching of summons text). Resolve that typed key after
  // admit so the countersign run page exists first; same-ticket re-summons
  // resume the prior run on the typed key (unused mint is abandoned). The test
  // seam `runCourtDiaristStation` defers identity to beforeDispatch; generic
  // hook failures stay on the parent call-local budget, exhausted nested
  // station children still skip parent auto-resume (#840 父子不层叠).
  let typedTicket: number | undefined;
  let typedCourtTicketNumbers: readonly number[] | undefined;
  let identityDiaristRan = false;

  if (env.runCourtDiaristStation === undefined) {
    const outcome = await invokeCourtDiarist(
      {
        instruction: parsed.instruction,
        projectRoot: admitted.projectRoot,
        failureLabel: "unbound summons",
      },
      env,
      io,
    );
    identityDiaristRan = true;

    if (outcome.identity.kind === "escalate") {
      // 御批: 识别不了就上抛 — settle on the admitted countersign run.
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: new Error(
            "court diarist station escalated (cannot identify court target)",
          ),
        },
        countersignAdapters(),
        env.principalAuthority,
        io,
      );
    }

    // Typed failure terminal (verification / infra / non-zero without escalate)
    // is not 真无票 — settle controlled failure on the admitted run (失败诚实).
    // Only a true missing lawful typed terminal keeps the r5 unbound-continue.
    if (outcome.failedWithoutEscalate !== undefined) {
      return await presentControlledFailure(
        admitted,
        {
          timedOut: false,
          code: null,
          stderr: "",
          thrown: new Error(outcome.failedWithoutEscalate.diagnostic),
        },
        countersignAdapters(),
        env.principalAuthority,
        io,
      );
    }

    // Missing lawful 起居郎 terminal is not countersign body failure: leave
    // unbound and continue (true-unbound face). Escalate / typed failure above;
    // bound refresh still fails honest via runCountersignCourtDiaristStation.
    if (outcome.identity.kind === "ticket") {
      const assertedTicket = outcome.identity.ticketNumber;
      typedTicket = assertedTicket;
      // #871: identity may hand a co-review set; absent field defaults to [main].
      typedCourtTicketNumbers = outcome.identity.courtTicketNumbers;
      const summons: SameTicketSummonsMaterials = {
        instruction: parsed.instruction,
        instructionEmpty: parsed.instruction.trim() === "",
        attachmentPaths: parsed.attachmentPaths,
      };
      const resumed = await tryResumeSameTicketSeatRun({
        home: env.home,
        projectRoot: admitted.projectRoot,
        role: "countersign",
        ticketNumber: typedTicket,
        freshSummons: env.freshSummons,
        summons,
        resume: async (runId, materials) => {
          // Resume selected: file the provisional run under the asserted ticket
          // before abandoning it, so typed identity never leaves an unbound row.
          await bindAdmittedTicketNumber(admitted, assertedTicket);
          await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
          await markRunTerminal(admitted.runDirectory);
          // Identity 起居郎 asserted unbound (no issue face). Resume still runs
          // the bound refresh station under the typed key (refresh-every-court).
          // #871: hand the identity set so resume can whole-replace the run fact
          // when this summons produced a new typed set (never union).
          return await runPublicCountersignResume(
            {
              runId,
              ...(materials === undefined ? {} : { summons: materials }),
            },
            {
              ...env,
              ...(typedCourtTicketNumbers === undefined
                ? {}
                : { pendingCourtTicketNumbers: typedCourtTicketNumbers }),
            },
            io,
          );
        },
      });
      if (resumed !== undefined) {
        return resumed;
      }
    }
  }

  if (identityDiaristRan && typedTicket !== undefined) {
    await bindAdmittedTicketNumber(admitted, typedTicket);
    await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
    // First court: explicit set wins; omitted field → single-ticket face [main].
    await bindCourtTicketNumbersOnAdmitted(
      admitted,
      typedCourtTicketNumbers ?? [typedTicket],
    );
  }

  const turnProjection: RoleTurnRequestProjectionOptions = {
    packageRoot: env.packageRoot,
    home: env.home,
    agentDir: env.agentDir,
    ...(env.model === undefined ? {} : { model: env.model }),
    ...pickEngineAxis(env),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(env.correlationId === undefined || env.correlationId.trim() === ""
      ? {}
      : { correlationId: env.correlationId }),
    continuation: {
      kind: "initial",
      prompt: buildCountersignTransportPrompt(
        admitted,
        engineSessionMaterialFromOptions({
          ...pickEngineAxis(env),
          packageRoot: env.packageRoot,
        }),
      ),
    },
  };
  // Mutable shell: ticket bind re-projects activation before executeTurn.
  const turnRequest = buildCountersignTurnRequest(admitted, turnProjection);

  const result = await runPostAdmissionOneShot({
    admitted,
    env,
    io,
    request: turnRequest,
    adapters: countersignAdapters({
      beforeDispatch: async (admittedSeat, lease) => {
        // Dossier pointer delivery rides post-admission after this hook (#709).
        if (!identityDiaristRan) {
          // Test seam (or any deferred identity): station owns assert + bind.
          await runCountersignCourtDiaristStation(admittedSeat, env, io);
        } else if (typedTicket !== undefined) {
          await runCountersignCourtDiaristStation(admittedSeat, env, io);
        }
        await relocateAdmittedRunToTicket(
          admittedSeat,
          env.principalAuthority,
          lease,
        );
        Object.assign(
          turnRequest,
          buildCountersignTurnRequest(admittedSeat, turnProjection),
        );
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
  await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
  return result;
}

function countersignAdapters(options?: {
  beforeDispatch?: (
    admitted: AdmittedCountersignInvocation,
    lease: RunWriterLease,
  ) => void | Promise<void>;
}) {
  return {
    trySettle: (
      admitted: AdmittedCountersignInvocation,
      authority: DurablePrincipalAuthority,
      scope?: { readonly courtAttemptId?: string },
    ) => trySettleCountersignTerminalResult(admitted, authority, scope),
    // Accepted receipts and failure terminals both present via shared path.
    shouldPresentSettled: () => true,
    ...(options?.beforeDispatch === undefined
      ? {}
      : { beforeDispatch: options.beforeDispatch }),
  };
}

/**
 * Resume a previously admitted Countersign run (#599 / DK-3 / #637).
 * Restores role/ticket/session identity. Bound court re-entry runs the diarist
 * refresh station first (ADR 0075 `refresh-every-court`); unbound skips refresh.
 * Same-ticket summons deliver this turn's instruction + frozen attachments on
 * the resume prompt; manual resume keeps package-envelope / caller-message
 * semantics and birth attachments. 起居录 path delivery remains post-admission's
 * single mount (#709).
 */
export async function runPublicCountersignResume(
  request: PublicResumeRequest,
  env: CountersignRunEnv,
  io: CliIo,
): Promise<{
  exitCode: number;
  admitted?: AdmittedCountersignInvocation;
  terminal?: TerminalResult;
}> {
  return await runPostAdmissionSeatResume({
    request,
    env,
    io,
    load: (effective) =>
      loadResumableCountersignRun(
        env.home,
        effective.runId,
        env.principalAuthority,
      ),
    buildTurnRequest: async (admitted, effective) => {
      const summonsPrepared = await prepareSummonsResumeMaterials(
        admitted.runDirectory,
        effective.summons,
      );
      return buildCountersignTurnRequest(
        admitted,
        resumeTurnRequestProjectionOptions(
          admitted,
          effective,
          env,
          summonsPrepared,
        ),
      );
    },
    adapters: countersignAdapters({
      beforeDispatch: async (admitted) => {
        // #871: same-ticket re-summons may hand a fresh typed set from identity.
        // Whole-set replace onto this run fact; no new set → keep stored set.
        // Manual resume (no pending) keeps the durable set and never invents one.
        if (env.pendingCourtTicketNumbers !== undefined) {
          await bindCourtTicketNumbersOnAdmitted(
            admitted,
            env.pendingCourtTicketNumbers,
          );
        }
        await runCountersignCourtDiaristStation(admitted, env, io);
      },
    }),
    ...(env.engine === undefined ? {} : { effectiveEngine: env.engine }),
  });
}
