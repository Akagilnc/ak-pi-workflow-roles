/**
 * Public Countersign Role run: admit ticket materials → court-pipeline prior
 * station (起居郎) → shared post-admission coordinator → settle Terminal result
 * (#572 / ADR 0074 / ADR 0075 / #742 / #771). #599: manual resume continues the
 * exact session via explicit package runId. #987 Result 7: public entry no longer
 * selects a prior run by ticket number; gate same-parent re-summons keep
 * parentRunPath resume (#747 / ADR 0079 gate face). Explicit `ak-role new` mints
 * fresh; explicit `ak-role resume <runId>` continues a named run.
 *
 * Court admission auto-runs 起居郎 so the 起居郎 LLM asserts the court target;
 * mechanical layer only verifies; countersign reuses that typed identity for bind
 * (ADR 0075 / 0081). Code never matches instruction text against book-known
 * numbers. Who may call 起居郎 and in what order is not written into law
 * (ADR 0075 不规定谁调用起居郎、顺序归调用者); the present admission effect is what this
 * seat currently does. 起居录 path delivery is owned once by post-admission
 * (#709 / ADR 0081). Court refresh may run on resume; it is not a resume
 * precondition and does not rewrite or reject host resume (#987).
 *
 * Wiring (#771 / #863 / #987): gate parentRunPath resume (when present) runs
 * before identity mint; public path without parentRunPath always materializes a
 * new run after identity. 起居郎 escalate (认不出) and typed failure terminals
 * (incl. verification failure) settle as countersign controlled failure — never
 * wash into 真无票. Only a true missing lawful typed terminal stays unbound and
 * continues the body (r5 unbound-continue). Bound refresh hands the typed key to
 * 起居郎 so freeze loads issue face (ADR 0075: 每次过庭都跑是调用者用法 / typed handoff).
 */
