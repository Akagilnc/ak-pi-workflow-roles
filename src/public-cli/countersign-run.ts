/**
 * Secretariat's pre-ticket diarist summons. Countersign no longer summons
 * the diarist; callers refresh the diary before court when needed (ADR 0081).
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { readableGateItem } from "../readable-gate-item.ts";
import type { AdmittedCountersignInvocation } from "./invocation.ts";
import type { PostAdmissionEnv } from "./post-admission.ts";
import type { CliIo } from "./cli-io.ts";
import { currentReplyRows, type TerminalResult, type TerminalRoleOutcome } from "./terminal.ts";

export type CountersignRunEnv = PostAdmissionEnv & {
  principalAuthority: DurablePrincipalAuthority;
  createRunId?: () => string;
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
   * #969 / #987 gate path: parent run durable board ticket handoff for bind.
   * Same-ticket resume lookup narrows the parent path by this typed number.
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
  | { readonly kind: "unbound" }
  | {
      readonly kind: "escalate";
      /** Honest diagnostic from diarist escalate payload (#953) — never invent 认不出. */
      readonly diagnostic: string;
    };

export type CourtDiaristInvocationResult = {
  readonly identity: CourtDiaristIdentity;
  readonly admitted?: import("./invocation.ts").AdmittedRoleInvocation;
  readonly terminal?: import("./terminal.ts").TerminalResult;
  readonly failedWithoutEscalate?: { readonly diagnostic: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEscalatePayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return (
    payload.status === "escalate"
  );
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
  terminal: TerminalResult | undefined,
): string {
  const payloads = currentReplyRows(terminal);
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

/** Env slice for the secretariat's pre-ticket diarist summons. */
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

/** Latest payload only. An earlier escalate must not block a later non-escalate submission. */
export function latestPayloadEscalated(
  roleOutcome: TerminalRoleOutcome | undefined,
): boolean {
  if (roleOutcome === undefined) return false;
  if (roleOutcome.kind === "audit_escalation") return true;
  if (roleOutcome.kind !== "accepted") return false;
  const payloads = roleOutcome.payloads ?? [];
  return isEscalatePayload(payloads[payloads.length - 1]);
}

/**
 * Invoke public 起居郎 under the court-pipeline quiet face.
 * Returns escalate or unbound; the secretariat needs no ticket handoff.
 * Non-zero exit without escalate status is not rethrown here — caller settles controlled failure.
 */
export async function invokeCourtDiarist(
  input: {
    readonly instruction: string;
    readonly projectRoot: string;
    readonly failureLabel: string;
    readonly attachmentPaths?: readonly string[];
    /** Direct parent run id for durable child lineage (ADR 0010). */
    readonly correlationId?: string;
  },
  env: CourtDiaristSummonEnv,
  io: CliIo,
): Promise<CourtDiaristInvocationResult> {
  // Quiet face: the secretariat caller must not see diarist CLI chatter.
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
    // Child seat selects from the composition-root table. Do not pass the
    // already-selected parent adapter (#840 / ADR 0082: --host 旗标>席位配置>缺省 pi).
    ...(env.hostAdapters === undefined
      ? {}
      : { hostAdapters: env.hostAdapters }),
  });

  const roleOutcome = result.terminal?.roleOutcome;
  // Escalate routing is a boolean over the preserved sequence (#881). Reasons and
  // payload bodies stay on roleOutcome — never rewritten into a sole identity reason.
  if (latestPayloadEscalated(roleOutcome)) {
    return {
      identity: {
        kind: "escalate",
        diagnostic: courtDiaristEscalateDiagnostic(result.terminal),
      },
      ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
      ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
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

  return {
    identity: { kind: "unbound" },
    ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
  };
}
