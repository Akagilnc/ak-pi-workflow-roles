/**
 * Court diarist station for the shared countersign entry (#572 / ADR 0074 /
 * ADR 0075 / #742 / #771). The public seat itself admits and settles through
 * instruction-seat-run. This module only summons 起居郎 and refreshes a bound
 * court diary.
 *
 * Court admission auto-runs 起居郎 so the 起居郎 LLM asserts the court target;
 * mechanical layer only verifies; countersign reuses that typed identity for bind
 * (ADR 0075 / 0081). Code never matches instruction text against book-known
 * numbers. Who may call 起居郎 and in what order is not written into law
 * (ADR 0075 不规定谁调用起居郎、顺序归调用者). 起居录 path delivery is owned once by
 * post-admission (#709 / ADR 0081). Bound refresh hands the typed key to 起居郎
 * so freeze loads issue face (ADR 0075: 每次过庭都跑是调用者用法 / typed handoff).
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { projectCourtTicketNumbers } from "../diarist-contracts.ts";
import { readableGateItem } from "../readable-gate-item.ts";
import { isSafePositiveTicketNumber } from "../run-ticket-number.ts";
import type { AdmittedCountersignInvocation } from "./invocation.ts";
import {
  type PostAdmissionEnv,
  StationChildExhaustedError,
} from "./post-admission.ts";
import type { CliIo } from "./cli-io.ts";
import type { TerminalRoleOutcome } from "./terminal.ts";

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
   * Absent on an ordinary public summons, which always mints.
   */
  parentRunPath?: string;
};

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
  readonly admitted?: import("./invocation.ts").AdmittedRoleInvocation;
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
      ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
    };
  }

  if (result.exitCode !== 0) {
    const diagnostic =
      roleOutcome?.kind === "failure"
        ? roleOutcome.diagnostic
        : result.stderr?.trim() || `exit ${result.exitCode}`;
    return {
      identity: { kind: "unbound" },
      ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
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
      ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
    };
  }
  return {
    identity: { kind: "unbound" },
    ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
  };
}

/**
 * Court-pipeline prior station: refresh this ticket's 起居录 before the
 * countersign body turn when already bound (ADR 0075 每次过庭都跑)。
 * Caller-invisible — no diarist argv on the countersign command line.
 *
 * Missing ticketNumber (true-unbound / identity deferred) skips the refresh
 * station — no diary is minted for a true-unbound run. First-entry identity
 * lives on the shared countersign entry (typed 起居郎 key for bind). Bound refresh:
 * 起居郎 failure propagates (失败诚实).
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
  // First-entry unbound identity is owned by the shared countersign entry.
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
