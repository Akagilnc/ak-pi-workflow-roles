/**
 * Secretariat's pre-ticket diarist summons. Countersign no longer summons
 * the diarist; callers refresh the diary before court when needed (ADR 0081).
 */
import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import type { AdmittedCountersignInvocation } from "./invocation.ts";
import type { PostAdmissionEnv } from "./post-admission.ts";
import { discardStdout, type CliIo } from "./cli-io.ts";
import { presentSeatVolume } from "./auto-resume.ts";
import type { PublicSummonResult } from "../public-role-summons.ts";
import { returnedReceiptStatus, type TerminalReceiptRef } from "./terminal.ts";

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
  auditedReceipt?: TerminalReceiptRef;
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
export type CourtDiaristIdentity = { readonly kind: "unbound" | "escalate" };

export type CourtDiaristInvocationResult = {
  readonly identity: CourtDiaristIdentity;
  readonly admitted?: import("./invocation.ts").AdmittedRoleInvocation;
  readonly terminal?: import("./terminal.ts").TerminalResult;
  readonly failedWithoutEscalate?: { readonly diagnostic: string };
};

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
  result: PublicSummonResult,
): boolean {
  const roleOutcome = result.terminal?.roleOutcome;
  if (roleOutcome === undefined) return false;
  if (roleOutcome.kind === "audit_escalation") return true;
  if (roleOutcome.kind !== "accepted") return false;
  return returnedReceiptStatus(result, () => roleOutcome.payloads?.at(-1)) === "escalate";
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
    stdout: discardStdout,
    receiptDiagnostic: io.receiptDiagnostic ?? io.stderr,
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
  if (latestPayloadEscalated(result)) {
    return {
      identity: { kind: "escalate" },
      ...(result.admitted === undefined ? {} : { admitted: result.admitted }),
      ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
    };
  }

  await presentSeatVolume(result, io, "discarded");
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