import type {
  DurablePrincipalAuthority,
  RoleTurnRequest,
} from "../host-contracts.ts";
import {
  engineSessionMaterialFromOptions,
  pickEngineAxis,
} from "../package-resources/engine-material.ts";
import { CliUsageError } from "./cli-errors.ts";
import { projectCourtTicketNumbers } from "../diarist-contracts.ts";
import { readableGateItem } from "../readable-gate-item.ts";
import { isSafePositiveTicketNumber } from "../run-ticket-number.ts";
import {
  admitCountersignInvocation,
  bindAdmittedTicketNumber,
  bindCourtTicketNumbersOnAdmitted,
  buildCountersignTransportPrompt,
  materializeCountersignInvocation,
  persistAdmittedSourceRunPath,
  relocateAdmittedRunToTicket,
  withPreparedAttachments,
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
   * #871: typed co-review set applied onto a resumed run before bound refresh
   * (gate / explicit resume handoff). Whole-set replace — never union.
   * Production leaves unset outside that handoff.
   */
  pendingCourtTicketNumbers?: readonly number[];
  /**
   * #969 gate path: plain-language re-ask when prior 给事中 reply was not three-state.
   * Wins over gateReviewInstruction when both present (notary/inspector precedent).
   */
  reviewReask?: string;
  /**
   * #969/#879 Secretariat submission-gate body: verbatim parent payload as dialogue
   * content when reviewReask is absent. Binding stays ticket / argv instruction.
   */
  gateReviewInstruction?: string;
  /**
   * #969 / #987 gate path: parent run durable board ticket handoff for bind only.
   * Resume lookup uses parentRunPath — never this ticket number (#987 Result 7).
   */
  boundTicketNumber?: number;
  /**
   * #747 / #987 gate same-parent resume key (Secretariat source run directory).
   * When set, re-summons resume the prior 给事中 under this parent before mint.
   */
  parentRunPath?: string;
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
export type CourtDiaristIdentity =
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
  | {
      readonly kind: "escalate";
      /** Honest diagnostic from diarist escalate payload (#953) — never invent 认不出. */
      readonly diagnostic: string;
    };

export type CourtDiaristInvocationResult = {
  readonly identity: CourtDiaristIdentity;
  readonly failedWithoutEscalate?: { readonly diagnostic: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEscalatePayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return (
    payload.status === "escalate" || payload.countersignStatus === "escalate"
  );
}

/**
 * Rows a parent may read from a nested diarist terminal (#836 / #953).
 * Accepted/audit use role result payloads; failure history is submissions only.
 */
function courtDiaristPayloadRows(
  roleOutcome: TerminalRoleOutcome | undefined,
  submissions: readonly unknown[] | undefined,
): readonly unknown[] {
  if (roleOutcome === undefined) return submissions ?? [];
  if (roleOutcome.kind === "accepted" || roleOutcome.kind === "audit_escalation") {
    return roleOutcome.payloads ?? [];
  }
  if (roleOutcome.kind === "failure") return submissions ?? [];
  return [];
}

/**
 * Parent diagnostic for court-diarist escalate (#953 / 失败诚实 / 传话).
 * Relays diarist escalate payload(s) via readableGateItem — never invents
 * "cannot identify court target" when a payload already carries other facts
 * (e.g. ticketNumber present with a different reason).
 *
 * Multiple escalate payloads remain reachable after the run (ADR 0003/0041;
 * no courtAttempt sole-filter on diarist). Same law as secretariat parent face:
 * every escalate receipt as-is, last = currentConclusion.
 */
function courtDiaristEscalateDiagnostic(
  roleOutcome: TerminalRoleOutcome | undefined,
  submissions?: readonly unknown[],
): string {
  const payloads = courtDiaristPayloadRows(roleOutcome, submissions);
  const escalatePayloads: unknown[] = [];
  for (const payload of payloads) {
    if (isEscalatePayload(payload)) escalatePayloads.push(payload);
  }
  if (escalatePayloads.length === 0) return "court diarist station escalated";
  // Single escalate: prior carrier (payload body only) — no shape churn.
  if (escalatePayloads.length === 1) {
    return `court diarist station escalated: ${readableGateItem(escalatePayloads[0])}`;
  }
  return `court diarist station escalated: ${readableGateItem({
    receipts: escalatePayloads,
    currentConclusion: escalatePayloads[escalatePayloads.length - 1],
  })}`;
}

/** Env slice shared by court diarist identity summons (countersign / secretariat). */
export type CourtDiaristSummonEnv = Pick<
  CountersignRunEnv,
  | "cwd"
  | "home"
  | "agentDir"
  | "packageRoot"
  | "credentials"
  | "signal"
  | "hostAdapters"
>;

/**
 * Read #871 set from preserved diarist payloads.
 * - Field absent / null / non-array → undefined (no new set; resume keeps store).
 * - Explicit [] → single-ticket [main] whole-set replace (signed empty-set contract).
 * - Non-empty array with zero lawful typed members after projection → not a new set
 *   (do not impersonate explicit empty and wipe a stored multi-ticket fact).
 * - Non-empty array with ≥1 lawful member → sole type/dedupe projection + principal guarantee.
 * - Multiple submissions: last qualifying set wins.
 * Live path never shape-rejects the role turn; durable damage is a separate seam.
 */
function courtTicketNumbersFromOutcome(
  roleOutcome: TerminalRoleOutcome | undefined,
  principalTicket: number,
  submissions?: readonly unknown[],
): readonly number[] | undefined {
  if (roleOutcome === undefined) return undefined;
  const payloads = courtDiaristPayloadRows(roleOutcome, submissions);
  let latest: readonly number[] | undefined;
  for (const payload of payloads) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (!Object.hasOwn(record, "courtTicketNumbers")) continue;
    const raw = record.courtTicketNumbers;
    // Only a real array is a candidate set. Non-array is not explicit empty.
    if (!Array.isArray(raw)) continue;
    // Members only — do not inject principal yet, or all-invalid non-empty becomes [main].
    const members = projectCourtTicketNumbers(raw);
    if (members === null) continue;
    if (members.length === 0) {
      // Literal [] is the intentional principal-only replace; non-empty garbage is not.
      if (raw.length === 0) {
        latest =
          projectCourtTicketNumbers([], { principalTicket }) ?? undefined;
      }
      continue;
    }
    latest = projectCourtTicketNumbers(raw, { principalTicket }) ?? undefined;
  }
  return latest;
}

/** Routing boolean over the child's own typed sequence — does not pick or rewrite a sole row. */
function courtDiaristEscalated(
  roleOutcome: TerminalRoleOutcome | undefined,
): boolean {
  if (roleOutcome === undefined) return false;
  if (roleOutcome.kind === "audit_escalation") return true;
  if (roleOutcome.kind !== "accepted") return false;
  return (roleOutcome.payloads ?? []).some(isEscalatePayload);
}

/**
 * Invoke public 起居郎 under the court-pipeline quiet face.
 * Returns typed identity: ticket assertion, true-unbound, or escalate.
 * Non-zero exit without escalate status is not rethrown here — caller decides
 * whether refresh must fail or first-entry settles controlled failure.
 * When `boundTicketNumber` is set (typed handoff from countersign), diarist
 * binds under that key before the turn — never mechanical recognition from prose.
 */
export async function invokeCourtDiarist(
  input: {
    readonly instruction: string;
    readonly projectRoot: string;
    readonly failureLabel: string;
    readonly attachmentPaths?: readonly string[];
    /** Direct parent run id for durable child lineage (ADR 0010). */
    readonly correlationId?: string;
    /** Already-verified typed key from countersign (refresh / post-assert handoff). */
    readonly boundTicketNumber?: number;
  },
  env: CourtDiaristSummonEnv,
  io: CliIo,
): Promise<CourtDiaristInvocationResult> {
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
    argv: [
      "--project",
      input.projectRoot,
      ...(input.attachmentPaths ?? []).flatMap((path) => ["--attach", path]),
      "--",
      input.instruction,
    ],
    cwd: env.cwd,
    home: env.home,
    agentDir: env.agentDir,
    packageRoot: env.packageRoot,
    io: quietIo,
    ...(env.credentials === undefined ? {} : { credentials: env.credentials }),
    ...(env.signal === undefined ? {} : { signal: env.signal }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    ...(input.boundTicketNumber === undefined
      ? {}
      : { boundTicketNumber: input.boundTicketNumber }),
    // Child seat selects from the composition-root table. Do not pass the
    // already-selected parent adapter (#840 / ADR 0082: --host 旗标>席位配置>缺省 pi).
    ...(env.hostAdapters === undefined
      ? {}
      : { hostAdapters: env.hostAdapters }),
  });

  const roleOutcome = result.terminal?.roleOutcome;
  const submissions = result.terminal?.submissions;
  // Escalate routing is a boolean over the preserved sequence (#881). Reasons and
  // payload bodies stay on roleOutcome — never rewritten into a sole identity reason.
  if (courtDiaristEscalated(roleOutcome)) {
    return {
      identity: {
        kind: "escalate",
        diagnostic: courtDiaristEscalateDiagnostic(roleOutcome, submissions),
      },
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

  const asserted = (result.admitted as { ticketNumber?: number } | undefined)
    ?.ticketNumber;
  if (isSafePositiveTicketNumber(asserted)) {
    const courtTicketNumbers = courtTicketNumbersFromOutcome(
      roleOutcome,
      asserted,
      submissions,
    );
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
 * countersign body turn when already bound (ADR 0075 每次过庭都跑)。
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
  // Production court refresh (ADR 0075: 每次过庭都跑是调用者用法) only under a known ticket identity.
  // First-entry unbound identity is owned by runPublicCountersign.
  if (admitted.ticketNumber === undefined) return;

  // #871: refresh every member of the typed co-review set; single-ticket face
  // is just the set [main]. Present-but-empty / missing-principal is damage —
  // never silently fall back to main-only (legacy absent field still may).
  let refreshTickets: readonly number[];
  if (admitted.courtTicketNumbers !== undefined) {
    if (
      admitted.courtTicketNumbers.length === 0 ||
      !admitted.courtTicketNumbers.includes(admitted.ticketNumber)
    ) {
      throw new StationChildExhaustedError(
        `court diarist station: courtTicketNumbers is damaged (empty or missing principal #${admitted.ticketNumber})`,
      );
    }
    refreshTickets = admitted.courtTicketNumbers;
  } else {
    refreshTickets = [admitted.ticketNumber];
  }

  for (const ticketNumber of refreshTickets) {
    const outcome = await invokeCourtDiarist(
      {
        instruction: `整理 #${ticketNumber} 的本案依据。`,
        projectRoot: admitted.projectRoot,
        failureLabel: `ticket #${ticketNumber}`,
        correlationId: admitted.runId,
        // Refresh holds a typed key — hand it off so identity is bound before turn.
        boundTicketNumber: ticketNumber,
      },
      env,
      io,
    );

    if (outcome.identity.kind === "escalate") {
      throw new StationChildExhaustedError(outcome.identity.diagnostic);
    }
    if (outcome.failedWithoutEscalate !== undefined) {
      throw new StationChildExhaustedError(
        outcome.failedWithoutEscalate.diagnostic,
      );
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
      ...(env.createRunId === undefined
        ? {}
        : { createRunId: env.createRunId }),
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.correlationId === undefined
        ? {}
        : { correlationId: env.correlationId }),
      deferPersistence: true,
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }

  // One owner spans prepare, lookup/load/resume or new-run materialization.
  // It preserves both causes when its final cleanup also fails.
  try {
    return await withPreparedAttachments(
      parsed.attachmentPaths,
      async (preparedAttachments) => {
        const materializeAdmission = async (): Promise<void> => {
          await materializeCountersignInvocation(admitted, {
            home: env.home,
            principalAuthority: env.principalAuthority,
            preparedAttachments,
            ...(env.model === undefined ? {} : { model: env.model }),
          });
        };

        // #747 / #987: gate same-parent resume before identity mint. Public entry
        // without parentRunPath never selects a prior run by ticket number.
        const gateParentRunPath =
          typeof env.parentRunPath === "string" && env.parentRunPath.trim() !== ""
            ? env.parentRunPath
            : undefined;
        if (gateParentRunPath !== undefined) {
          const resumeInstruction =
            env.reviewReask ?? env.gateReviewInstruction ?? parsed.instruction;
          const summons: SameTicketSummonsMaterials = {
            sourceRunPath: gateParentRunPath,
            instruction: resumeInstruction,
            instructionEmpty: resumeInstruction.trim() === "",
          };
          const resumed = await tryResumeSameTicketSeatRun({
            home: env.home,
            projectRoot: admitted.projectRoot,
            role: "countersign",
            parentRunPath: gateParentRunPath,
            freshSummons: env.freshSummons,
            summons,
            resume: (runId, materials) =>
              runPublicCountersignResume(
                {
                  runId,
                  ...(materials === undefined ? {} : { summons: materials }),
                },
                env,
                io,
              ),
          });
          if (resumed !== undefined) {
            return resumed;
          }
        }

        // #637 / #771: ticket identity is the 起居郎 LLM typed assertion (never
        // mechanical matching of summons text). Resolve that typed key before
        // materializing a first-mint run. Controlled failures materialize below so
        // they still have a durable page. The test seam `runCourtDiaristStation`
        // defers identity to beforeDispatch; generic hook failures stay on the
        // parent call-local budget, exhausted nested station children still skip
        // parent auto-resume (#840 父子不层叠).
        let typedTicket: number | undefined;
        let typedCourtTicketNumbers: readonly number[] | undefined;
        let identityDiaristRan = false;

        if (env.runCourtDiaristStation === undefined) {
          let outcome: CourtDiaristInvocationResult;
          try {
            outcome = await invokeCourtDiarist(
              {
                instruction: parsed.instruction,
                projectRoot: admitted.projectRoot,
                failureLabel: "unbound summons",
                // #969: parent durable ticket is the bind key (not a resume lookup).
                ...(env.boundTicketNumber === undefined
                  ? {}
                  : { boundTicketNumber: env.boundTicketNumber }),
              },
              env,
              io,
            );
          } catch (error) {
            await materializeAdmission();
            await markRunAdmitted(admitted, env.principalAuthority);
            return await presentControlledFailure(
              admitted,
              { timedOut: false, code: null, stderr: "", thrown: error },
              countersignAdapters(),
              env.principalAuthority,
              io,
            );
          }
          identityDiaristRan = true;

          if (outcome.identity.kind === "escalate") {
            // 御批: 识别不了就上抛 — materialize and settle this countersign run.
            // Diagnostic relays diarist escalate payload facts (#953).
            await materializeAdmission();
            await markRunAdmitted(admitted, env.principalAuthority);
            return await presentControlledFailure(
              admitted,
              {
                timedOut: false,
                code: null,
                stderr: "",
                thrown: new Error(outcome.identity.diagnostic),
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
            await materializeAdmission();
            await markRunAdmitted(admitted, env.principalAuthority);
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
          // unbound and continue (true-unbound face) — unless parent gate handoff
          // already carries the durable board ticket (#969). Escalate / typed
          // failure above; bound refresh still fails honest via station.
          if (outcome.identity.kind === "ticket") {
            // #969: parent durable handoff wins over 起居郎 re-assert when both
            // present (receipt/assert mismatch → parent bind key).
            typedTicket = isSafePositiveTicketNumber(env.boundTicketNumber)
              ? env.boundTicketNumber
              : outcome.identity.ticketNumber;
            // #871: identity may hand a co-review set; absent field defaults to [main].
            typedCourtTicketNumbers = outcome.identity.courtTicketNumbers;
          } else if (isSafePositiveTicketNumber(env.boundTicketNumber)) {
            // Parent board handoff present; 起居郎 returned true-unbound — still
            // bind under the parent key (omitted receipt ticketNumber path).
            typedTicket = env.boundTicketNumber;
          }
        }

        // No prior same-parent run was selected. Materialize this invocation now;
        // true-unbound, first-ticket and deferred test-seam paths all retain their
        // own durable page. Public re-summons without parentRunPath always mint.
        await materializeAdmission();
        await markRunAdmitted(admitted, env.principalAuthority);

        if (gateParentRunPath !== undefined) {
          await persistAdmittedSourceRunPath(admitted, gateParentRunPath);
          admitted = { ...admitted, sourceRunPath: gateParentRunPath };
        }

        if (identityDiaristRan && typedTicket !== undefined) {
          try {
            await bindAdmittedTicketNumber(admitted, typedTicket);
            await relocateAdmittedRunToTicket(admitted, env.principalAuthority);
            // First court: explicit set wins; omitted field → single-ticket face [main].
            // Set persistence is outside beforeDispatch — route write failures into the
            // same controlled-failure settlement as station children (#871 B7).
            await bindCourtTicketNumbersOnAdmitted(
              admitted,
              typedCourtTicketNumbers ?? [typedTicket],
            );
          } catch (error) {
            return await presentControlledFailure(
              admitted,
              {
                timedOut: false,
                code: null,
                stderr: "",
                thrown: error,
              },
              countersignAdapters(),
              env.principalAuthority,
              io,
            );
          }
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
            // #969/#879: gate path first mint carries parent payload as dialogue content;
            // ordinary public entry keeps package transport prompt.
            prompt: (env.reviewReask ?? env.gateReviewInstruction)
              ?? buildCountersignTransportPrompt(
                admitted,
                engineSessionMaterialFromOptions({
                  ...pickEngineAxis(env),
                  packageRoot: env.packageRoot,
                }),
              ),
          },
        };
        // Mutable shell: ticket bind re-projects activation before executeTurn.
        const turnRequest = buildCountersignTurnRequest(
          admitted,
          turnProjection,
        );

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
      },
    );
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
}

function countersignAdapters(options?: {
  beforeDispatch?: (
    admitted: AdmittedCountersignInvocation,
    lease?: RunWriterLease,
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
 * Resume a previously admitted Countersign run (#599 / DK-3 / #637 / #987).
 * Restores role/ticket/session identity. Bound court re-entry runs the diarist
 * refresh station (ADR 0075 每次过庭都跑); unbound skips refresh. Refresh is
 * not a resume precondition and does not rewrite host resume (#987). Gate
 * same-parent and explicit `ak-role resume <runId>` share this entry; summons
 * may carry this turn's instruction. Manual resume keeps package-envelope /
 * caller-message semantics and birth attachments. 起居录 path delivery remains
 * post-admission's single mount (#709).
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
        // #871 B7: durable set damage already identified at load — settle as
        // station-child exhausted → presentControlledFailure (not structural exit 2).
        if (admitted.courtTicketNumbersDamage !== undefined) {
          throw new StationChildExhaustedError(
            admitted.courtTicketNumbersDamage,
          );
        }
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
